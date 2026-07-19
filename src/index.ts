#!/usr/bin/env node
/**
 * Capix MCP Server — CLI entry point.
 *
 * Commands:
 *   capix-mcp                     Start the MCP server on stdio (default).
 *   capix-mcp server              Start on stdio; use --http <port> for HTTP.
 *   capix-mcp doctor              Diagnose auth, base URL, and tool inventory.
 *   capix-mcp login               Authenticate via OAuth (PKCE browser flow).
 *   capix-mcp logout              Revoke tokens and clear stored credentials.
 *   capix-mcp --version           Print version and exit.
 *
 * Config via env:
 *   CAPIX_BASE_URL          Capix network URL (default: https://capix.network)
 *   CAPIX_API_KEY           Session token / API key (fallback when no OAuth)
 *   CAPIX_PROJECT_ID        Default project id for unscoped reads
 *   CAPIX_OAUTH_CLIENT_ID   OAuth client id (default: capix-mcp)
 *   CAPIX_MCP_HTTP_PORT     Port for the streamable HTTP transport
 *   CAPIX_MCP_HTTP_TOKEN    Bearer service token guarding the HTTP transport
 *
 * Auth strategy: the shared @capix/auth-broker is used for OAuth when it is
 * importable AND a stored refresh token exists; otherwise the server falls
 * back to the CAPIX_API_KEY env var. Run `capix-mcp login` to populate the
 * broker's credential store.
 *
 * License: Apache-2.0
 * Repo: https://github.com/CapIX-Protocol/CapIX-MCP
 */

import { createClient, tryCreateBrokerAuthProvider } from "./client.js";
import {
  DEFAULT_CAPIX_BASE_URL,
  DEFAULT_OAUTH_CLIENT_ID,
  DEFAULT_OAUTH_SCOPE,
} from "./types.js";
import {
  createCapixMcpServer,
  startStdioServer,
  startHttpServer,
  getToolSummary,
} from "./server.js";
import { TOOL_COUNT, TOOL_NAMES } from "./tools.js";
import { CAPIX_RESOURCES } from "./resources.js";
import { CAPIX_PROMPTS } from "./prompts.js";

const VERSION = "2.1.1";

// ===========================================================================
// Argument parsing
// ===========================================================================

interface CliArgs {
  command: string;
  httpPort?: number;
  httpToken?: string;
  help: boolean;
  version: boolean;
  health: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  let command = "server";
  let httpPort: number | undefined;
  let httpToken: string | undefined;
  let help = false;
  let versionFlag = false;
  let healthFlag = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--version" || arg === "-v") {
      versionFlag = true;
    } else if (arg === "--health") {
      healthFlag = true;
    } else if (arg === "--http") {
      httpPort = Number(args[++i]) || undefined;
    } else if (arg === "--http-port") {
      httpPort = Number(args[++i]) || undefined;
    } else if (arg === "--token") {
      httpToken = args[++i];
    } else if (arg?.startsWith("--http=")) {
      httpPort = Number(arg.slice("--http=".length)) || undefined;
    } else if (arg?.startsWith("--token=")) {
      httpToken = arg.slice("--token=".length);
    } else if (arg && !arg.startsWith("-")) {
      command = arg;
    }
  }

  if (!httpPort && process.env.CAPIX_MCP_HTTP_PORT) {
    httpPort = Number(process.env.CAPIX_MCP_HTTP_PORT) || undefined;
  }
  if (!httpToken) httpToken = process.env.CAPIX_MCP_HTTP_TOKEN;

  return { command, httpPort, httpToken, help, version: versionFlag, health: healthFlag };
}

const HELP = `Capix MCP Server v${VERSION}

Usage:
  capix-mcp [server] [--http <port> [--token <token>]]
  capix-mcp doctor
  capix-mcp login [--device]
  capix-mcp logout
  capix-mcp --version
  capix-mcp --health

Commands:
  (default) / server   Run the MCP server. Defaults to stdio transport.
                       With --http <port>, also starts a streamable HTTP transport.
  doctor               Diagnose auth, base URL, and list the tool inventory.
  login                Authenticate via OAuth PKCE (browser flow).
  logout               Revoke tokens and clear stored credentials.

Options:
  --http <port>        Start the streamable HTTP transport on the given port.
  --token <token>      Bearer service token guarding the HTTP transport.
  --device             Use the device-code flow instead of the browser flow.
  --health             Run a quick health check (auth, base URL, tool count) and exit.
  -h, --help           Show this help.
  -v, --version        Print version and exit.

Environment:
  CAPIX_BASE_URL         Capix network URL (default: ${DEFAULT_CAPIX_BASE_URL})
  CAPIX_API_KEY          Session token / API key (fallback when no OAuth)
  CAPIX_REFRESH_TOKEN    OAuth refresh token (auto-discovery: IDE/CLI sets this)
  CAPIX_PROJECT_ID       Default project id for unscoped reads
  CAPIX_OAUTH_CLIENT_ID  OAuth client id (default: ${DEFAULT_OAUTH_CLIENT_ID})
`;

