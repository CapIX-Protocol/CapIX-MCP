/**
 * Capix MCP Server — declarative tool generator.
 *
 * The generation pattern adapted here — declare method + path + input schema
 * ONCE in a tool spec, then derive both the MCP tool registration and the
 * HTTP dispatch from that single declaration — follows the route-registry
 * approach of OpenShip (https://github.com/oblien/openship),
 * apps/api/src/modules/mcp/ (mcp-tools.ts / mcp-dispatch.ts).
 * Copyright the OpenShip contributors, licensed under the Apache License 2.0.
 * See the NOTICE file at the repository root. Only the pattern is adapted;
 * this implementation is original and specific to the Capix control plane.
 *
 * Why this exists: hand-written tools drift when the control-plane API
 * changes. A generated tool keeps the endpoint declaration (method, canonical
 * `/api/v1/*` path, typed Zod input) co-located with the registration, so the
 * MCP surface and the HTTP call can never disagree.
 *
 * The generator enforces the repo's existing control-plane conventions:
 *
 *   - problem passthrough — the handler delegates to the shared CapixClient,
 *     which parses non-2xx responses as problem+json (RFC 9457, which
 *     obsoletes RFC 7807) and throws CapixApiError; the generator never
 *     catches or rewrites it, so problem details reach the server wrapper
 *     (server.ts errorResult) untouched.
 *   - idempotency        — mutation specs (billable / requiresApproval POST or
 *     DELETE) route through the client's existing Idempotency-Key helper
 *     (client.post(..., { idempotent: true }) / client.delete), reusing the
 *     path+body-hash key derivation in client.ts rather than re-inventing it.
 *   - typed inputs       — inputs are declared as a Zod raw shape, validated
 *     by the McpServer before dispatch, exactly like defineTool.
 *   - approval gate      — billable / requiresApproval specs throw the same
 *     `approval_required` (402) error shape as callBillable in tools.ts when
 *     no approvalToken is bound.
 */

import { z } from "zod";
import type { ToolDef, ToolDeps, ToolScope } from "../types.js";

// ===========================================================================
// Spec format
// ===========================================================================

/** HTTP methods the generator knows how to dispatch. */
export type GeneratedMethod = "GET" | "POST" | "DELETE";

/**
 * Declarative specification for a generated tool. One spec produces both the
 * MCP registration (name/description/inputShape/flags) and the HTTP call.
 */
export interface GeneratedToolSpec<S extends z.ZodRawShape> {
  name: string;
  description: string;
  scope: ToolScope;
  /** Whether the tool performs a stateful mutation that may move money. */
  billable: boolean;
  /** Whether the caller MUST supply an approvalToken before dispatch. */
  requiresApproval: boolean;
  /** HTTP method of the canonical control-plane route. */
  method: GeneratedMethod;
  /**
   * Canonical `/api/v1/*` path. May contain `:param` segments; each param
   * MUST be declared in `input` and is URL-encoded into the path at call
   * time. Missing-param declarations are rejected when the spec is defined,
   * not when the tool is called.
   */
  path: string;
  /**
   * Zod raw shape for the whole tool input: path params, query params, and
   * body fields together. The generator splits validated args by role.
   */
  input: S;
  /**
   * Args sent as query-string params. Default for GET: every non-path arg.
   * Values that are undefined are passed through and dropped by the client's
   * URL builder, matching the hand-written handlers.
   */
  query?: readonly (keyof S & string)[];
  /**
   * Args sent as the JSON request body. Default for POST: every non-path
   * arg. Undefined fields are dropped (JSON.stringify would drop them on the
   * wire anyway), and when no field has a value the request is sent WITHOUT
   * a body — matching the hand-written `client.post(path, args)` and
   * `args.reason ? { reason } : undefined` conventions.
   */
  body?: readonly (keyof S & string)[];
  /**
   * Whether mutations send the client's deterministic Idempotency-Key.
   * Default: true for non-GET specs that are billable or require approval
   * (i.e. real mutations), false for read-only POSTs such as quotes/plans.
   */
  idempotent?: boolean;
  /** Optional Zod raw shape describing the structured output envelope. */
  outputShape?: Record<string, z.ZodTypeAny>;
}

// ===========================================================================
// Generator
// ===========================================================================

/** Extract `:param` names from a canonical path, in order. */
export function pathParamsOf(path: string): string[] {
  return path
    .split("/")
    .filter((s) => s.startsWith(":"))
    .map((s) => s.slice(1));
}

