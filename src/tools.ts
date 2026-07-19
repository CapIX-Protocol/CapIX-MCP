/**
 * Capix MCP Server — all 64 tool definitions.
 *
 * Each tool is declared with:
 *   - inputShape  : a Zod raw shape (validated by the McpServer before dispatch)
 *   - outputShape : a Zod raw shape describing the structured result envelope
 *   - billable / requiresApproval : control-plane flags enforced by the server
 *
 * Handlers are deliberately thin: they translate Zod-validated arguments into
 * canonical `/api/v1/*` client calls and return the upstream JSON object as
 * structured content. The CapixApiError (problem+json) thrown by the client is
 * caught by the server wrapper and surfaced as an MCP error result.
 *
 * CRUD-shaped tools are declared with `defineGeneratedTool` (tools/generate.ts)
 * — a declarative spec (method, path, input) from which the registration AND
 * the HTTP call are generated — instead of a hand-written handler. Everything
 * else uses `defineTool` (tools/define-tool.ts) with an explicit handler.
 *
 * Tools are grouped by scope (mirrors services/capix-mcp/tools/*.ts):
 *   discovery (9) · planning (6) · lifecycle (7) · networking (8) ·
 *   testing (6) · verification (6) · website (17) · infra-context (5)
 */

import { z } from "zod";
import type {
  CapixClientLike,
  ToolDef,
} from "./types.js";
import {
  APPROVAL_ONLY,
  BILLABLE,
  READ_ONLY,
} from "./types.js";
import { defineTool } from "./tools/define-tool.js";
import { defineGeneratedTool } from "./tools/generate.js";
import { infraContextTools } from "./tools/infra-context.js";

// ===========================================================================
// Reusable Zod fragments
// ===========================================================================

const iso8601 = z.string().datetime().or(z.string());

const moneyShape = z.object({
  amount: z.string().describe("Integer minor units (e.g. lamports, micro-USDC, cents)."),
  asset: z.enum(["SOL", "USDC", "USD-credit"]),
  scale: z.number().int(),
}).describe("Integer minor/native money amount serialized as a JSON string.");

const deploymentIdShape = z.string().describe("Canonical deployment id (dep_…).");
const operationIdShape = z.string().describe("Canonical operation id (op_…).");
const quoteIdShape = z.string().describe("Canonical quote id (qt_…) from capix_compute_quote / capix_model_quote.");
const siteIdShape = z.string().describe("Capix website project id.");

const listResultShape = {
  entries: z.array(z.record(z.unknown())).optional().describe("Paginated item array."),
  nextCursor: z.string().optional().describe("Opaque cursor for the next page; absent when exhausted."),
  fetchedAt: iso8601.optional().describe("ISO8601 fetch timestamp."),
} satisfies Record<string, z.ZodTypeAny>;

const quoteResultShape = {
  quoteId: quoteIdShape.optional(),
  price: moneyShape.optional(),
  providerCostBasis: moneyShape.optional(),
  fees: moneyShape.optional(),
  margin: moneyShape.optional(),
  provider: z.string().optional(),
  region: z.string().optional(),
  expiresAt: iso8601.optional(),
  feasible: z.boolean().optional(),
} satisfies Record<string, z.ZodTypeAny>;

const deploymentResultShape = {
  deploymentId: deploymentIdShape.optional(),
  operationId: operationIdShape.optional(),
  phase: z.string().optional().describe("DeploymentPhase after mutation."),
  quoteId: quoteIdShape.optional(),
  holdId: z.string().optional().describe("Ledger hold that funds the deployment."),
  estimatedCost: moneyShape.optional(),
  acceptedAt: iso8601.optional(),
} satisfies Record<string, z.ZodTypeAny>;

const networkResourceShape = {
  resourceId: z.string().optional(),
  kind: z.string().optional().describe("vpc | endpoint | port_forward | private_connection | dedicated_ip."),
  deploymentId: deploymentIdShape.optional(),
  status: z.enum(["provisioning", "ready", "failed", "destroyed"]).optional(),
  endpoint: z.string().optional(),
  acceptedAt: iso8601.optional(),
} satisfies Record<string, z.ZodTypeAny>;

const siteResultShape = {
  siteId: siteIdShape.optional(),
  deploymentId: z.string().optional(),
  url: z.string().optional(),
  status: z.enum(["queued", "building", "ready", "failed"]).optional(),
  estimatedCost: moneyShape.optional(),
  acceptedAt: iso8601.optional(),
} satisfies Record<string, z.ZodTypeAny>;

// ===========================================================================
// defineTool — imported from tools/define-tool.ts (shared with sibling tool
// modules such as tools/infra-context.ts; see that file for the doc comment).
// ===========================================================================

/** Convenience: pull a string argument, throwing a typed error if missing. */
function asStr(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    const err = new Error(`${field} is required`);
    (err as Error & { capixCode: string; status: number }).capixCode = "invalid_argument";
    (err as Error & { capixCode: string; status: number }).status = 400;
    throw err;
  }
  return value;
}

/** Call the client, passing the approval token through for billable tools. */
async function callBillable(
  client: CapixClientLike,
  approvalToken: string | undefined,
  path: string,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!approvalToken) {
    const err = new Error("approvalToken is required for this billable tool (§5)");
    (err as Error & { capixCode: string; status: number }).capixCode = "approval_required";
    (err as Error & { capixCode: string; status: number }).status = 402;
    throw err;
  }
  return client.post<Record<string, unknown>>(path, body, { idempotent: true, approvalToken });
}

// ===========================================================================
// Discovery tools (9) — read-only, auto-run after authentication.
// ===========================================================================