async function main(): Promise<void> {
  const cli = parseArgs(process.argv);

  if (cli.help) {
    process.stdout.write(HELP);
    return;
  }
  if (cli.version) {
    process.stdout.write(`@capix/mcp v${VERSION}\n`);
    return;
  }
  if (cli.health) {
    await runHealth();
    return;
  }

  switch (cli.command) {
    case "doctor":
      await runDoctor();
      return;
    case "login":
      await runLogin(process.argv.includes("--device"));
      return;
    case "logout":
      await runLogout();
      return;
    case "server":
    default:
      await runServer(cli);
      return;
  }
}

// ===========================================================================
// doctor
// ===========================================================================

async function runDoctor(): Promise<void> {
  const baseUrl = process.env.CAPIX_BASE_URL ?? DEFAULT_CAPIX_BASE_URL;
  const apiKey = process.env.CAPIX_API_KEY ?? "";
  const projectId = process.env.CAPIX_PROJECT_ID;

  const out = (msg: string) => process.stdout.write(msg + "\n");

  out(`Capix MCP Server — doctor`);
  out(`  version        : ${VERSION}`);
  out(`  base URL       : ${baseUrl}`);
  out(`  project id     : ${projectId ?? "(none — set CAPIX_PROJECT_ID)"}`);

  // Auth probe.
  const broker = await tryCreateBrokerAuthProvider({ baseUrl });
  let authStatus: string;
  if (broker && broker.isAuthenticated()) {
    const acct = broker.getAccount();
    authStatus = `OAuth (@capix/auth-broker) — account ${acct?.accountId ?? "unknown"}`;
  } else if (apiKey) {
    authStatus = `API key (CAPIX_API_KEY) — ${apiKey.slice(0, 6)}…${apiKey.slice(-2)}`;
  } else if (process.env.CAPIX_REFRESH_TOKEN) {
    authStatus = "Refresh token (CAPIX_REFRESH_TOKEN — auto-discovery)";
  } else {
    authStatus = "NOT AUTHENTICATED — run `capix-mcp login` or set CAPIX_API_KEY / CAPIX_REFRESH_TOKEN";
  }
  out(`  auth           : ${authStatus}`);

  // Tool inventory.
  out(`  tools          : ${TOOL_COUNT}`);
  const byScope = new Map<string, number>();
  for (const t of getToolSummary()) {
    byScope.set(t.scope, (byScope.get(t.scope) ?? 0) + 1);
  }
  for (const [scope, count] of byScope) {
    out(`    ${scope.padEnd(12)} : ${count}`);
  }
  const billable = getToolSummary().filter((t) => t.billable).length;
  out(`  billable       : ${billable}`);
  out(`  resources      : ${CAPIX_RESOURCES.length}`);
  out(`  prompts        : ${CAPIX_PROMPTS.length}`);
  out(`  transports     : stdio, streamable-http`);
}

// ===========================================================================
// login / logout
// ===========================================================================

async function loadBroker() {
  let mod: typeof import("@capix/auth-broker") | null = null;
  try {
    mod = await import("@capix/auth-broker");
  } catch {
    return null;
  }
  if (!mod) return null;
  const baseUrl = process.env.CAPIX_BASE_URL ?? DEFAULT_CAPIX_BASE_URL;
  const clientId = process.env.CAPIX_OAUTH_CLIENT_ID ?? DEFAULT_OAUTH_CLIENT_ID;
  const scope = DEFAULT_OAUTH_SCOPE;
  const store = createBrokerStore(mod, clientId);
  const broker = new mod.AuthBroker({ baseUrl, clientId, scope }, store);
  return { broker, mod };
}

/**
 * Credential store matching the API client's selection (client.ts): the shared
 * package's platform-aware default (OS keychain → 0600 file), falling back to
 * the explicit file store on broker builds that predate
 * createDefaultCredentialStore. Login, logout, env priming and the API client
 * MUST all use the same store or credentials appear to vanish between
 * processes.
 */
