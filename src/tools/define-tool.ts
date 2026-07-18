/**
 * Capix MCP Server — the type-safe tool declaration helper.
 *
 * Extracted from tools.ts so sibling tool modules (tools/infra-context.ts)
 * can declare tools without creating a module cycle with the aggregate
 * registry in tools.ts.
 */

import { z } from "zod";
import type { ToolDef, ToolDeps } from "../types.js";

/**
 * Declare a Capix tool with a Zod raw input shape. The handler receives
 * Zod-validated arguments (typed via inference) plus the Capix API client and
 * call context; it returns the upstream JSON object as structured content.
 */
export function defineTool<S extends z.ZodRawShape>(opts: {
  name: string;
  description: string;
  scope: ToolDef["scope"];
  billable: boolean;
  requiresApproval: boolean;
  inputShape: S;
  outputShape?: Record<string, z.ZodTypeAny>;
  handler: (
    args: { [K in keyof S]: z.output<S[K]> },
    deps: ToolDeps,
  ) => Promise<Record<string, unknown>>;
}): ToolDef {
  return {
    name: opts.name,
    description: opts.description,
    scope: opts.scope,
    billable: opts.billable,
    requiresApproval: opts.requiresApproval,
    inputShape: opts.inputShape,
    outputShape: opts.outputShape,
    // Sound cast: the McpServer validates args against inputShape before
    // invoking the handler, so the inferred arg shape is guaranteed at runtime.
    handler: opts.handler as ToolDef["handler"],
  };
}