const discoveryTools: ToolDef[] = [
  defineTool({
    name: "capix_account",
    description:
      "Inspect the authenticated account: wallet address, balance, spending limits, active deployments/agents. Read-only — safe to auto-run.",
    scope: "discovery",
    ...READ_ONLY,
    inputShape: {},
    outputShape: {
      accountId: z.string().optional(),
      walletAddress: z.string().optional(),
      balance: moneyShape.optional(),
      spendingLimitMinor: z.string().optional(),
      activeDeployments: z.number().int().optional(),
      activeAgents: z.number().int().optional(),
      lastBilledAt: iso8601.optional(),
    },
    handler: async (_args, { client }) =>
      client.get<Record<string, unknown>>("/api/v1/account"),
  }),
  defineTool({
    name: "capix_balance",
    description:
      "Get the customer cash balance (available / held / total) for the account. Read-only.",
    scope: "discovery",
    ...READ_ONLY,
    inputShape: {
      asset: z.enum(["SOL", "USDC", "USD-credit"]).optional().describe("Optional asset filter."),
    },
    outputShape: {
      accountId: z.string().optional(),
      asset: z.enum(["SOL", "USDC", "USD-credit"]).optional(),
      available: z.string().optional(),
      held: z.string().optional(),
      total: z.string().optional(),
      asOf: iso8601.optional(),
    },
    handler: async (args, { client }) =>
      client.get<Record<string, unknown>>("/api/v1/account/balance", {
        asset: args.asset,
      }),
  }),
  defineTool({
    name: "capix_projects",
    description: "List projects visible to the authenticated account. Read-only.",
    scope: "discovery",
    ...READ_ONLY,
    inputShape: {
      limit: z.number().int().min(1).max(200).default(50).describe("Max projects to return."),
    },
    outputShape: listResultShape,
    handler: async (args, { client }) =>
      client.get<Record<string, unknown>>("/api/v1/projects", { limit: args.limit }),
  }),
  defineTool({
    name: "capix_compute_catalog",
    description:
      "List the live compute capability catalog (provider / region / tier / price / availability). Read-only.",
    scope: "discovery",
    ...READ_ONLY,
    inputShape: {
      region: z.string().optional().describe("Optional region filter."),
      gpu: z.boolean().optional().describe("Restrict to GPU-capable entries."),
    },
    outputShape: {
      entries: z.array(z.record(z.unknown())).optional(),
      catalogVersion: z.string().optional(),
      fetchedAt: iso8601.optional(),
    },
    handler: async (args, { client }) =>
      client.get<Record<string, unknown>>("/api/v1/catalog/compute", {
        region: args.region,
        gpu: args.gpu,
      }),
  }),
  defineTool({
    name: "capix_model_catalog",
    description:
      "List the live model endpoint catalog (model id, context length, price per 1k tokens). Read-only.",
    scope: "discovery",
    ...READ_ONLY,
    inputShape: {
      provider: z.string().optional().describe("Optional provider filter."),
    },
    outputShape: {
      entries: z.array(z.record(z.unknown())).optional(),
      catalogVersion: z.string().optional(),
      fetchedAt: iso8601.optional(),
    },
    handler: async (args, { client }) =>
      client.get<Record<string, unknown>>("/api/v1/catalog/models", {
        provider: args.provider,
      }),
  }),
  defineTool({
    name: "capix_network_status",
    description:
      "Inspect network and gateway status (provider health, lanes, emergency flags). Read-only.",
    scope: "discovery",
    ...READ_ONLY,
    inputShape: {},
    outputShape: {
      gateway: z.string().optional(),
      status: z.enum(["ok", "degraded", "outage"]).optional(),
      providers: z.array(z.record(z.unknown())).optional(),
      lanes: z.array(z.record(z.unknown())).optional(),
      emergencyFlags: z.array(z.record(z.unknown())).optional(),
      fetchedAt: iso8601.optional(),
    },
    handler: async (_args, { client }) =>
      client.get<Record<string, unknown>>("/api/v1/network/status"),
  }),
  defineGeneratedTool({
    name: "capix_deployments",
    description:
      "List deployments for the account/project with phase + allocation state. Read-only.",
    scope: "discovery",
    ...READ_ONLY,
    method: "GET",
    path: "/api/v1/deployments",
    input: {
      limit: z.number().int().min(1).max(200).default(50).describe("Max deployments to return."),
      phase: z.string().optional().describe("Optional DeploymentPhase filter."),
    },
    outputShape: listResultShape,
  }),
  defineGeneratedTool({
    name: "capix_receipts",
    description:
      "List settled work receipts (cost records) for the account. Read-only.",
    scope: "discovery",
    ...READ_ONLY,
    method: "GET",
    path: "/api/v1/receipts",
    input: {
      limit: z.number().int().min(1).max(200).default(50),
      since: iso8601.optional().describe("Optional lower bound (inclusive)."),
    },
    outputShape: listResultShape,
  }),
  defineTool({
    name: "capix_attestations",
    description:
      "List attestation evidence records for the account (TEE / zkVM). Read-only.",
    scope: "discovery",
    ...READ_ONLY,
    inputShape: {
      limit: z.number().int().min(1).max(200).default(50),
      kind: z.enum(["tee", "zkvm"]).optional().describe("Optional attestation kind filter."),
    },
    outputShape: listResultShape,
    handler: async (args, { client }) =>
      client.get<Record<string, unknown>>("/api/v1/attestations", {
        limit: args.limit,
        kind: args.kind,
      }),
  }),
];

// ===========================================================================
// Planning tools (6) — read-only planning & quoting.
// ===========================================================================

const computeSpecShape = {
  workloadType: z.string().describe("e.g. replicated_service.v1, private_inference.v1, agent_run.v1."),
  cpu: z.number().int().min(1),
  ramMb: z.number().int().min(128),
  storageGb: z.number().int().min(0),
  gpu: z.number().int().min(0).optional(),
  vramMb: z.number().int().min(0).optional(),
  region: z.string().optional(),
  imageDigest: z.string().optional().describe("Pinned image digest."),
  maxPriceUsdHourly: z.number().optional(),
  maxDurationHours: z.number().optional(),
} satisfies z.ZodRawShape;

