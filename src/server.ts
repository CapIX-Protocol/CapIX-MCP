/**
 * Capix MCP Server — the McpServer assembly + transport wiring.
 *
 * `createCapixMcpServer(client)` builds an {@link McpServer} with all 59
 * tools, the capix:// resources, and the guided prompts registered. Each tool
 * registration wires:
 *   - inputSchema  → the tool's Zod raw shape (validated by the SDK)
 *   - outputSchema → the tool's Zod raw output shape
 *   - annotations   → readOnlyHint / destructiveHint / idempotentHint derived
 *                    from the billable/requiresApproval/scope flags
 *
 * The dispatch callback enforces the Capix control-plane invariants:
 *   1. billable / requiresApproval tools refuse to run without an
 *      approvalToken (surfaced as a structured MCP error with capixCode
 *      `approval_required`). The agent must re-request with a bound token.
 *   2. read-only tools (billable=false, requiresApproval=false) auto-run.
 *   3. every billable tool's cost is the canonical quote the agent obtained
 *      upstream (no in-line price guess); the approval token binds that quote.
 *
 * Auto-discovery: when run as `capix-mcp server --stdio`, the server checks
 * for credentials in this order:
 *   1. CAPIX_API_KEY in env (set by the IDE/CLI as a session token)
 *   2. CAPIX_REFRESH_TOKEN in env -> attempt OAuth refresh via the broker
 *   3. Stored broker credentials (~/.capix/credentials.json or OS keyring)
 * If none are found, the server exits with a helpful message.
 *
 * Transports:
 *   - stdio        : StdioServerTransport, for local agent integration
 *   - streamable HTTP : StreamableHTTPServerTransport, for remote / hosted use
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { CapixClient } from "./client.js";
import { tryCreateBrokerAuthProvider } from "./client.js";
import { TOOLS, TOOL_MAP, TOOL_COUNT } from "./tools.js";
import { registerResources } from "./resources.js";
import { registerPrompts } from "./prompts.js";
import { CapixApiError } from "./types.js";
import type { ToolDef, ToolScope } from "./types.js";

/** MCP tool annotations derived from a tool's billing/approval/scope flags. */
function annotationsFor(tool: ToolDef): {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
} {
  const isDestructive =
    (tool.scope === "lifecycle" && (tool.name === "capix_delete" || tool.name === "capix_cancel")) ||
    tool.name === "capix_destroy_task_resources" ||
    tool.name === "capix_website_destroy" ||
    tool.name === "capix_website_domain_remove";
  return {
    readOnlyHint: !tool.billable && !tool.requiresApproval,
    destructiveHint: isDestructive,
    idempotentHint: !tool.billable || tool.scope === "discovery",
    openWorldHint: true,
  };
}

/**
 * Build a fully-wired McpServer. All 59 tools, resources, and prompts are
 * registered before returning; the caller just attaches a transport.
 */
export function createCapixMcpServer(
  client: CapixClient,
  opts?: { version?: string },
): McpServer {
  const server = new McpServer({
    name: "capix-mcp",
    version: opts?.version ?? "2.1.0",
  });

  // ── Tools ───────────────────────────────────────────────────────────────
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.name.replace(/^capix_/, "").replace(/_/g, " "),
        description: appendApprovalNote(tool),
        inputSchema: tool.inputShape,
        // Conditionally include outputSchema only when defined so the SDK's
        // generic inference picks the ZodRawShape overload (not the empty-
        // overload fallback) for both input and output.
        ...(tool.outputShape ? { outputSchema: tool.outputShape } : {}),
        annotations: annotationsFor(tool),
        _meta: {
          scope: tool.scope,
          billable: tool.billable,
          requiresApproval: tool.requiresApproval,
        },
      },
      async (args, extra) => {
        const actor =
          (extra as { authInfo?: { name?: string } }).authInfo?.name ?? "unknown";
        const approvalToken =
          ((args as Record<string, unknown>).approvalToken as string | undefined) ??
          (extra as { params?: { approvalToken?: string } }).params?.approvalToken;

        // ── Approval gate ──────────────────────────────────────────────────
        if ((tool.billable || tool.requiresApproval) && !approvalToken) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: `approval_required: ${tool.name} ${
                  tool.billable
                    ? "moves funds or mutates provider state"
                    : "mutates state"
                } and requires a bound approvalToken (§5). Re-request the tool call with an approvalToken obtained after the user reviewed the canonical cost.`,
              },
            ],
          };
        }

        try {
          const data = await tool.handler(args as Record<string, unknown>, {
            client,
            ctx: {
              actor,
              traceId: randomUUID(),
              approvalToken,
            },
          });
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  data,
                  (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v),
                  2,
                ),
              },
            ],
            structuredContent: data,
          };
        } catch (err) {
          return errorResult(err, tool.name);
        }
      },
    );
  }

  // ── Resources + prompts ────────────────────────────────────────────────
  registerResources(server, client);
  registerPrompts(server);

  return server;
}

/** Surface the billable/approval requirement alongside the description. */
function appendApprovalNote(tool: ToolDef): string {
  if (!tool.billable && !tool.requiresApproval) {
    return `${tool.description} [read-only — auto-runs after auth]`;
  }
  const tags: string[] = [];
  if (tool.billable) tags.push("billable");
  if (tool.requiresApproval) tags.push("requires approvalToken");
  return `${tool.description} [${tags.join(", ")}]`;
}