/** Throw the repo-standard approval error (same shape as callBillable). */
function approvalRequiredError(): Error & { capixCode: string; status: number } {
  const err = new Error("approvalToken is required for this billable tool (§5)") as Error & {
    capixCode: string;
    status: number;
  };
  err.capixCode = "approval_required";
  err.status = 402;
  return err;
}

/** Throw the repo-standard invalid-argument error (same shape as asStr). */
function invalidArgumentError(field: string): Error & { capixCode: string; status: number } {
  const err = new Error(`${field} is required`) as Error & { capixCode: string; status: number };
  err.capixCode = "invalid_argument";
  err.status = 400;
  return err;
}

/**
 * Generate a ToolDef from a declarative spec. The returned definition is a
 * plain ToolDef — indistinguishable from a defineTool declaration to the
 * server, the registry, and the annotations layer.
 */
export function defineGeneratedTool<S extends z.ZodRawShape>(spec: GeneratedToolSpec<S>): ToolDef {
  const pathParams = pathParamsOf(spec.path);

  // Declaration-time enforcement: every path param must be a declared input,
  // so a spec can never reference a path segment the caller cannot supply.
  for (const param of pathParams) {
    if (!(param in spec.input)) {
      throw new Error(
        `defineGeneratedTool(${spec.name}): path param :${param} is not declared in the input shape`,
      );
    }
  }
  if (spec.method === "GET" && spec.body) {
    throw new Error(`defineGeneratedTool(${spec.name}): GET tools cannot declare a request body`);
  }

  const pathParamSet = new Set<string>(pathParams);
  const nonPathKeys = Object.keys(spec.input).filter((k) => !pathParamSet.has(k)) as Array<
    keyof S & string
  >;
  const queryKeys: readonly (keyof S & string)[] =
    spec.query ?? (spec.method === "GET" ? nonPathKeys : []);
  const bodyKeys: readonly (keyof S & string)[] =
    spec.body ?? (spec.method === "POST" ? nonPathKeys : []);
  const idempotent =
    spec.idempotent ?? (spec.method !== "GET" && (spec.billable || spec.requiresApproval));
  const needsApproval = spec.billable || spec.requiresApproval;

  type Args = { [K in keyof S]: z.output<S[K]> };

  const handler = async (rawArgs: Args, { client, ctx }: ToolDeps): Promise<Record<string, unknown>> => {
    // Approval gate — mirrors callBillable in tools.ts. The server wrapper
    // also gates before dispatch; this keeps the invariant when a handler is
    // invoked directly (tests, future transports).
    if (needsApproval && !ctx.approvalToken) throw approvalRequiredError();

    // Fill path params (URL-encoded), failing closed on empty values.
    let path = spec.path;
    for (const param of pathParams) {
      const value = rawArgs[param];
      if (value === undefined || value === null || `${value}` === "") {
        throw invalidArgumentError(param);
      }
      path = path.replace(`:${param}`, encodeURIComponent(String(value)));
    }

    if (spec.method === "GET") {
      const params: Record<string, unknown> = {};
      for (const key of queryKeys) params[key] = rawArgs[key];
      return client.get<Record<string, unknown>>(
        path,
        queryKeys.length > 0 ? params : undefined,
      );
    }

    if (spec.method === "DELETE") {
      // client.delete always derives an Idempotency-Key from the path.
      return client.delete<Record<string, unknown>>(path);
    }

    // POST: assemble the body from the declared body keys, dropping undefined
    // fields. When nothing has a value, send no body at all (hand-written
    // convention).
    let body: Record<string, unknown> | undefined;
    if (bodyKeys.length > 0) {
      const assembled: Record<string, unknown> = {};
      for (const key of bodyKeys) {
        if (rawArgs[key] !== undefined) assembled[key] = rawArgs[key];
      }
      body = Object.keys(assembled).length > 0 ? assembled : undefined;
    }

    if (!idempotent && !needsApproval) {
      // Read-only POST (quote/plan/validate): no idempotency key, no approval
      // header — identical to the hand-written `client.post(path, args)`.
      return client.post<Record<string, unknown>>(path, body);
    }
    return client.post<Record<string, unknown>>(path, body, {
      ...(idempotent ? { idempotent: true } : {}),
      ...(needsApproval ? { approvalToken: ctx.approvalToken } : {}),
    });
  };

  return {
    name: spec.name,
    description: spec.description,
    scope: spec.scope,
    billable: spec.billable,
    requiresApproval: spec.requiresApproval,
    inputShape: spec.input,
    outputShape: spec.outputShape,
    // Sound cast: same guarantee as defineTool — the McpServer validates args
    // against inputShape before the handler runs.
    handler: handler as ToolDef["handler"],
  };
}