const modelSpecShape = {
  modelId: z.string(),
  quantization: z.string().optional(),
  contextLength: z.number().int().min(1).optional(),
  gpuType: z.string().optional(),
  gpuCount: z.number().int().min(1).optional(),
  region: z.string().optional(),
  maxPriceUsdHourly: z.number().optional(),
  maxConcurrency: z.number().int().min(1).optional(),
} satisfies z.ZodRawShape;

const stackManifestShape = {
  name: z.string(),
  services: z.array(z.record(z.unknown())),
  network: z.record(z.unknown()).optional(),
  region: z.string().optional(),
} satisfies z.ZodRawShape;

const planningTools: ToolDef[] = [
  defineTool({
    name: "capix_compute_plan",
    description:
      "Plan a compute deployment: pick provider/region/spec for the requested workload shape. Read-only.",
    scope: "planning",
    ...READ_ONLY,
    inputShape: computeSpecShape,
    outputShape: {
      feasible: z.boolean(),
      provider: z.string().optional(),
      region: z.string().optional(),
      cpu: z.number().int().optional(),
      ramMb: z.number().int().optional(),
      storageGb: z.number().int().optional(),
      gpu: z.number().int().optional(),
      estimatedCostHourly: moneyShape.optional(),
      estimatedCostTotal: moneyShape.optional(),
      notes: z.string().optional(),
    },
    handler: async (args, { client }) =>
      client.post<Record<string, unknown>>("/api/v1/planning/compute/plan", args),
  }),
  defineGeneratedTool({
    name: "capix_compute_quote",
    description:
      "Get a canonical quote for a compute deployment plan (locks asset/scale/FX/fee/expiry). Read-only.",
    scope: "planning",
    ...READ_ONLY,
    method: "POST",
    path: "/api/v1/planning/compute/quote",
    input: computeSpecShape,
    outputShape: quoteResultShape,
  }),
  defineTool({
    name: "capix_model_plan",
    description:
      "Plan a model endpoint for the requested model hosting shape. Read-only.",
    scope: "planning",
    ...READ_ONLY,
    inputShape: modelSpecShape,
    outputShape: {
      feasible: z.boolean(),
      provider: z.string().optional(),
      region: z.string().optional(),
      gpu: z.number().int().optional(),
      estimatedCostHourly: moneyShape.optional(),
      estimatedCostTotal: moneyShape.optional(),
      notes: z.string().optional(),
    },
    handler: async (args, { client }) =>
      client.post<Record<string, unknown>>("/api/v1/planning/model/plan", args),
  }),
  defineGeneratedTool({
    name: "capix_model_quote",
    description: "Get a canonical quote for a model endpoint plan. Read-only.",
    scope: "planning",
    ...READ_ONLY,
    method: "POST",
    path: "/api/v1/planning/model/quote",
    input: modelSpecShape,
    outputShape: quoteResultShape,
  }),
  defineTool({
    name: "capix_stack_validate",
    description:
      "Validate a stack manifest (services, dependencies, network) without provisioning. Read-only.",
    scope: "planning",
    ...READ_ONLY,
    inputShape: stackManifestShape,
    outputShape: {
      valid: z.boolean(),
      errors: z.array(z.string()).optional(),
      warnings: z.array(z.string()).optional(),
    },
    handler: async (args, { client }) =>
      client.post<Record<string, unknown>>("/api/v1/planning/stack/validate", args),
  }),
  defineTool({
    name: "capix_stack_plan",
    description:
      "Plan a multi-service stack: produce a deployment plan graph + aggregate quote. Read-only.",
    scope: "planning",
    ...READ_ONLY,
    inputShape: stackManifestShape,
    outputShape: {
      feasible: z.boolean(),
      services: z.array(z.record(z.unknown())).optional(),
      aggregateQuote: z.record(z.unknown()).optional(),
      notes: z.string().optional(),
    },
    handler: async (args, { client }) =>
      client.post<Record<string, unknown>>("/api/v1/planning/stack/plan", args),
  }),
];

// ===========================================================================
// Lifecycle tools (7) — billable mutations, require approval.
// ===========================================================================

