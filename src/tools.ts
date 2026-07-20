/**
 * Capix MCP Server — all 37 tool definitions.
 *
 * 2026-07 repair: every tool below targets a route family that EXISTS in the
 * control plane (app/api/v1/* in the protocol repo), verified route-by-route
 * against the live source. Each tool declares its canonical path (`routePath`)
 * and the registry gate (tools/registry.test.ts) asserts it against the
 * allowlist in route-families.ts — no phantom routes can be re-introduced.
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
 * Tools are grouped by scope:
 *   discovery (7) · planning (2) · lifecycle (19) · verification (1) ·
 *   website (6) · infra-context (2)
 * (The factory tools — jobs/training/agent-deploys — live in
 * tools/factory.ts and join lifecycle; the meme/image tools live in
 * tools/memes.ts: the meme catalog joins discovery, the two billable
 * generators join lifecycle.)
 *
 * Removed in the repair (no backing route in the control plane — hidden, not
 * deleted from git history):
 *   - networking scope (8 tools): /api/v1/networking/* and /api/v1/vpc do not
 *     exist. Returns with the networking roadmap (N1–N5).
 *   - testing scope (6 tools): /api/v1/testing/* does not exist (disposable
 *     test envs are not built).
 *   - attestation/zkVM/measurement tools (5): /api/v1/verification/* and
 *     /api/v1/attestations do not exist. Secured Cloud (TEE/zkVM) is deferred.
 *   - planning stubs (capix_compute_plan, capix_model_plan, capix_stack_*):
 *     /api/v1/planning/* does not exist; quoting lives at /api/v1/quotes.
 *   - lifecycle stubs (capix_start/stop/restart/extend): start/stop exist
 *     upstream ONLY as PATCH /api/v1/deployments/[id] { desiredState } with a
 *     mandatory If-Match etag — unreachable through the current client
 *     surface (no PATCH, no etag access). Restart/extend have no backend.
 *   - discovery stubs: capix_projects (no /api/v1/projects),
 *     capix_model_catalog (real catalog is /api/v1/models, covered by
 *     capix_model_list), capix_attestations (Secured Cloud deferred).
 *   - website stubs (12 tools): singular /api/v1/website/* never existed and
 *     detect/plan/quote/deploy/preview/deployments/logs/metrics/domains have
 *     no routes under the real /api/v1/websites family (build logs surface as
 *     `logTail` inside capix_website_get; previews are implicit per release).
 *   - infra-context stubs: capix_node_status, capix_earnings_check (no
 *     /api/v1/nodes/status or /api/v1/earnings), capix_deployment_list
 *     (duplicate of capix_deployments).
 */

import { z } from "zod";
import type { ToolDef } from "./types.js";
import {
  APPROVAL_ONLY,
  BILLABLE,
  READ_ONLY,
} from "./types.js";
import { defineTool } from "./tools/define-tool.js";
import { defineGeneratedTool } from "./tools/generate.js";
import { factoryTools } from "./tools/factory.js";
import { infraContextTools } from "./tools/infra-context.js";
import { memeImageTools } from "./tools/memes.js";

// ===========================================================================
// Reusable Zod fragments
// ===========================================================================

const iso8601 = z.string().datetime().or(z.string());

const deploymentIdShape = z.string().describe("Canonical deployment id (dep_…).");
const operationIdShape = z.string().describe("Canonical operation id (op_…).");
const quoteIdShape = z.string().describe("Canonical quote id from capix_compute_quote / capix_model_quote.");
const siteIdShape = z.string().describe("Capix website id.");

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

// ===========================================================================
// Discovery tools (6) — read-only, auto-run after authentication.
// (capix_meme_templates from tools/memes.ts is the 7th discovery tool.)
// ===========================================================================