function createBrokerStore(
  mod: typeof import("@capix/auth-broker"),
  clientId: string,
): import("@capix/auth-broker").CredentialStore {
  if (typeof mod.createDefaultCredentialStore === "function") {
    return mod.createDefaultCredentialStore(clientId);
  }
  return new mod.FileCredentialStore(`${process.env.HOME}/.capix/credentials.json`);
}

async function runLogin(useDevice: boolean): Promise<void> {
  const loaded = await loadBroker();
  if (!loaded) {
    process.stderr.write(
      "Login requires the @capix/auth-broker package, which is not installed.\n" +
        "Alternatively, set the CAPIX_API_KEY environment variable with a session\n" +
        "token from capix.network → sign in → DevTools → Cookies → capix_session.\n",
    );
    process.exit(1);
  }
  const { broker } = loaded;

  try {
    if (useDevice) {
      const challenge = await broker.startDeviceCodeLogin();
      process.stdout.write(
        `Open ${challenge.url} and enter code: ${challenge.userCode}\n` +
          `Waiting for authorisation (expires in ${challenge.expiresIn}s)…\n`,
      );
      const account = await broker.completeDeviceCodeLogin(challenge);
      process.stdout.write(`✓ Authenticated as ${account.accountId}.\n`);
      return;
    }

    const { authorizeUrl } = await broker.startLogin();
    process.stdout.write(`Open this URL in a browser to sign in:\n  ${authorizeUrl}\n\n`);
    tryOpenBrowser(authorizeUrl);
    process.stdout.write("Waiting for browser callback…\n");

    // Poll the broker's captured authorization code (set by its loopback server).
    const captured = await pollCapturedCode(broker);
    if (!captured) {
      process.stderr.write("Login timed out — no callback received.\n");
      process.exit(1);
    }
    const account = await broker.completeLogin(captured.code, captured.state);
    process.stdout.write(`✓ Authenticated as ${account.accountId}.\n`);
  } catch (err) {
    process.stderr.write(`Login failed: ${(err as Error).message}\n`);
    process.exit(1);
  }
}

interface BrokerWithCapture {
  capturedCode?: { code: string; state: string } | null;
}