const lifecycleTools: ToolDef[] = [
  defineTool({
    name: "capix_deploy",
    description:
      "Deploy a workload against a canonical quote. Takes a ledger hold + provisions resources. Billable; requires approval.",
    scope: "lifecycle",
    ...BILLABLE,
    inputShape: {
      quoteId: quoteIdShape.describe("Canonical quote from capix_compute_quote / capix_model_quote."),
      workloadType: z.string(),
      region: z.string().optional(),
      imageDigest: z.string().optional(),
      durationHours: z.number().min(1).optional(),
      env: z.record(z.string()).optional(),
      ingress: z.array(z.number().int()).optional(),
    },
    outputShape: deploymentResultShape,
    handler: async (args, { client, ctx }) =>
      callBillable(client, ctx.approvalToken, "/api/v1/lifecycle/deployments", args),
  }),
  defineTool({
    name: "capix_start",
    description:
      "Start a stopped deployment. Billable (resumes metering); requires approval.",
    scope: "lifecycle",
    ...BILLABLE,
    inputShape: {
      deploymentId: deploymentIdShape,
    },
    outputShape: deploymentResultShape,
    handler: async (args, { client, ctx }) =>
      callBillable(
        client,
        ctx.approvalToken,
        `/api/v1/lifecycle/deployments/${encodeURIComponent(asStr(args.deploymentId, "deploymentId"))}/start`,
      ),
  }),
  defineGeneratedTool({
    name: "capix_stop",
    description:
      "Stop a running deployment (halts metering, keeps allocation). Billable (minimal); requires approval.",
    scope: "lifecycle",
    ...BILLABLE,
    method: "POST",
    path: "/api/v1/lifecycle/deployments/:deploymentId/stop",
    input: {
      deploymentId: deploymentIdShape,
    },
    outputShape: deploymentResultShape,
  }),
  defineTool({
    name: "capix_restart",
    description: "Restart a deployment (stop + start cycle). Billable; requires approval.",
    scope: "lifecycle",
    ...BILLABLE,
    inputShape: {
      deploymentId: deploymentIdShape,
    },
    outputShape: deploymentResultShape,
    handler: async (args, { client, ctx }) =>
      callBillable(
        client,
        ctx.approvalToken,
        `/api/v1/lifecycle/deployments/${encodeURIComponent(asStr(args.deploymentId, "deploymentId"))}/restart`,
      ),
  }),
  defineTool({
    name: "capix_delete",
    description:
      "Delete (terminate) a deployment and release its allocation. Billable (final settlement); requires approval.",
    scope: "lifecycle",
    ...BILLABLE,
    inputShape: {
      deploymentId: deploymentIdShape,
      reason: z.string().optional(),
    },
    outputShape: deploymentResultShape,
    handler: async (args, { client, ctx }) => {
      const id = asStr(args.deploymentId, "deploymentId");
      const res = await callBillable(
        client,
        ctx.approvalToken,
        `/api/v1/lifecycle/deployments/${encodeURIComponent(id)}`,
        args.reason ? { reason: args.reason } : undefined,
      );
      // DELETE semantics: the canonical route is DELETE; some gateways express
      // the mutation via POST with idempotency. Use the client delete path with
      // an approval header via a light POST-to-delete fallback.
      return res;
    },
  }),
  defineTool({
    name: "capix_extend",
    description:
      "Extend a running deployment by additional hours against a fresh hold. Billable; requires approval.",
    scope: "lifecycle",
    ...BILLABLE,
    inputShape: {
      deploymentId: deploymentIdShape,
      durationHours: z.number().min(1),
      quoteId: quoteIdShape.optional().describe("Canonical quote for the extension cost."),
    },
    outputShape: deploymentResultShape,
    handler: async (args, { client, ctx }) =>
      callBillable(
        client,
        ctx.approvalToken,
        `/api/v1/lifecycle/deployments/${encodeURIComponent(asStr(args.deploymentId, "deploymentId"))}/extend`,
        { durationHours: args.durationHours, quoteId: args.quoteId },
      ),
  }),
  defineGeneratedTool({
    name: "capix_cancel",
    description:
      "Cancel an in-flight operation (best-effort; may trigger compensation). Read-only intent; requires approval to mutate.",
    scope: "lifecycle",
    ...APPROVAL_ONLY,
    method: "POST",
    path: "/api/v1/operations/:operationId/cancel",
    input: {
      operationId: operationIdShape,
      reason: z.string().optional(),
    },
    outputShape: {
      operationId: operationIdShape.optional(),
      status: z.string().optional(),
      acceptedAt: iso8601.optional(),
    },
  }),
];

// ===========================================================================
// Networking tools (8) — billable mutations + read-only inspection.
// ===========================================================================

const networkingTools: ToolDef[] = [
  defineTool({
    name: "capix_create_vpc",
    description: "Create a VPC for a project. Billable; requires approval.",
    scope: "networking",
    ...BILLABLE,
    inputShape: {
      cidr: z.string().describe("VPC CIDR block, e.g. 10.0.0.0/16."),
      region: z.string(),
      name: z.string().optional(),
    },
    outputShape: networkResourceShape,
    handler: async (args, { client, ctx }) =>
      callBillable(client, ctx.approvalToken, "/api/v1/networking/vpcs", args),
  }),
  defineTool({
    name: "capix_create_endpoint",
    description:
      "Create a public endpoint for a deployment. Billable; requires approval.",
    scope: "networking",
    ...BILLABLE,
    inputShape: {
      deploymentId: deploymentIdShape,
      port: z.number().int().min(1).max(65535),
      protocol: z.enum(["http", "https", "tcp"]).default("http"),
      hostname: z.string().optional().describe("Optional requested hostname."),
    },
    outputShape: networkResourceShape,
    handler: async (args, { client, ctx }) =>
      callBillable(client, ctx.approvalToken, "/api/v1/networking/endpoints", args),
  }),
  defineTool({
    name: "capix_expose_port",
    description:
      "Expose a port (ingress) to the public internet. Billable; requires approval.",
    scope: "networking",
    ...BILLABLE,
    inputShape: {
      deploymentId: deploymentIdShape,
      port: z.number().int().min(1).max(65535),
      protocol: z.enum(["tcp", "udp"]).default("tcp"),
      allowedCidrs: z.array(z.string()).optional().describe("Optional ingress allow-list."),
    },
    outputShape: networkResourceShape,
    handler: async (args, { client, ctx }) =>
      callBillable(client, ctx.approvalToken, "/api/v1/networking/ports/expose", args),
  }),
  defineTool({
    name: "capix_close_port",
    description:
      "Close a previously exposed port. Non-billable soft mutation; requires approval.",
    scope: "networking",
    ...APPROVAL_ONLY,
    inputShape: {
      deploymentId: deploymentIdShape,
      port: z.number().int().min(1).max(65535),
      protocol: z.enum(["tcp", "udp"]).default("tcp"),
    },
    outputShape: networkResourceShape,
    handler: async (args, { client, ctx }) =>
      callBillable(client, ctx.approvalToken, "/api/v1/networking/ports/close", args),
  }),
  defineTool({
    name: "capix_inspect_routes",
    description: "Inspect the routing table for a deployment. Read-only.",
    scope: "networking",
    ...READ_ONLY,
    inputShape: {
      deploymentId: deploymentIdShape,
    },
    outputShape: {
      deploymentId: deploymentIdShape.optional(),
      routes: z.array(z.record(z.unknown())).optional(),
      fetchedAt: iso8601.optional(),
    },
    handler: async (args, { client }) =>
      client.get<Record<string, unknown>>(
        `/api/v1/networking/deployments/${encodeURIComponent(asStr(args.deploymentId, "deploymentId"))}/routes`,
      ),
  }),
  defineTool({
    name: "capix_create_private_connection",
    description:
      "Create a private endpoint connection (raw private endpoint). Billable; requires approval.",
    scope: "networking",
    ...BILLABLE,
    inputShape: {
      deploymentId: deploymentIdShape,
      service: z.string().describe("Target service identifier."),
      port: z.number().int().min(1).max(65535).optional(),
    },
    outputShape: networkResourceShape,
    handler: async (args, { client, ctx }) =>
      callBillable(client, ctx.approvalToken, "/api/v1/networking/private-connections", args),
  }),
  defineTool({
    name: "capix_request_dedicated_ip",
    description:
      "Request a dedicated (non-shared) IP for a deployment. Paid; requires approval.",
    scope: "networking",
    ...BILLABLE,
    inputShape: {
      deploymentId: deploymentIdShape,
      region: z.string().optional(),
      quoteId: quoteIdShape.describe("Canonical quote for the dedicated IP."),
    },
    outputShape: networkResourceShape,
    handler: async (args, { client, ctx }) =>
      callBillable(client, ctx.approvalToken, "/api/v1/networking/dedicated-ips", args),
  }),
  defineTool({
    name: "capix_port_forward",
    description:
      "Set up port forwarding between a deployment port and a host port. Billable; requires approval.",
    scope: "networking",
    ...BILLABLE,
    inputShape: {
      deploymentId: deploymentIdShape,
      sourcePort: z.number().int().min(1).max(65535),
      targetPort: z.number().int().min(1).max(65535),
      protocol: z.enum(["tcp", "udp"]).default("tcp"),
    },
    outputShape: networkResourceShape,
    handler: async (args, { client, ctx }) =>
      callBillable(client, ctx.approvalToken, "/api/v1/networking/port-forwards", args),
  }),
];