const discoveryTools: ToolDef[] = [
  defineTool({
    name: "capix_account",
    description:
      "Inspect the authenticated account: id, email, wallet address, billing status, identities, devices. Read-only — safe to auto-run.",
    scope: "discovery",
    ...READ_ONLY,
    routePath: "/api/v1/account",
    inputShape: {},
    outputShape: {
      id: z.string().optional(),
      email: z.string().optional(),
      wallet_address: z.string().optional(),
      billing_status: z.string().optional(),
      identities: z.array(z.record(z.unknown())).optional(),
      devices: z.array(z.record(z.unknown())).optional(),
    },
    handler: async (_args, { client }) =>
      client.get<Record<string, unknown>>("/api/v1/account"),
  }),
  defineTool({
    name: "capix_balance",
    description:
      "Get the account balances (SOL / USDC ledger), USD valuation, and recent transactions. Read-only.",
    scope: "discovery",
    ...READ_ONLY,
    routePath: "/api/v1/billing",
    inputShape: {
      asset: z.enum(["SOL", "USDC", "USD-credit"]).optional().describe("Optional asset filter."),
    },
    outputShape: {
      ok: z.boolean().optional(),
      accountId: z.string().optional(),
      balances: z.record(z.unknown()).optional(),
      valuation: z.record(z.unknown()).optional(),
      transactions: z.array(z.record(z.unknown())).optional(),
      nextCursor: z.string().optional(),
    },
    handler: async (args, { client }) =>
      client.get<Record<string, unknown>>("/api/v1/billing", {
        asset: args.asset,
      }),
  }),
  defineTool({
    name: "capix_compute_catalog",
    description:
      "List the enabled compute capability catalog: workload types (with features) and " +
      "configured providers/regions. Public; reflects live feature gates. Read-only.",
    scope: "discovery",
    ...READ_ONLY,
    routePath: "/api/v1/catalog/capabilities",
    inputShape: {},
    outputShape: {
      workloadTypes: z.array(z.record(z.unknown())).optional(),
      providers: z.array(z.record(z.unknown())).optional(),
      regions: z.array(z.string()).optional(),
      releaseId: z.string().optional(),
      timestamp: iso8601.optional(),
    },
    handler: async (_args, { client }) =>
      client.get<Record<string, unknown>>("/api/v1/catalog/capabilities"),
  }),
  defineTool({
    name: "capix_network_status",
    description:
      "Inspect the Capix service health: status, version, release, and live feature gates " +
      "(real money, provider writes, distributed, smart router, …). Public. Read-only.",
    scope: "discovery",
    ...READ_ONLY,
    routePath: "/api/v1/health",
    inputShape: {},
    outputShape: {
      status: z.string().optional(),
      service: z.string().optional(),
      version: z.string().optional(),
      releaseId: z.string().optional(),
      features: z.record(z.unknown()).optional(),
      timestamp: iso8601.optional(),
    },
    handler: async (_args, { client }) =>
      client.get<Record<string, unknown>>("/api/v1/health"),
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
      limit: z.number().int().min(1).max(100).default(25).describe("Max deployments to return (upstream bounds)."),
      status: z.string().optional().describe("Optional phase filter (the upstream query param is `status`)."),
      cursor: z.string().optional().describe("Opaque pagination cursor from a previous page."),
      projectId: z.string().optional(),
    },
    outputShape: {
      data: z.array(z.record(z.unknown())).optional(),
      cursor: z.string().optional(),
      hasMore: z.boolean().optional(),
    },
  }),
  defineGeneratedTool({
    name: "capix_receipts",
    description:
      "List work receipts (task/commit approval records) for the account. Read-only.",
    scope: "discovery",
    ...READ_ONLY,
    method: "GET",
    path: "/api/v1/receipts",
    input: {
      limit: z.number().int().min(1).max(100).default(25),
      approvalStatus: z.string().optional().describe("Optional approval-status filter."),
      agentId: z.string().optional().describe("Optional agent filter."),
      cursor: z.string().optional(),
      projectId: z.string().optional(),
    },
    outputShape: {
      data: z.array(z.record(z.unknown())).optional(),
      cursor: z.string().optional(),
      hasMore: z.boolean().optional(),
    },
  }),
];

// ===========================================================================
// Planning tools (2) — read-only quoting against POST /api/v1/quotes.
// The old /api/v1/planning/* family does not exist; the canonical quote route
// is /api/v1/quotes (15-minute TTL, locks price/cost/fees/margin/FX/expiry).
// The route REQUIRES an Idempotency-Key header even though quoting moves no
// money, so both tools post with the client's idempotency key.
// ===========================================================================

/** Workload types accepted by POST /api/v1/quotes (workloadSpec.type). */
const WORKLOAD_TYPES = [
  "dedicated_machine.v1",
  "private_inference.v1",
  "remote_workspace.v1",
  "replicated_service.v1",
  "sharded_batch.v1",
  "agent_run.v1",
] as const;

