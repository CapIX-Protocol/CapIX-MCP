/**
 * Capix MCP Server — the allowlist of REAL control-plane route families.
 *
 * Encoded from the 2026-07 live audit of the protocol repo
 * (app/api/v1/* in CapIX-Protocol): every entry below is backed by a route
 * handler that exists in the control plane today. The registry gate
 * (tools/registry.test.ts) asserts that every registered tool's `routePath`
 * starts with one of these families — this is the anti-regression guard that
 * keeps phantom tools (tools pointing at routes the backend never
 * implemented) out of the MCP surface.
 *
 * When the control plane ships a new route family, add it here WITH the
 * backend evidence (route file path) in the comment, then add the tool.
 *
 * Evidence pointers are relative to the protocol repo root.
 */

export interface RouteFamily {
  /** Canonical path prefix, e.g. "/api/v1/jobs". */
  prefix: string;
  /** Route file(s) in the protocol repo proving the family exists. */
  evidence: string;
}

export const REAL_ROUTE_FAMILIES: readonly RouteFamily[] = [
  // GET /api/v1/account re-exports GET /api/v1/me (account/route.ts).
  { prefix: "/api/v1/account", evidence: "app/api/v1/account/route.ts" },
  // GET /api/v1/billing — balances, valuation, transactions (billing/route.ts).
  { prefix: "/api/v1/billing", evidence: "app/api/v1/billing/route.ts" },
  // GET /api/v1/catalog/capabilities — workload types + providers (public).
  { prefix: "/api/v1/catalog/capabilities", evidence: "app/api/v1/catalog/capabilities/route.ts" },
  // GET/POST /api/v1/deployments, GET/PATCH/DELETE /api/v1/deployments/[id].
  { prefix: "/api/v1/deployments", evidence: "app/api/v1/deployments/route.ts + [id]/route.ts" },
  // GET /api/v1/health — service status + feature gates (public).
  { prefix: "/api/v1/health", evidence: "app/api/v1/health/route.ts" },
  // POST /api/v1/images — text-to-image (billable).
  { prefix: "/api/v1/images", evidence: "app/api/v1/images/route.ts" },
  // POST/GET /api/v1/jobs (+ [id]/cancel, [id]/logs, [id]/rerun).
  { prefix: "/api/v1/jobs", evidence: "app/api/v1/jobs/route.ts + [id]/{cancel,logs,rerun}/route.ts" },
  // GET /api/v1/marketplace/offers — provider-anonymized capacity offers (public).
  { prefix: "/api/v1/marketplace/offers", evidence: "app/api/v1/marketplace/offers/route.ts" },
  // GET/POST /api/v1/memes, GET /api/v1/memes/[id].
  { prefix: "/api/v1/memes", evidence: "app/api/v1/memes/route.ts + [id]/route.ts" },
  // GET /api/v1/models — public catalog + owned private endpoints.
  { prefix: "/api/v1/models", evidence: "app/api/v1/models/route.ts" },
  // GET/POST /api/v1/operations/[id] (POST = cancel), GET [id]/events.
  { prefix: "/api/v1/operations", evidence: "app/api/v1/operations/[id]/route.ts" },
  // GET/POST /api/v1/quotes (GET requires ?quoteId=).
  { prefix: "/api/v1/quotes", evidence: "app/api/v1/quotes/route.ts" },
  // GET/POST /api/v1/receipts — work receipts (list/create only; no [id] route).
  { prefix: "/api/v1/receipts", evidence: "app/api/v1/receipts/route.ts" },
  // GET /api/v1/route-receipts/[id] — signed placement receipt (by-id only).
  { prefix: "/api/v1/route-receipts", evidence: "app/api/v1/route-receipts/[id]/route.ts" },
  // POST/GET /api/v1/training, GET [id], POST [id]/deploy.
  { prefix: "/api/v1/training", evidence: "app/api/v1/training/route.ts + [id]/{route,deploy/route}.ts" },
  // POST/GET /api/v1/agent-deploys, GET/DELETE [id].
  { prefix: "/api/v1/agent-deploys", evidence: "app/api/v1/agent-deploys/route.ts + [id]/route.ts" },
  // POST/GET /api/v1/websites, GET/DELETE [id], POST [id]/promote|rollback.
  { prefix: "/api/v1/websites", evidence: "app/api/v1/websites/route.ts + [id]/route.ts" },
] as const;

/**
 * Route families that were advertised by pre-repair tools but DO NOT EXIST
 * in the control plane (verified 2026-07 against app/api/v1/). Tools were
 * removed from the registry; they return when the backend ships. Listed here
 * so the gate test can also assert no tool regresses onto them.
 *
 *   /api/v1/website (singular)     — real family is /api/v1/websites (plural)
 *   /api/v1/networking, /api/v1/vpc — networking roadmap N1–N5, not built
 *   /api/v1/verification, /api/v1/attestations — Secured Cloud (TEE/zkVM) deferred
 *   /api/v1/testing                — disposable test envs, not built
 *   /api/v1/planning               — superseded by /api/v1/quotes
 *   /api/v1/lifecycle              — superseded by /api/v1/deployments (+PATCH)
 *   /api/v1/projects               — no projects list route exists
 *   /api/v1/catalog/compute, /api/v1/catalog/models — real: catalog/capabilities, models
 *   /api/v1/network/status         — real: /api/v1/health
 *   /api/v1/account/balance        — real: /api/v1/billing
 *   /api/v1/nodes/status, /api/v1/earnings — only nodes/[id]/earnings exists
 */
export const REMOVED_ROUTE_FAMILIES: readonly string[] = [
  "/api/v1/website",
  "/api/v1/networking",
  "/api/v1/vpc",
  "/api/v1/verification",
  "/api/v1/attestations",
  "/api/v1/testing",
  "/api/v1/planning",
  "/api/v1/lifecycle",
  "/api/v1/projects",
  "/api/v1/catalog/compute",
  "/api/v1/catalog/models",
  "/api/v1/network",
  "/api/v1/account/balance",
  "/api/v1/nodes",
  "/api/v1/earnings",
] as const;

/** True when `path` (may contain :params) targets a real route family. */
export function isRealRoutePath(path: string): boolean {
  return REAL_ROUTE_FAMILIES.some(
    ({ prefix }) => path === prefix || path.startsWith(`${prefix}/`),
  );
}

/** True when `path` targets a family removed because the backend never existed. */
export function isRemovedRoutePath(path: string): boolean {
  return REMOVED_ROUTE_FAMILIES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}