// ===========================================================================
// Testing tools (6) — disposable envs, inspection, bounded commands, cleanup.
// ===========================================================================

const testingTools: ToolDef[] = [
  defineTool({
    name: "capix_create_test_env",
    description:
      "Create a disposable test environment from a spec. Billable; requires approval.",
    scope: "testing",
    ...BILLABLE,
    inputShape: {
      name: z.string(),
      workloadType: z.string(),
      cpu: z.number().int().min(1),
      ramMb: z.number().int().min(128),
      region: z.string().optional(),
      imageDigest: z.string().optional(),
      ttlMinutes: z.number().int().min(1).max(1440).default(60).describe("Auto-destroy TTL."),
      quoteId: quoteIdShape.optional().describe("Canonical quote for the env."),
    },
    outputShape: {
      envId: z.string().optional(),
      status: z.enum(["provisioning", "ready", "failed"]).optional(),
      provider: z.string().optional(),
      region: z.string().optional(),
      endpoint: z.string().optional(),
      provisionedAt: iso8601.optional(),
    },
    handler: async (args, { client, ctx }) =>
      callBillable(client, ctx.approvalToken, "/api/v1/testing/environments", args),
  }),
  defineTool({
    name: "capix_run_health_checks",
    description:
      "Run health checks (liveness/readiness probes) on a deployment. Read-only.",
    scope: "testing",
    ...READ_ONLY,
    inputShape: {
      deploymentId: deploymentIdShape,
    },
    outputShape: {
      deploymentId: deploymentIdShape.optional(),
      healthy: z.boolean().optional(),
      checks: z.array(z.record(z.unknown())).optional(),
      ranAt: iso8601.optional(),
    },
    handler: async (args, { client }) =>
      client.get<Record<string, unknown>>(
        `/api/v1/testing/deployments/${encodeURIComponent(asStr(args.deploymentId, "deploymentId"))}/health`,
      ),
  }),
  defineTool({
    name: "capix_run_bounded_command",
    description:
      "Run an allow-listed, time-bounded command on a deployment node. Requires approval (may execute code).",
    scope: "testing",
    ...APPROVAL_ONLY,
    inputShape: {
      deploymentId: deploymentIdShape,
      command: z.string().describe("Command string from the allow-list."),
      timeoutSeconds: z.number().int().min(1).max(600).default(60),
      expectedExitCode: z.number().int().default(0),
    },
    outputShape: {
      deploymentId: deploymentIdShape.optional(),
      results: z.array(z.record(z.unknown())).optional(),
      completedAt: iso8601.optional(),
    },
    handler: async (args, { client, ctx }) =>
      callBillable(
        client,
        ctx.approvalToken,
        `/api/v1/testing/deployments/${encodeURIComponent(asStr(args.deploymentId, "deploymentId"))}/commands`,
        args,
      ),
  }),
  defineTool({
    name: "capix_inspect_logs",
    description: "Inspect deployment logs. Read-only.",
    scope: "testing",
    ...READ_ONLY,
    inputShape: {
      deploymentId: deploymentIdShape,
      limit: z.number().int().min(1).max(1000).default(200),
      since: iso8601.optional(),
      level: z.enum(["debug", "info", "warn", "error"]).optional(),
    },
    outputShape: {
      resourceId: z.string().optional(),
      lines: z.array(z.record(z.unknown())).optional(),
      truncated: z.boolean().optional(),
    },
    handler: async (args, { client }) =>
      client.get<Record<string, unknown>>(
        `/api/v1/testing/deployments/${encodeURIComponent(asStr(args.deploymentId, "deploymentId"))}/logs`,
        { limit: args.limit, since: args.since, level: args.level },
      ),
  }),
  defineTool({
    name: "capix_inspect_metrics",
    description: "Inspect deployment metrics. Read-only.",
    scope: "testing",
    ...READ_ONLY,
    inputShape: {
      deploymentId: deploymentIdShape,
      windowMinutes: z.number().int().min(1).max(10080).default(60),
      names: z.array(z.string()).optional().describe("Optional metric name filter."),
    },
    outputShape: {
      resourceId: z.string().optional(),
      metrics: z.array(z.record(z.unknown())).optional(),
    },
    handler: async (args, { client }) =>
      client.get<Record<string, unknown>>(
        `/api/v1/testing/deployments/${encodeURIComponent(asStr(args.deploymentId, "deploymentId"))}/metrics`,
        { windowMinutes: args.windowMinutes, names: args.names },
      ),
  }),
  defineTool({
    name: "capix_destroy_task_resources",
    description:
      "Destroy all resources scoped to a task (cleanup safety gate §18). Destructive; requires approval.",
    scope: "testing",
    ...APPROVAL_ONLY,
    inputShape: {
      resourceId: z.string().describe("Task-scoped resource id to destroy."),
      reason: z.string().optional(),
    },
    outputShape: {
      resourceId: z.string().optional(),
      status: z.enum(["destroyed", "failed", "not_found"]).optional(),
      destroyedAt: iso8601.optional(),
    },
    handler: async (args, { client, ctx }) => {
      const id = asStr(args.resourceId, "resourceId");
      return callBillable(
        client,
        ctx.approvalToken,
        `/api/v1/testing/environments/${encodeURIComponent(id)}`,
        args.reason ? { reason: args.reason } : undefined,
      );
    },
  }),
];