const quoteResultShape = {
  id: quoteIdShape.optional(),
  price: z.record(z.unknown()).optional(),
  providerCostBasis: z.record(z.unknown()).optional(),
  fees: z.record(z.unknown()).optional(),
  margin: z.record(z.unknown()).optional(),
  expiresAt: iso8601.optional(),
  state: z.string().optional(),
} satisfies Record<string, z.ZodTypeAny>;

const planningTools: ToolDef[] = [
  defineGeneratedTool({
    name: "capix_compute_quote",
    description:
      "Get a canonical quote for a compute workload (locks price/fees/FX/expiry for 15 min). " +
      "Read-only intent; the quote route still requires an Idempotency-Key, which the client supplies.",
    scope: "planning",
    ...READ_ONLY,
    method: "POST",
    path: "/api/v1/quotes",
    // Read-only, but the route rejects requests without an Idempotency-Key.
    idempotent: true,
    input: {
      workloadSpec: z
        .object({
          type: z.enum(WORKLOAD_TYPES),
          cpu: z.number().positive(),
          ramMb: z.number().positive(),
          storageGb: z.number().min(0),
          gpu: z.number().min(0).optional(),
          vramMb: z.number().min(0).optional(),
          region: z.string().optional().describe("eu | us | asia | global."),
          maxDurationHours: z.number().optional(),
          maxSpendUsd: z.number().optional(),
        })
        .describe("Workload shape quoted upstream."),
      placementPolicy: z.record(z.unknown()).optional(),
      paymentAsset: z.enum(["AUTO", "SOL", "USDC"]).optional(),
      projectId: z.string().optional(),
    },
    outputShape: quoteResultShape,
  }),
  defineTool({
    name: "capix_model_quote",
    description:
      "Get a canonical quote for a private model endpoint (private_inference.v1) hosting " +
      "the given model. Read-only intent; the quote route still requires an Idempotency-Key, " +
      "which the client supplies.",
    scope: "planning",
    ...READ_ONLY,
    routePath: "/api/v1/quotes",
    inputShape: {
      modelId: z.string().describe("Model id from capix_model_list."),
      cpu: z.number().positive().describe("vCPUs for the endpoint (required upstream)."),
      ramMb: z.number().positive().describe("RAM for the endpoint (required upstream)."),
      storageGb: z.number().min(0).describe("Storage for weights/cache (required upstream)."),
      gpu: z.number().int().min(1).optional(),
      vramMb: z.number().int().min(0).optional(),
      region: z.string().optional().describe("eu | us | asia | global."),
      maxDurationHours: z.number().optional(),
      paymentAsset: z.enum(["AUTO", "SOL", "USDC"]).optional(),
      projectId: z.string().optional(),
    },
    outputShape: quoteResultShape,
    handler: async (args, { client }) =>
      client.post<Record<string, unknown>>(
        "/api/v1/quotes",
        {
          workloadSpec: {
            type: "private_inference.v1",
            cpu: args.cpu,
            ramMb: args.ramMb,
            storageGb: args.storageGb,
            gpu: args.gpu,
            vramMb: args.vramMb,
            region: args.region,
            maxDurationHours: args.maxDurationHours,
            payload: { modelId: asStr(args.modelId, "modelId"), source: "capix-mcp" },
          },
          paymentAsset: args.paymentAsset,
          projectId: args.projectId,
        },
        { idempotent: true },
      ),
  }),
];

// ===========================================================================
// Lifecycle tools (3 here) — billable mutations, require approval.
// The factory tools (jobs/training/agent-deploys, tools/factory.ts) and the
// two meme/image generators (tools/memes.ts) join this scope: 19 total.
//
// Removed: capix_start / capix_stop / capix_restart / capix_extend.
// Start/stop exist upstream ONLY as PATCH /api/v1/deployments/[id]
// { desiredState: "RUNNING" | "STOPPED" } with a mandatory If-Match etag —
// unreachable through the current CapixClientLike surface (no PATCH method,
// no etag access). Restart/extend have no backend at all. They return when
// the client grows PATCH+etag support (see route-families.ts).
// ===========================================================================

const deploymentResultShape = {
  operation: z.record(z.unknown()).optional().describe("Long-running operation (poll via its id)."),
  deployment: z.record(z.unknown()).optional(),
  settlement: z.record(z.unknown()).optional().describe("Early-termination settlement, when applicable."),
} satisfies Record<string, z.ZodTypeAny>;

