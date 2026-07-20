/**
 * Capix MCP Server — infra-context tools (2).
 *
 * Read-only live views over the customer's Capix infrastructure footprint.
 * Every tool is read-only — safe to auto-run after authentication — and
 * delegates to a canonical `/api/v1/*` route that EXISTS in the control
 * plane (verified 2026-07; see ../route-families.ts):
 *
 *   capix_marketplace_browse  GET /api/v1/marketplace/offers  live GPU offers (public)
 *   capix_model_list          GET /api/v1/models              deployable model catalog
 *
 * Removed in the 2026-07 repair (no backing route in the control plane):
 *   capix_node_status      — there is no /api/v1/nodes/status (only
 *                            nodes/[id]/earnings and nodes/[id]/conformance)
 *   capix_earnings_check   — there is no /api/v1/earnings aggregate route
 *   capix_deployment_list  — duplicated capix_deployments once both were
 *                            aligned to the real GET /api/v1/deployments
 *                            contract (status/cursor/limit, no phase/include)
 *
 * This module shares `defineTool` with the aggregate registry in ../tools.ts
 * via ./define-tool.js (a leaf module), so there is no import cycle. The
 * small Zod shapes below are re-declared locally to keep the module
 * self-contained.
 */

import { z } from "zod";
import { defineTool } from "./define-tool.js";
import { defineGeneratedTool } from "./generate.js";
import { READ_ONLY } from "../types.js";
import type { ToolDef } from "../types.js";

// ===========================================================================
// Local Zod fragments (mirror tools.ts — keep in sync)
// ===========================================================================

const iso8601 = z.string().datetime().or(z.string());

const listResultShape = {
  entries: z.array(z.record(z.unknown())).optional().describe("Paginated item array."),
  nextCursor: z.string().optional().describe("Opaque cursor for the next page; absent when exhausted."),
  fetchedAt: iso8601.optional().describe("ISO8601 fetch timestamp."),
} satisfies Record<string, z.ZodTypeAny>;

// ===========================================================================
// Infra-context tools (2) — read-only infra visibility for agents.
// ===========================================================================

export const infraContextTools: ToolDef[] = [
  defineTool({
    name: "capix_marketplace_browse",
    description:
      "Browse live GPU marketplace offers (provider-anonymized: region, trust tier, capability, price/hr, health score). Read-only.",
    scope: "infra-context",
    ...READ_ONLY,
    routePath: "/api/v1/marketplace/offers",
    inputShape: {
      gpuModel: z.string().optional().describe("Optional GPU model filter (e.g. A100, H100)."),
      region: z.string().optional().describe("Optional region filter."),
      trustTier: z
        .enum(["community", "verified", "sovereign"])
        .optional()
        .describe("Optional trust tier filter."),
      capability: z
        .enum(["cpu", "gpu", "gpu_high_mem", "secure_enclave", "quantum_sim"])
        .optional()
        .describe("Optional capability filter."),
      limit: z.number().int().min(1).max(200).default(50).describe("Max offers to return (upstream bounds)."),
      cursor: z.string().optional().describe("Opaque pagination cursor from a previous page."),
    },
    outputShape: listResultShape,
    handler: async (args, { client }) =>
      client.get<Record<string, unknown>>("/api/v1/marketplace/offers", {
        gpuModel: args.gpuModel,
        region: args.region,
        trustTier: args.trustTier,
        capability: args.capability,
        limit: args.limit,
        cursor: args.cursor,
      }),
  }),
  defineGeneratedTool({
    name: "capix_model_list",
    description:
      "List deployable models: the public Capix catalog plus the caller's ready private " +
      "endpoints (id, label, category, context window, pricing, availability). Read-only.",
    scope: "infra-context",
    ...READ_ONLY,
    method: "GET",
    path: "/api/v1/models",
    input: {
      projectId: z.string().optional().describe("Optional project id (the only query param the route accepts)."),
    },
    outputShape: {
      models: z.array(z.record(z.unknown())).optional(),
      projectId: z.string().optional(),
    },
  }),
];

export const INFRA_CONTEXT_TOOL_NAMES: string[] = infraContextTools.map((t) => t.name);