// ===========================================================================
// Verification tools (6) — read-only attestation/proof/receipt inspection.
// ===========================================================================

const verificationTools: ToolDef[] = [
  defineTool({
    name: "capix_fetch_attestation",
    description:
      "Fetch attestation evidence for a deployment (TEE / zkVM). Read-only.",
    scope: "verification",
    ...READ_ONLY,
    inputShape: {
      deploymentId: deploymentIdShape,
    },
    outputShape: {
      attestationId: z.string().optional(),
      kind: z.enum(["tee", "zkvm"]).optional(),
      resourceId: z.string().optional(),
      evidence: z.string().optional(),
      measurement: z.string().optional(),
      fetchedAt: iso8601.optional(),
    },
    handler: async (args, { client }) =>
      client.get<Record<string, unknown>>(
        `/api/v1/verification/deployments/${encodeURIComponent(asStr(args.deploymentId, "deploymentId"))}/attestation`,
      ),
  }),
  defineTool({
    name: "capix_verify_attestation",
    description:
      "Verify an attestation against the expected reference measurement. Read-only.",
    scope: "verification",
    ...READ_ONLY,
    inputShape: {
      attestationId: z.string(),
      expectedMeasurement: z.string().optional().describe("Optional pinned reference measurement."),
    },
    outputShape: {
      subjectId: z.string().optional(),
      kind: z.enum(["tee", "zkvm", "measurement", "receipt"]).optional(),
      verified: z.boolean().optional(),
      reason: z.string().optional(),
      verifier: z.string().optional(),
      verifiedAt: iso8601.optional(),
    },
    handler: async (args, { client }) =>
      client.post<Record<string, unknown>>(
        `/api/v1/verification/attestations/${encodeURIComponent(asStr(args.attestationId, "attestationId"))}/verify`,
        { expectedMeasurement: args.expectedMeasurement },
      ),
  }),
  defineTool({
    name: "capix_fetch_proof",
    description: "Fetch a zkVM proof artifact for a workload. Read-only.",
    scope: "verification",
    ...READ_ONLY,
    inputShape: {
      workloadId: z.string(),
    },
    outputShape: {
      proofId: z.string().optional(),
      workloadId: z.string().optional(),
      proofSystem: z.string().optional(),
      artifactRef: z.string().optional(),
      publicInputs: z.string().optional(),
      fetchedAt: iso8601.optional(),
    },
    handler: async (args, { client }) =>
      client.get<Record<string, unknown>>(
        `/api/v1/verification/workloads/${encodeURIComponent(asStr(args.workloadId, "workloadId"))}/proof`,
      ),
  }),
  defineTool({
    name: "capix_verify_proof",
    description: "Verify a zkVM proof artifact against its public inputs. Read-only.",
    scope: "verification",
    ...READ_ONLY,
    inputShape: {
      proofId: z.string(),
    },
    outputShape: {
      subjectId: z.string().optional(),
      kind: z.enum(["tee", "zkvm", "measurement", "receipt"]).optional(),
      verified: z.boolean().optional(),
      reason: z.string().optional(),
      verifier: z.string().optional(),
      verifiedAt: iso8601.optional(),
    },
    handler: async (args, { client }) =>
      client.post<Record<string, unknown>>(
        `/api/v1/verification/proofs/${encodeURIComponent(asStr(args.proofId, "proofId"))}/verify`,
      ),
  }),
  defineTool({
    name: "capix_inspect_measurement",
    description:
      "Inspect the recorded measurement of a workload (used to pin expected TEE state). Read-only.",
    scope: "verification",
    ...READ_ONLY,
    inputShape: {
      workloadId: z.string(),
    },
    outputShape: {
      workloadId: z.string().optional(),
      measurement: z.string().optional(),
      measurementAlgorithm: z.string().optional(),
      imageDigest: z.string().optional(),
      recordedAt: iso8601.optional(),
    },
    handler: async (args, { client }) =>
      client.get<Record<string, unknown>>(
        `/api/v1/verification/workloads/${encodeURIComponent(asStr(args.workloadId, "workloadId"))}/measurement`,
      ),
  }),
  defineGeneratedTool({
    name: "capix_inspect_receipt",
    description:
      "Inspect a settled work receipt (cost breakdown, settlement, approval status). Read-only.",
    scope: "verification",
    ...READ_ONLY,
    method: "GET",
    path: "/api/v1/verification/receipts/:receiptId",
    input: {
      receiptId: z.string(),
    },
    outputShape: {
      receiptId: z.string().optional(),
      approvalStatus: z.string().optional(),
      cost: z.record(z.unknown()).optional(),
      settlement: z.record(z.unknown()).optional(),
      postedAt: iso8601.optional(),
    },
  }),
];