/** Convert a thrown error into a structured MCP error result. */
function errorResult(err: unknown, toolName: string): {
  isError: true;
  content: Array<{ type: "text"; text: string }>;
} {
  if (err instanceof CapixApiError) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            ok: false,
            error: {
              capixCode: err.capixCode,
              message: err.message,
              status: err.status,
              problem: err.problem,
            },
            tool: toolName,
          }),
        },
      ],
    };
  }
  const e = err as { capixCode?: string; message?: string; status?: number };
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          ok: false,
          error: {
            capixCode: e.capixCode ?? "tool_internal_error",
            message: e.message ?? `${toolName} threw unexpectedly`,
            status: e.status,
          },
          tool: toolName,
        }),
      },
    ],
  };
}

// ===========================================================================
// Transports
// ===========================================================================

export interface CapixServerOptions {
  version?: string;
  /** HTTP port for the streamable HTTP transport (0 = don't start HTTP). */
  httpPort?: number;
  /** Bearer service token guarding the HTTP transport (required if httpPort>0). */
  httpServiceToken?: string;
  /**
   * When true (default for stdio), the server performs auto-discovery:
   * checks CAPIX_API_KEY, then CAPIX_REFRESH_TOKEN, then the broker's
   * stored credentials before starting. If none are found, it exits.
   */
  autoDiscover?: boolean;
}

/**
 * Resolve credentials via auto-discovery. Checks (in order):
 *   1. CAPIX_API_KEY in env (session token set by the IDE/CLI)
 *   2. CAPIX_REFRESH_TOKEN in env -> refresh via the broker
 *   3. Stored broker credentials (OS keyring or ~/.capix/credentials.json)
 * Returns the resolved API key (if using env), or null if the broker
 * should be used.
 */
export async function resolveAutoDiscovery(): Promise<{
  apiKey: string | null;
  useBroker: boolean;
}> {
  // 1. Direct API key from environment (IDE/CLI sets this as a session token)
  if (process.env.CAPIX_API_KEY) {
    return { apiKey: process.env.CAPIX_API_KEY, useBroker: false };
  }

  // 2. Refresh token from environment -> use the broker to obtain an access token
  if (process.env.CAPIX_REFRESH_TOKEN) {
    return { apiKey: null, useBroker: true };
  }

  // 3. Fall back to stored broker credentials
  const broker = await tryCreateBrokerAuthProvider();
  if (broker && broker.isAuthenticated()) {
    return { apiKey: null, useBroker: true };
  }

  return { apiKey: null, useBroker: false };
}

/**
 * Start the MCP server on stdio (the default for local agent integration).
 * Performs auto-discovery: checks CAPIX_API_KEY, then CAPIX_REFRESH_TOKEN,
 * then stored broker credentials. If none are found, exits with a helpful
 * message instead of starting an unauthenticated server.
 */
export async function startStdioServer(
  client: CapixClient,
  opts?: CapixServerOptions,
): Promise<void> {
  // ── Auto-discovery: check env vars before starting ───────────────────
  // If the client is not authenticated and auto-discovery is enabled,
  // check for credentials in the standard order. If none are found, exit.
  if (opts?.autoDiscover !== false && !client.isAuthenticated()) {
    const discovery = await resolveAutoDiscovery();
    if (!discovery.apiKey && !discovery.useBroker) {
      process.stderr.write(
        "Capix MCP Server: no credentials found.\n" +
          "Auto-discovery checked:\n" +
          "  1. CAPIX_API_KEY — not set\n" +
          "  2. CAPIX_REFRESH_TOKEN — not set\n" +
          "  3. Stored OAuth credentials — not found\n" +
          "\n" +
          "Options:\n" +
          "  • Run `capix-mcp login` to authenticate via OAuth\n" +
          "  • Set CAPIX_API_KEY with a session token from capix.network\n" +
          "  • Set CAPIX_REFRESH_TOKEN (the IDE sets this automatically when signed in)\n",
      );
      process.exit(1);
    }
  }

  const server = createCapixMcpServer(client, opts);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/**
 * Start the MCP server on a streamable HTTP transport.
 *
 * The server exposes the MCP JSON-RPC endpoint at `/mcp` (POST for requests,
 * GET for SSE streams). A `/healthz` endpoint reports wired tool count. The
 * transport is stateful (session id per connection) by default.
 */
export async function startHttpServer(
  client: CapixClient,
  opts: CapixServerOptions & { httpPort: number; httpServiceToken: string },
): Promise<void> {
  const server = createCapixMcpServer(client, opts);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${opts.httpPort}`);

    // Health/readiness for orchestrators.
    if (req.method === "GET" && url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          service: "capix-mcp",
          version: opts.version ?? "2.1.0",
          tools: TOOL_COUNT,
          authenticated: client.isAuthenticated(),
        }),
      );
      return;
    }

    // All other paths flow through the MCP streamable HTTP transport.
    await transport.handleRequest(req, res);
  });

  await server.connect(transport);
  httpServer.listen(opts.httpPort);
}

// ===========================================================================
// Introspection helpers (used by the `doctor` CLI command)
// ===========================================================================

export function getToolSummary(): Array<{
  name: string;
  scope: ToolScope;
  billable: boolean;
  requiresApproval: boolean;
}> {
  return TOOLS.map((t) => ({
    name: t.name,
    scope: t.scope,
    billable: t.billable,
    requiresApproval: t.requiresApproval,
  }));
}

export function lookupTool(name: string): ToolDef | undefined {
  return TOOL_MAP.get(name);
}