async function pollCapturedCode(
  broker: unknown,
  timeoutMs = 120_000,
): Promise<{ code: string; state: string } | null> {
  const deadline = Date.now() + timeoutMs;
  const b = broker as BrokerWithCapture;
  while (Date.now() < deadline) {
    if (b.capturedCode) return b.capturedCode;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

function tryOpenBrowser(url: string): void {
  const platform = process.platform;
  const cmd =
    platform === "darwin"
      ? "open"
      : platform === "win32"
        ? "start"
        : "xdg-open";
  try {
    // best-effort; ignore failures.
    const { exec } = require("node:child_process");
    exec(`${cmd} "${url}"`);
  } catch {
    /* no-op */
  }
}

async function runLogout(): Promise<void> {
  const loaded = await loadBroker();
  if (!loaded) {
    process.stdout.write(
      "@capix/auth-broker not installed — nothing to revoke. " +
        "Remove CAPIX_API_KEY from your environment to clear the API-key fallback.\n",
    );
    return;
  }
  const { broker } = loaded;
  await broker.logout();
  process.stdout.write("✓ Logged out. Stored credentials cleared.\n");
}

// ===========================================================================
// server
// ===========================================================================

async function runServer(cli: CliArgs): Promise<void> {
  const baseUrl = process.env.CAPIX_BASE_URL ?? DEFAULT_CAPIX_BASE_URL;
  const log = (msg: string) => process.stderr.write(`${msg}\n`);

  // ── Auto-discovery: resolve credentials from env or broker ──────────────
  // Check order: CAPIX_API_KEY → CAPIX_REFRESH_TOKEN → stored broker creds.
  const apiKey = process.env.CAPIX_API_KEY;
  const refreshToken = process.env.CAPIX_REFRESH_TOKEN;

  // If CAPIX_REFRESH_TOKEN is set, prime the broker by storing it so
  // createClient's resolveAuthProvider can use it.
  if (!apiKey && refreshToken) {
    let brokerMod: typeof import("@capix/auth-broker") | null = null;
    try {
      brokerMod = await import("@capix/auth-broker");
    } catch {
      // broker not installed; fall through to helpful message below
    }
    if (brokerMod) {
      const clientId = process.env.CAPIX_OAUTH_CLIENT_ID ?? DEFAULT_OAUTH_CLIENT_ID;
      const scope = DEFAULT_OAUTH_SCOPE;
      const store = createBrokerStore(brokerMod, clientId);
      await store.set(clientId, "refresh-token:active", refreshToken).catch(() => {});
      const broker = new brokerMod.AuthBroker({ baseUrl, clientId, scope }, store);
      void broker.getAccessToken().catch(() => {});
    }
  }

  if (!apiKey && !refreshToken) {
    const broker = await tryCreateBrokerAuthProvider({ baseUrl });
    if (!broker || !broker.isAuthenticated()) {
      log("Capix MCP Server: no credentials found. Auto-discovery will check again at startup.");
      log("  Set CAPIX_API_KEY (session token from capix.network),");
      log("  or CAPIX_REFRESH_TOKEN (the IDE sets this when signed in),");
      log("  or run `capix-mcp login` to authenticate via OAuth.");
    }
  }

  const client = await createClient({
    baseUrl,
    apiKey: apiKey,
    projectId: process.env.CAPIX_PROJECT_ID,
    log,
  });

  if (!client.isAuthenticated()) {
    log("Warning: not authenticated. Run `capix-mcp login` or set CAPIX_API_KEY.");
    log("Alternatively, set CAPIX_REFRESH_TOKEN (the IDE sets this automatically when signed in).");
  }

  // HTTP transport (optional, alongside or instead of stdio).
  if (cli.httpPort) {
    if (!cli.httpToken) {
      log(
        "Error: --http requires --token <service-token> (or CAPIX_MCP_HTTP_TOKEN) to guard the endpoint.",
      );
      process.exit(1);
    }
    log(`Capix MCP Server (v${VERSION}) — streamable HTTP on :${cli.httpPort}`);
    await startHttpServer(client, {
      version: VERSION,
      httpPort: cli.httpPort,
      httpServiceToken: cli.httpToken,
    });
    return;
  }

  // Default: stdio transport.
  log(`Capix MCP Server (v${VERSION}) — stdio transport · ${TOOL_COUNT} tools`);
  await startStdioServer(client, { version: VERSION });
}

main().catch((error) => {
  process.stderr.write(`Fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

// ===========================================================================
// health check
// ===========================================================================

async function runHealth(): Promise<void> {
  const baseUrl = process.env.CAPIX_BASE_URL ?? DEFAULT_CAPIX_BASE_URL;
  const out = (msg: string) => process.stdout.write(msg + "\n");

  out(`{`);
  out(`  "service": "capix-mcp",`);
  out(`  "version": "${VERSION}",`);
  out(`  "baseUrl": "${baseUrl}",`);

  // Auth probe — check CAPIX_API_KEY, then CAPIX_REFRESH_TOKEN, then broker.
  const apiKey = process.env.CAPIX_API_KEY;
  const refreshToken = process.env.CAPIX_REFRESH_TOKEN;
  let authMethod = "none";
  let authenticated = false;

  if (apiKey) {
    authMethod = "api-key";
    authenticated = true;
  } else if (refreshToken) {
    authMethod = "refresh-token (auto-discovery)";
    authenticated = true;
  } else {
    const broker = await tryCreateBrokerAuthProvider({ baseUrl });
    if (broker && broker.isAuthenticated()) {
      authMethod = "oauth-broker";
      authenticated = true;
    }
  }

  out(`  "authenticated": ${authenticated},`);
  out(`  "authMethod": "${authMethod}",`);
  out(`  "tools": ${TOOL_COUNT},`);

  const byScope = new Map<string, number>();
  for (const t of getToolSummary()) {
    byScope.set(t.scope, (byScope.get(t.scope) ?? 0) + 1);
  }
  const scopes = Array.from(byScope.entries())
    .map(([scope, count]) => `"${scope}": ${count}`)
    .join(", ");
  out(`  "toolsByScope": { ${scopes} },`);

  const billable = getToolSummary().filter((t) => t.billable).length;
  out(`  "billable tools": ${billable},`);
  out(`  "resources": ${CAPIX_RESOURCES.length},`);
  out(`  "prompts": ${CAPIX_PROMPTS.length},`);

  const client = await createClient({
    baseUrl,
    apiKey: apiKey,
    projectId: process.env.CAPIX_PROJECT_ID,
    log: () => {},
  });

  if (!authenticated) {
    out(`  "status": "degraded",`);
    out(`  "advice": "Run 'capix-mcp login' or set CAPIX_API_KEY / CAPIX_REFRESH_TOKEN"`);
  } else if (client.isAuthenticated()) {
    out(`  "status": "ok"`);
  } else {
    out(`  "status": "degraded",`);
    out(`  "advice": "Credentials present but client could not authenticate"`);
  }
  out(`}`);
}

// Re-export the assembled-server factory + tool names for programmatic use.
export { createCapixMcpServer, TOOL_NAMES };
export const CAPIX_VERSION = VERSION;