// ===========================================================================
// Website tools (17) — static-site + preview hosting.
// ===========================================================================

const repoOptShape = {
  repoUrl: z.string().describe("Git repository URL."),
  branch: z.string().default("main"),
  subPath: z.string().optional().describe("Optional monorepo subpath."),
  framework: z.string().optional().describe("Optional pinned framework."),
} satisfies z.ZodRawShape;

const websiteTools: ToolDef[] = [
  defineTool({
    name: "capix_website_project_string_check",
    description:
      "Check a repository string for framework/dep compatibility with Capix hosting. Read-only.",
    scope: "website",
    ...READ_ONLY,
    inputShape: {
      repoUrl: z.string(),
    },
    outputShape: {
      ok: z.boolean().optional(),
      framework: z.string().optional(),
      notes: z.string().optional(),
    },
    handler: async (args, { client }) =>
      client.post<Record<string, unknown>>(
        "/api/v1/website/check-project-string",
        { repoUrl: asStr(args.repoUrl, "repoUrl") },
      ),
  }),
  defineTool({
    name: "capix_website_create",
    description:
      "Create a Capix website project from a repo. Billable; requires approval.",
    scope: "website",
    ...BILLABLE,
    inputShape: repoOptShape,
    outputShape: siteResultShape,
    handler: async (args, { client, ctx }) =>
      callBillable(client, ctx.approvalToken, "/api/v1/website/sites", args),
  }),
  defineTool({
    name: "capix_website_detect",
    description:
      "Detect the framework/build settings of a repo without provisioning. Read-only.",
    scope: "website",
    ...READ_ONLY,
    inputShape: {
      repoUrl: z.string(),
      branch: z.string().optional(),
    },
    outputShape: {
      framework: z.string().optional(),
      buildCommand: z.string().optional(),
      outputDir: z.string().optional(),
      nodeVersion: z.string().optional(),
      detectedAt: iso8601.optional(),
    },
    handler: async (args, { client }) =>
      client.post<Record<string, unknown>>("/api/v1/website/detect", {
        repoUrl: asStr(args.repoUrl, "repoUrl"),
        branch: args.branch,
      }),
  }),
  defineTool({
    name: "capix_website_plan",
    description: "Plan a website deployment (build + hosting plan). Read-only.",
    scope: "website",
    ...READ_ONLY,
    inputShape: {
      siteId: siteIdShape.optional(),
      repoUrl: z.string().optional(),
      branch: z.string().optional(),
      subPath: z.string().optional(),
      framework: z.string().optional(),
    },
    outputShape: {
      feasible: z.boolean().optional(),
      plan: z.record(z.unknown()).optional(),
      notes: z.string().optional(),
    },
    handler: async (args, { client }) =>
      client.post<Record<string, unknown>>("/api/v1/website/plan", args),
  }),
  defineTool({
    name: "capix_website_quote",
    description: "Get a canonical quote for a website deploy. Read-only.",
    scope: "website",
    ...READ_ONLY,
    inputShape: {
      repoUrl: z.string().optional(),
      branch: z.string().optional(),
      durationHours: z.number().optional(),
    },
    outputShape: {
      quoteId: z.string().optional(),
      price: moneyShape.optional(),
      feasible: z.boolean().optional(),
      expiresAt: iso8601.optional(),
    },
    handler: async (args, { client }) =>
      client.post<Record<string, unknown>>("/api/v1/website/quote", args),
  }),
  defineTool({
    name: "capix_website_deploy",
    description:
      "Deploy a website build to production. Billable; requires approval.",
    scope: "website",
    ...BILLABLE,
    inputShape: {
      siteId: siteIdShape,
      branch: z.string().optional(),
      commit: z.string().optional(),
      quoteId: quoteIdShape.optional(),
    },
    outputShape: siteResultShape,
    handler: async (args, { client, ctx }) =>
      callBillable(
        client,
        ctx.approvalToken,
        `/api/v1/website/sites/${encodeURIComponent(asStr(args.siteId, "siteId"))}/deploy`,
        { branch: args.branch, commit: args.commit, quoteId: args.quoteId },
      ),
  }),
  defineTool({
    name: "capix_website_preview",
    description:
      "Create a preview deployment for a branch. Billable; requires approval.",
    scope: "website",
    ...BILLABLE,
    inputShape: {
      siteId: siteIdShape,
      branch: z.string(),
    },
    outputShape: siteResultShape,
    handler: async (args, { client, ctx }) =>
      callBillable(
        client,
        ctx.approvalToken,
        `/api/v1/website/sites/${encodeURIComponent(asStr(args.siteId, "siteId"))}/preview`,
        { branch: args.branch },
      ),
  }),
  defineTool({
    name: "capix_website_promote",
    description:
      "Promote a preview deployment to production. Billable; requires approval.",
    scope: "website",
    ...BILLABLE,
    inputShape: {
      siteId: siteIdShape,
    },
    outputShape: siteResultShape,
    handler: async (args, { client, ctx }) =>
      callBillable(
        client,
        ctx.approvalToken,
        `/api/v1/website/sites/${encodeURIComponent(asStr(args.siteId, "siteId"))}/promote`,
      ),
  }),
  defineTool({
    name: "capix_website_rollback",
    description:
      "Roll a website back to its previous production deployment. Billable; requires approval.",
    scope: "website",
    ...BILLABLE,
    inputShape: {
      siteId: siteIdShape,
      targetDeploymentId: z.string().optional(),
    },
    outputShape: siteResultShape,
    handler: async (args, { client, ctx }) =>
      callBillable(
        client,
        ctx.approvalToken,
        `/api/v1/website/sites/${encodeURIComponent(asStr(args.siteId, "siteId"))}/rollback`,
        { targetDeploymentId: args.targetDeploymentId },
      ),
  }),
  defineTool({
    name: "capix_website_get",
    description: "Get a website project descriptor. Read-only.",
    scope: "website",
    ...READ_ONLY,
    inputShape: {
      siteId: siteIdShape,
    },
    outputShape: {
      siteId: siteIdShape.optional(),
      name: z.string().optional(),
      url: z.string().optional(),
      framework: z.string().optional(),
      status: z.string().optional(),
      createdAt: iso8601.optional(),
    },
    handler: async (args, { client }) =>
      client.get<Record<string, unknown>>(
        `/api/v1/website/sites/${encodeURIComponent(asStr(args.siteId, "siteId"))}`,
      ),
  }),
  defineTool({
    name: "capix_website_deployments",
    description: "List deployments for a website. Read-only.",
    scope: "website",
    ...READ_ONLY,
    inputShape: {
      siteId: siteIdShape,
      limit: z.number().int().min(1).max(200).default(50),
    },
    outputShape: listResultShape,
    handler: async (args, { client }) =>
      client.get<Record<string, unknown>>(
        `/api/v1/website/sites/${encodeURIComponent(asStr(args.siteId, "siteId"))}/deployments`,
        { limit: args.limit },
      ),
  }),
  defineTool({
    name: "capix_website_logs",
    description: "Inspect build/runtime logs for a website. Read-only.",
    scope: "website",
    ...READ_ONLY,
    inputShape: {
      siteId: siteIdShape,
      deploymentId: z.string().optional(),
      limit: z.number().int().min(1).max(1000).default(200),
    },
    outputShape: {
      lines: z.array(z.record(z.unknown())).optional(),
      truncated: z.boolean().optional(),
    },
    handler: async (args, { client }) =>
      client.get<Record<string, unknown>>(
        `/api/v1/website/sites/${encodeURIComponent(asStr(args.siteId, "siteId"))}/logs`,
        { deploymentId: args.deploymentId, limit: args.limit },
      ),
  }),
  defineTool({
    name: "capix_website_metrics",
    description: "Inspect request/bandwidth metrics for a website. Read-only.",
    scope: "website",
    ...READ_ONLY,
    inputShape: {
      siteId: siteIdShape,
      windowMinutes: z.number().int().min(1).max(10080).default(60),
    },
    outputShape: {
      metrics: z.array(z.record(z.unknown())).optional(),
    },
    handler: async (args, { client }) =>
      client.get<Record<string, unknown>>(
        `/api/v1/website/sites/${encodeURIComponent(asStr(args.siteId, "siteId"))}/metrics`,
        { windowMinutes: args.windowMinutes },
      ),
  }),
  defineTool({
    name: "capix_website_domain_add",
    description:
      "Attach a custom domain to a website. Billable; requires approval.",
    scope: "website",
    ...BILLABLE,
    inputShape: {
      siteId: siteIdShape,
      domain: z.string(),
    },
    outputShape: siteResultShape,
    handler: async (args, { client, ctx }) =>
      callBillable(
        client,
        ctx.approvalToken,
        `/api/v1/website/sites/${encodeURIComponent(asStr(args.siteId, "siteId"))}/domains`,
        { domain: asStr(args.domain, "domain") },
      ),
  }),
  defineTool({
    name: "capix_website_domain_verify",
    description: "Verify DNS ownership for a pending custom domain. Read-only.",
    scope: "website",
    ...READ_ONLY,
    inputShape: {
      siteId: siteIdShape,
      domain: z.string(),
    },
    outputShape: {
      verified: z.boolean().optional(),
      records: z.array(z.record(z.unknown())).optional(),
      reason: z.string().optional(),
    },
    handler: async (args, { client }) =>
      client.post<Record<string, unknown>>(
        `/api/v1/website/sites/${encodeURIComponent(asStr(args.siteId, "siteId"))}/domains/verify`,
        { domain: asStr(args.domain, "domain") },
      ),
  }),
  defineTool({
    name: "capix_website_domain_remove",
    description:
      "Detach a custom domain from a website. Billable; requires approval.",
    scope: "website",
    ...BILLABLE,
    inputShape: {
      siteId: siteIdShape,
      domain: z.string(),
    },
    outputShape: siteResultShape,
    handler: async (args, { client, ctx }) => {
      const res = await callBillable(
        client,
        ctx.approvalToken,
        `/api/v1/website/sites/${encodeURIComponent(asStr(args.siteId, "siteId"))}/domains/${encodeURIComponent(asStr(args.domain, "domain"))}`,
      );
      return res;
    },
  }),
  defineTool({
    name: "capix_website_destroy",
    description:
      "Destroy a website project and all its deployments. Billable; requires approval.",
    scope: "website",
    ...BILLABLE,
    inputShape: {
      siteId: siteIdShape,
      reason: z.string().optional(),
    },
    outputShape: siteResultShape,
    handler: async (args, { client, ctx }) =>
      callBillable(
        client,
        ctx.approvalToken,
        `/api/v1/website/sites/${encodeURIComponent(asStr(args.siteId, "siteId"))}/destroy`,
        args.reason ? { reason: args.reason } : undefined,
      ),
  }),
];

// ===========================================================================
// Aggregate export
// ===========================================================================

export const TOOLS: ToolDef[] = [
  ...discoveryTools,
  ...planningTools,
  ...lifecycleTools,
  ...networkingTools,
  ...testingTools,
  ...verificationTools,
  ...websiteTools,
  ...infraContextTools,
];

export const TOOL_NAMES: string[] = TOOLS.map((t) => t.name);

export const TOOL_COUNT = TOOLS.length;

/** Map of tool name → definition, used by the server for O(1) lookup. */
export const TOOL_MAP: Map<string, ToolDef> = new Map(TOOLS.map((t) => [t.name, t]));

export { discoveryTools, planningTools, lifecycleTools, networkingTools, testingTools, verificationTools, websiteTools, infraContextTools };
