/**
 * Capix MCP Server — infra-context tools (5).
 *
 * Read-only live views over the customer's Capix infrastructure footprint,
 * mirroring the IDE assistant's infra panel (marketplace offers, node health,
 * earnings, model catalog, deployment inventory). Every tool is read-only —
 * safe to auto-run after authentication — and delegates to the canonical
 * `/api/v1/*` routes through the shared Capix client.
 *
 *   capix_marketplace_browse  live GPU marketplace offers        (read-only)
 *   capix_node_status         per-node liveness / health         (read-only)
 *   capix_earnings_check      wallet + dev-token earnings        (read-only)
 *   capix_model_list          deployable model catalog           (read-only)
 *   capix_deployment_list     deployment inventory + health      (read-only)
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

const moneyShape = z.object({
  amount: z.string().describe("Integer minor units (e.g. lamports, micro-USDC, cents)."),
  asset: z.enum(["SOL", "USDC", "USD-credit"]),
  scale: z.number().int(),
}).describe("Integer minor/native money amount serialized as a JSON string.");

const deploymentIdShape = z.string().describe("Canonical deployment id (dep_…).");

const listResultShape = {
  entries: z.array(z.record(z.unknown())).optional().describe("Paginated item array."),
  nextCursor: z.string().optional().describe("Opaque cursor for the next page; absent when exhausted."),
  fetchedAt: iso8601.optional().describe("ISO8601 fetch timestamp."),
} satisfies Record<string, z.ZodTypeAny>;

// ===========================================================================
// Infra-context tools (5) — read-only infra visibility for agents.
// ===========================================================================

export const infraContextTools: ToolDef[] = [
  defineTool({
    name: "capix_marketplace_browse",
    description:
      "Browse live GPU marketplace offers (gpu, vram, price/hr, location, reliability), cheapest first. Read-only.",
    scope: "infra-context",
    ...READ_ONLY,
    inputShape: {
      gpu: z.string().optional().describe("Optional GPU model filter (e.g. A100, H100)."),
      region: z.string().optional().describe("Optional region filter."),
      limit: z.number().int().min(1).max(200).default(50).describe("Max offers to return."),
    },
    outputShape: listResultShape,
    handler: async (args, { client }) =>
      client.get<Record<string, unknown>>("/api/v1/marketplace/offers", {
        gpu: args.gpu,
        region: args.region,
        limit: args.limit,
      }),
  }),
  defineTool({
    name: "capix_node_status",
    description:
      "Show liveness and health for every node across the account's deployments. Read-only.",
    scope: "infra-context",
    ...READ_ONLY,
    inputShape: {
      deploymentId: deploymentIdShape.optional().describe("Optional deployment filter."),
    },
    outputShape: {
      ...listResultShape,
      summary: z
        .object({
          total: z.number().int().optional(),
          online: z.number().int().optional(),
          offline: z.number().int().optional(),
        })
        .optional()
        .describe("Aggregate liveness counts across the returned nodes."),
    },
    handler: async (args, { client }) =>
      client.get<Record<string, unknown>>("/api/v1/nodes/status", {
        deploymentId: args.deploymentId,
      }),
  }),
  defineTool({
    name: "capix_earnings_check",
    description:
      "Check the earnings dashboard: wallet balance, total spend, active deployments and dev-token earnings. Read-only.",
    scope: "infra-context",
    ...READ_ONLY,
    inputShape: {},
    outputShape: {
      wallet: moneyShape.optional(),
      totalSpent: moneyShape.optional(),
      activeDeployments: z.number().int().optional(),
      devTokenBalance: z.number().optional(),
      devTokenTotalEarned: z.number().optional(),
      asOf: iso8601.optional(),
    },
    handler: async (_args, { client }) =>
      client.get<Record<string, unknown>>("/api/v1/earnings"),
  }),
  defineGeneratedTool({
    name: "capix_model_list",
    description:
      "List deployable models from the Capix catalog (id, label, category, parameter count, min VRAM). Read-only.",
    scope: "infra-context",
    ...READ_ONLY,
    method: "GET",
    path: "/api/v1/models",
    input: {
      category: z.string().optional().describe("Optional category filter (e.g. chat, code, embedding)."),
      limit: z.number().int().min(1).max(200).default(100).describe("Max models to return."),
    },
    outputShape: {
      ...listResultShape,
      catalogVersion: z.string().optional(),
    },
  }),
  defineTool({
    name: "capix_deployment_list",
    description:
      "List the deployment inventory with live status, health and hourly cost. Read-only.",
    scope: "infra-context",
    ...READ_ONLY,
    inputShape: {
      limit: z.number().int().min(1).max(200).default(50).describe("Max deployments to return."),
      phase: z.string().optional().describe("Optional DeploymentPhase filter."),
      includeNodes: z
        .boolean()
        .default(false)
        .describe("When true, embed per-node health for each deployment."),
    },
    outputShape: listResultShape,
    handler: async (args, { client }) =>
      client.get<Record<string, unknown>>("/api/v1/deployments", {
        limit: args.limit,
        phase: args.phase,
        include: args.includeNodes ? "nodes,health" : undefined,
      }),
  }),
];

export const INFRA_CONTEXT_TOOL_NAMES: string[] = infraContextTools.map((t) => t.name);