const lifecycleTools: ToolDef[] = [
  defineGeneratedTool({
    name: "capix_deploy",
    description:
      "Deploy a workload against a canonical quote (from capix_compute_quote / " +
      "capix_model_quote). Takes a ledger hold and returns a long-running operation. " +
      "Billable; requires approval.",
    scope: "lifecycle",
    ...BILLABLE,
    method: "POST",
    path: "/api/v1/deployments",
    input: {
      quoteId: quoteIdShape,
      projectId: z.string().optional(),
    },
    outputShape: deploymentResultShape,
  }),
  defineGeneratedTool({
    name: "capix_delete",
    description:
      "Terminate a deployment and release its allocation (settles early termination). " +
      "Destructive; billable; requires approval.",
    scope: "lifecycle",
    ...BILLABLE,
    method: "DELETE",
    path: "/api/v1/deployments/:id",
    input: {
      id: deploymentIdShape,
    },
    outputShape: deploymentResultShape,
  }),
  defineGeneratedTool({
    name: "capix_cancel",
    description:
      "Cancel an in-flight operation (sets CANCELLING; 409 on terminal states). " +
      "Requires approval to mutate.",
    scope: "lifecycle",
    ...APPROVAL_ONLY,
    method: "POST",
    path: "/api/v1/operations/:operationId",
    input: {
      operationId: operationIdShape,
    },
    outputShape: deploymentResultShape,
  }),
];

// ===========================================================================
// Verification tools (1) — read-only receipt inspection.
// The attestation/zkVM/measurement tools were removed: /api/v1/verification/*
// and /api/v1/attestations do not exist (Secured Cloud deferred — see
// route-families.ts). capix_inspect_receipt survives, retargeted from the
// nonexistent /api/v1/verification/receipts/[id] to the real signed
// route-receipt route (the scheduler's placement receipt tied to a quote:
// customer price, provider cost basis, fees, margin).
// ===========================================================================

const verificationTools: ToolDef[] = [
  defineGeneratedTool({
    name: "capix_inspect_receipt",
    description:
      "Inspect a signed route receipt: the scheduler's placement decision for a quote — " +
      "customer price, provider cost basis, fees, margin, constraints, allocations. Read-only.",
    scope: "verification",
    ...READ_ONLY,
    method: "GET",
    path: "/api/v1/route-receipts/:receiptId",
    input: {
      receiptId: z.string().describe("Route receipt id (returned as x-capix-route-receipt-id with a quote)."),
    },
    outputShape: {
      id: z.string().optional(),
      data: z.record(z.unknown()).optional().describe("RouteReceiptData: workloadType, quoteId, customerPrice, providerCostBasis, fees, margin, allocations, …"),
      signature: z.string().optional(),
      kmsKeyId: z.string().optional(),
    },
  }),
];

// ===========================================================================
// Website tools (6) — static-site hosting on the REAL /api/v1/websites family
// (plural; the singular /api/v1/website/* these tools used to target never
// existed). Real surface (app/api/v1/websites/*):
//   POST   /api/v1/websites            create + build (name, sourceRef, buildCommand?)
//   GET    /api/v1/websites            list (with up to 5 releases each)
//   GET    /api/v1/websites/[id]       detail (releases + 50-line build logTail)
//   POST   /api/v1/websites/[id]/promote   promote a built release to production
//   POST   /api/v1/websites/[id]/rollback  roll back to a previous built release
//   DELETE /api/v1/websites/[id]       destroy (soft)
//
// Known backend gap: promote/rollback are dispatched inside [id]/route.ts on
// the URL suffix, but the App Router has no [id]/promote/route.ts shim or
// rewrite, so those paths 404 until the control plane adds the segment
// shims. The tools are registered against the documented contract (the route
// file's own header advertises the paths) — track the backend fix before
// relying on them.
//
// Removed (no route): check-project-string, detect (worker-internal only),
// plan, quote (no website workload type in /api/v1/quotes), deploy (no
// redeploy route — create builds+deploys), preview (implicit per release),
// deployments (releases are embedded in list/get), logs (logTail in get),
// metrics, domain add/verify/remove (wildcard *.capix.dev not live yet).
// ===========================================================================

