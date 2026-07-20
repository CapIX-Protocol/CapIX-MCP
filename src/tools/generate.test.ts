/**
 * Tests for the declarative tool generator (tools/generate.ts) and the eight
 * tools migrated to it:
 *
 *   discovery    capix_deployments · capix_receipts
 *   planning     capix_compute_quote · capix_model_quote
 *   lifecycle    capix_stop · capix_cancel
 *   verification capix_inspect_receipt
 *   infra-context capix_model_list
 *
 * Runs on the built-in node:test runner via tsx (no extra dev dependency):
 *   npm test
 *
 * A recording fake CapixClientLike stands in for the network so each test can
 * assert the exact canonical route, query params, body, and post options
 * (idempotency / approval) a generated handler issues.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import { defineGeneratedTool, pathParamsOf } from "./generate.js";
import { TOOLS, TOOL_MAP, TOOL_NAMES } from "../tools.js";
import { CapixApiError } from "../types.js";
import type { CapixClientLike, ProblemDetail, ToolCallContext, ToolDef } from "../types.js";

// ── Fakes ───────────────────────────────────────────────────────────────────

interface RecordedCall {
  method: "get" | "post" | "delete";
  path: string;
  params?: Record<string, unknown>;
  body?: Record<string, unknown>;
  opts?: { idempotent?: boolean; approvalToken?: string };
}

function makeClient(
  responses: Record<string, unknown> = {},
): { client: CapixClientLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const client: CapixClientLike = {
    async get<T>(path: string, params?: Record<string, unknown>): Promise<T> {
      calls.push({ method: "get", path, params });
      if (path in responses) return responses[path] as T;
      return { ok: true } as T;
    },
    async post<T>(
      path: string,
      body?: Record<string, unknown>,
      opts?: { idempotent?: boolean; approvalToken?: string },
    ): Promise<T> {
      calls.push({ method: "post", path, body, opts });
      if (path in responses) return responses[path] as T;
      return { ok: true } as T;
    },
    async delete<T>(path: string): Promise<T> {
      calls.push({ method: "delete", path });
      return { ok: true } as T;
    },
    isAuthenticated: () => true,
  };
  return { client, calls };
}

const ctx: ToolCallContext = { actor: "test" };
const approvedCtx: ToolCallContext = { actor: "test", approvalToken: "appr_test" };

const GENERATED_TOOL_NAMES = [
  "capix_deployments",
  "capix_receipts",
  "capix_compute_quote",
  "capix_model_quote",
  "capix_stop",
  "capix_cancel",
  "capix_inspect_receipt",
  "capix_model_list",
] as const;

function tool(name: string): ToolDef {
  const found = TOOL_MAP.get(name);
  assert.ok(found, `tool missing: ${name}`);
  return found;
}

// ── Registration ────────────────────────────────────────────────────────────

describe("generated tool registration", () => {
  it("registers all eight migrated tools in the global registry", () => {
    for (const name of GENERATED_TOOL_NAMES) {
      assert.ok(TOOL_NAMES.includes(name), `${name} missing from TOOLS`);
      assert.equal(TOOL_MAP.get(name)?.name, name);
    }
  });

  it("keeps the total tool count at 67 with no name collisions", () => {
    assert.equal(TOOLS.length, 67);
    assert.equal(new Set(TOOL_NAMES).size, TOOL_NAMES.length);
  });

  it("preserves scope and billable/approval flags", () => {
    const flags = Object.fromEntries(
      GENERATED_TOOL_NAMES.map((n) => {
        const t = tool(n);
        return [n, `${t.scope}|${t.billable}|${t.requiresApproval}`];
      }),
    );
    assert.deepEqual(flags, {
      capix_deployments: "discovery|false|false",
      capix_receipts: "discovery|false|false",
      capix_compute_quote: "planning|false|false",
      capix_model_quote: "planning|false|false",
      capix_stop: "lifecycle|true|true",
      capix_cancel: "lifecycle|false|true",
      capix_inspect_receipt: "verification|false|false",
      capix_model_list: "infra-context|false|false",
    });
  });
});

// ── Input validation (Zod shapes, as enforced by the McpServer) ─────────────

describe("generated input validation", () => {
  it("rejects out-of-range and missing inputs", () => {
    assert.throws(() =>
      z.object(tool("capix_deployments").inputShape).parse({ limit: 0 }),
    );
    assert.throws(() =>
      z.object(tool("capix_inspect_receipt").inputShape).parse({}),
    );
    assert.throws(() =>
      z.object(tool("capix_compute_quote").inputShape).parse({ cpu: 2 }),
    );
  });

  it("applies defaults from the declared shape", () => {
    const parsed = z.object(tool("capix_model_list").inputShape).parse({});
    assert.equal(parsed.limit, 100);
  });
});

// ── Spec-time enforcement ───────────────────────────────────────────────────

describe("spec declaration enforcement", () => {
  it("rejects a path param that is not declared in the input shape", () => {
    assert.throws(
      () =>
        defineGeneratedTool({
          name: "capix_bad_spec",
          description: "broken spec",
          scope: "discovery",
          billable: false,
          requiresApproval: false,
          method: "GET",
          path: "/api/v1/things/:thingId",
          input: {},
        }),
      /:thingId is not declared/,
    );
  });

  it("rejects a body on a GET spec", () => {
    assert.throws(
      () =>
        defineGeneratedTool({
          name: "capix_bad_get",
          description: "broken spec",
          scope: "discovery",
          billable: false,
          requiresApproval: false,
          method: "GET",
          path: "/api/v1/things",
          input: { q: z.string().optional() },
          body: ["q"],
        }),
      /GET tools cannot declare a request body/,
    );
  });

  it("extracts path params in order", () => {
    assert.deepEqual(pathParamsOf("/api/v1/a/:x/b/:y"), ["x", "y"]);
    assert.deepEqual(pathParamsOf("/api/v1/a"), []);
  });
});

// ── GET generation ──────────────────────────────────────────────────────────

describe("generated GET tools", () => {
  it("capix_deployments sends filters as query params", async () => {
    const { client, calls } = makeClient();
    await tool("capix_deployments").handler({ limit: 10, phase: "running" }, { client, ctx });
    assert.deepEqual(calls, [
      {
        method: "get",
        path: "/api/v1/deployments",
        params: { limit: 10, phase: "running" },
      },
    ]);
  });

  it("capix_receipts passes undefined filters through untouched", async () => {
    const { client, calls } = makeClient();
    await tool("capix_receipts").handler({ limit: 50 }, { client, ctx });
    assert.deepEqual(calls[0].params, { limit: 50, since: undefined });
  });

  it("capix_inspect_receipt URL-encodes the path param", async () => {
    const receipt = { receiptId: "rcpt_1", postedAt: "2026-07-18T00:00:00Z" };
    const { client, calls } = makeClient({ "/api/v1/verification/receipts/rcpt_1%2Fx": receipt });
    const out = await tool("capix_inspect_receipt").handler(
      { receiptId: "rcpt_1/x" },
      { client, ctx },
    );
    assert.equal(calls[0].path, "/api/v1/verification/receipts/rcpt_1%2Fx");
    assert.equal(calls[0].params, undefined);
    assert.deepEqual(out, receipt);
  });

  it("capix_model_list queries the catalog with a category filter", async () => {
    const { client, calls } = makeClient();
    await tool("capix_model_list").handler({ category: "chat", limit: 25 }, { client, ctx });
    assert.deepEqual(calls, [
      { method: "get", path: "/api/v1/models", params: { category: "chat", limit: 25 } },
    ]);
  });
});

// ── POST generation ─────────────────────────────────────────────────────────

describe("generated POST tools", () => {
  it("capix_compute_quote posts the full body without idempotency or approval opts", async () => {
    const { client, calls } = makeClient();
    const spec = {
      workloadType: "replicated_service.v1",
      cpu: 4,
      ramMb: 8192,
      storageGb: 40,
      region: "us-east",
    };
    await tool("capix_compute_quote").handler(spec, { client, ctx });
    assert.deepEqual(calls, [
      { method: "post", path: "/api/v1/planning/compute/quote", body: spec, opts: undefined },
    ]);
  });

  it("capix_model_quote posts the model spec as the body", async () => {
    const { client, calls } = makeClient();
    const spec = { modelId: "llama-3.1-70b", gpuCount: 2 };
    await tool("capix_model_quote").handler(spec, { client, ctx });
    assert.deepEqual(calls[0].body, spec);
    assert.equal(calls[0].opts, undefined);
  });
});

// ── Mutation conventions: approval + idempotency ────────────────────────────

describe("generated mutation conventions", () => {
  it("capix_stop posts idempotently with the bound approval token and no body", async () => {
    const { client, calls } = makeClient();
    await tool("capix_stop").handler({ deploymentId: "dep_9" }, { client, ctx: approvedCtx });
    assert.deepEqual(calls, [
      {
        method: "post",
        path: "/api/v1/lifecycle/deployments/dep_9/stop",
        body: undefined,
        opts: { idempotent: true, approvalToken: "appr_test" },
      },
    ]);
  });

  it("capix_cancel includes the reason body only when provided", async () => {
    const { client, calls } = makeClient();
    await tool("capix_cancel").handler(
      { operationId: "op_1", reason: "no longer needed" },
      { client, ctx: approvedCtx },
    );
    await tool("capix_cancel").handler({ operationId: "op_2" }, { client, ctx: approvedCtx });
    assert.deepEqual(calls[0], {
      method: "post",
      path: "/api/v1/operations/op_1/cancel",
      body: { reason: "no longer needed" },
      opts: { idempotent: true, approvalToken: "appr_test" },
    });
    assert.deepEqual(calls[1], {
      method: "post",
      path: "/api/v1/operations/op_2/cancel",
      body: undefined,
      opts: { idempotent: true, approvalToken: "appr_test" },
    });
  });

  it("refuses billable mutations without an approval token (no HTTP call)", async () => {
    const { client, calls } = makeClient();
    await assert.rejects(
      tool("capix_stop").handler({ deploymentId: "dep_9" }, { client, ctx }),
      (err: unknown) => {
        assert.equal((err as { capixCode?: string }).capixCode, "approval_required");
        assert.equal((err as { status?: number }).status, 402);
        return true;
      },
    );
    assert.deepEqual(calls, []);
  });
});

// ── Problem passthrough (RFC 9457) ──────────────────────────────────────────

describe("problem+json passthrough", () => {
  it("propagates the client's CapixApiError untouched", async () => {
    const problem: ProblemDetail = {
      type: "https://capix.network/problems/insufficient-funds",
      title: "Insufficient funds",
      status: 402,
      detail: "Balance 100 minor units is below the required hold.",
      capixCode: "insufficient_funds",
      retryClass: "none",
      supportId: "sup_123",
    };
    const apiError = new CapixApiError(problem);
    const client: CapixClientLike = {
      async get(): Promise<never> {
        throw apiError;
      },
      async post(): Promise<never> {
        throw apiError;
      },
      async delete(): Promise<never> {
        throw new Error("unreachable");
      },
      isAuthenticated: () => true,
    };

    await assert.rejects(
      tool("capix_inspect_receipt").handler({ receiptId: "rcpt_1" }, { client, ctx }),
      (err: unknown) => {
        assert.ok(err instanceof CapixApiError);
        assert.deepEqual((err as CapixApiError).problem, problem);
        return true;
      },
    );
    await assert.rejects(
      tool("capix_stop").handler({ deploymentId: "dep_9" }, { client, ctx: approvedCtx }),
      (err: unknown) => {
        assert.ok(err instanceof CapixApiError);
        assert.equal((err as CapixApiError).capixCode, "insufficient_funds");
        return true;
      },
    );
  });
});
