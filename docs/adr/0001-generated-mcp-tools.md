# ADR 0001: Generated MCP tools, toward control-plane-declared tool specs

- Status: Accepted (phase 1 implemented; phases 2–3 documented, not built)
- Date: 2026-07-19

## Context

capix-mcp ships 64 tools. Historically every tool was hand-written: a Zod
input shape plus a handler that translates args into a canonical `/api/v1/*`
call. When the control-plane API changes (a field renamed, a path moved, a
query param added), the hand-written tool silently goes stale — the drift is
only discovered when an agent's call fails in production.

OpenShip (https://github.com/oblien/openship, Apache-2.0) solves the same
problem by inverting the relationship: HTTP routes declare an opt-in `mcp`
block (description + body schema) co-located with the handler, and the MCP
server *generates* its tools from the route registry. A route and its tool
can never disagree because the tool is derived from the route.

## Decision

Adopt the pattern in two stages.

**Phase 1 (implemented).** A declarative generator inside this package
(`src/tools/generate.ts`, `defineGeneratedTool`). Each spec declares —
exactly once — the name, description, method, canonical `/api/v1/*` path
(with `:params`), typed Zod input shape, and idempotency behavior. The
generator derives both the MCP registration (a plain `ToolDef`,
indistinguishable from a hand-written one) and the HTTP dispatch. The
generator enforces existing repo conventions rather than inventing new ones:

- problem+json (RFC 9457) passthrough via the shared `CapixClient` /
  `CapixApiError` — generated handlers never catch or rewrite errors;
- deterministic `Idempotency-Key` headers for mutations, reusing the
  path+body-hash derivation already in `client.ts`
  (`post(..., { idempotent: true })`, `delete`);
- Zod-typed inputs validated by the McpServer before dispatch;
- the `approval_required` (402) gate for billable / approval-requiring tools;
- declaration-time rejection of specs whose path params are not declared in
  the input shape, so a broken spec fails at module load, not at call time.

Eight CRUD-shaped tools were migrated as proof; the remaining 56 hand-written
tools are untouched and keep working. All tools — generated or not — remain
statically declared in this repo, so the published tool surface is still
reviewable in a single diff.

**Phase 2 (future).** Migrate every remaining CRUD-shaped tool to
`defineGeneratedTool`. Tools with non-trivial handler logic (approval
choreography beyond the gate, response reshaping, multi-call fan-out) may
stay hand-written permanently; the generator is for the honest CRUD majority,
not a straitjacket.

**Phase 3 (future, the OpenShip end-state).** Control-plane routes declare
their own `mcp` blocks (description + input schema + idempotency/approval
hints) next to their handlers, and the backend exposes them at
`GET /api/v1/mcp-tools`. capix-mcp then introspects that endpoint at startup
and generates its tools from the payload, falling back to the static specs in
this repo when the endpoint is unreachable or the server predates it. At that
point the spec of record lives beside the route it describes — drift becomes
impossible by construction, and this package's static specs become a
versioned compatibility floor, not the source of truth.

## Consequences

- New CRUD tools are one declaration instead of a declaration plus a handler;
  the path and the call can no longer disagree.
- The phase-3 introspection protocol (`/api/v1/mcp-tools` payload shape,
  cache/refresh policy, version negotiation) is deliberately **not** designed
  here — it is a control-plane change and needs its own ADR there.
- Pattern adapted from OpenShip (Apache-2.0); see `NOTICE` and the header of
  `src/tools/generate.ts` for attribution.