const websiteObjectShape = z
  .record(z.unknown())
  .describe(
    "Website: id, name, slug, status (building|preview|live|failed|destroyed), sourceRef, " +
      "previewUrl, productionUrl, futureUrls, releases[{id, contentHash, status, step, error, createdAt, url}], createdAt.",
  );

const websiteTools: ToolDef[] = [
  defineGeneratedTool({
    name: "capix_website_create",
    description:
      "Create a website from a source ref (repo/archive URL): clones, detects the framework " +
      "server-side, builds, and serves a preview release. Billable; requires approval.",
    scope: "website",
    ...BILLABLE,
    method: "POST",
    path: "/api/v1/websites",
    input: {
      name: z.string().min(1).describe("Site name (required upstream; slugified, unique per account)."),
      sourceRef: z.string().min(1).describe("Source reference (repository/archive URL). Required upstream."),
      buildCommand: z.string().optional().describe("Optional build command override (auto-detected when omitted)."),
      projectId: z.string().optional(),
    },
    outputShape: {
      website: websiteObjectShape.optional(),
    },
  }),
  defineGeneratedTool({
    name: "capix_website_list",
    description: "List the account's websites with their latest releases. Read-only.",
    scope: "website",
    ...READ_ONLY,
    method: "GET",
    path: "/api/v1/websites",
    input: {},
    outputShape: {
      websites: z.array(z.record(z.unknown())).optional(),
    },
  }),
  defineGeneratedTool({
    name: "capix_website_get",
    description:
      "Get a website by id: status, URLs, and the last 20 releases including per-release " +
      "build step, error, and a 50-line build log tail. Read-only.",
    scope: "website",
    ...READ_ONLY,
    method: "GET",
    path: "/api/v1/websites/:id",
    input: {
      id: siteIdShape,
    },
    outputShape: {
      website: websiteObjectShape.optional(),
    },
  }),
  defineGeneratedTool({
    name: "capix_website_promote",
    description:
      "Promote a built release to production (defaults to the latest release). " +
      "NOTE: depends on a pending control-plane route shim for /promote — see tools.ts. " +
      "Requires approval.",
    scope: "website",
    ...BILLABLE,
    method: "POST",
    path: "/api/v1/websites/:id/promote",
    input: {
      id: siteIdShape,
      releaseId: z.string().optional().describe("Release to promote; defaults to the latest built release."),
    },
    outputShape: {
      ok: z.boolean().optional(),
      productionUrl: z.string().optional(),
      releaseId: z.string().optional(),
    },
  }),
  defineGeneratedTool({
    name: "capix_website_rollback",
    description:
      "Roll a website back to a previous built release (defaults to the last built release " +
      "before the current production one). NOTE: depends on a pending control-plane route " +
      "shim for /rollback — see tools.ts. Requires approval.",
    scope: "website",
    ...BILLABLE,
    method: "POST",
    path: "/api/v1/websites/:id/rollback",
    input: {
      id: siteIdShape,
      releaseId: z.string().optional().describe("Release to restore; defaults to the previous built release."),
    },
    outputShape: {
      ok: z.boolean().optional(),
      productionUrl: z.string().optional(),
      releaseId: z.string().optional(),
      rolledBack: z.boolean().optional(),
    },
  }),
  defineGeneratedTool({
    name: "capix_website_destroy",
    description:
      "Destroy a website (soft delete; releases stop serving). Destructive; requires approval.",
    scope: "website",
    ...BILLABLE,
    method: "DELETE",
    path: "/api/v1/websites/:id",
    input: {
      id: siteIdShape,
    },
    outputShape: {
      ok: z.boolean().optional(),
      id: z.string().optional(),
      status: z.string().optional(),
    },
  }),
];

// ===========================================================================
// Aggregate export
// ===========================================================================

export const TOOLS: ToolDef[] = [
  ...discoveryTools,
  ...planningTools,
  ...lifecycleTools,
  ...verificationTools,
  ...websiteTools,
  ...factoryTools,
  ...infraContextTools,
  ...memeImageTools,
];

export const TOOL_NAMES: string[] = TOOLS.map((t) => t.name);

export const TOOL_COUNT = TOOLS.length;

/** Map of tool name → definition, used by the server for O(1) lookup. */
export const TOOL_MAP: Map<string, ToolDef> = new Map(TOOLS.map((t) => [t.name, t]));

export { discoveryTools, planningTools, lifecycleTools, verificationTools, websiteTools, factoryTools, infraContextTools, memeImageTools };
