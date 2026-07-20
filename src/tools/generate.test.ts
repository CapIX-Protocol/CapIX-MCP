/**
 * Tests for the declarative tool generator (tools/generate.ts) and the
 * generated tools retargeted in the 2026-07 repair:
 *
 *   discovery    capix_deployments · capix_receipts
 *   planning     capix_compute_quote (POST /api/v1/quotes, idempotent)
 *   lifecycle    capix_deploy (POST /api/v1/deployments) ·
 *                capix_delete (DELETE /api/v1/deployments/:id) ·
 *                capix_cancel (POST /api/v1/operations/:operationId)
 *   verification capix_inspect_receipt (GET /api/v1/route-receipts/:receiptId)
 *   infra-context capix_model_list (GET /api/v1/models)
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
import { TOOL_MAP, TOOL_NAMES } from "../tools.js";
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
      if (path in responses) return responses[path] as T;
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
  "capix_deploy",
  "capix_delete",
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
  it("registers the retargeted generated tools in the global registry", () => {
    for (const name of GENERATED_TOOL_NAMES) {
      assert.ok(TOOL_NAMES.includes(name), `${name} missing from TOOLS`);
      assert.equal(TOOL_MAP.get(name)?.name, name);
    }
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
      capix_deploy: "lifecycle|true|true",
      capix_delete: "lifecycle|true|true",
      capix_cancel: "lifecycle|false|true",
      capix_inspect_receipt: "verification|false|false",
      capix_model_list: "infra-context|false|false",
    });
  });

  it("stamps every generated tool with its canonical routePath", () => {
    const paths = Object.fromEntries(GENERATED_TOOL_NAMES.map((n) => [n, tool(n).routePath]));
    assert.deepEqual(paths, {
      capix_deployments: "/api/v1/deployments",
      capix_receipts: "/api/v1/receipts",
      capix_compute_quote: "/api/v1/quotes",
      capix_deploy: "/api/v1/deployments",
      capix_delete: "/api/v1/deployments/:id",
      capix_cancel: "/api/v1/operations/:operationId",
      capix_inspect_receipt: "/api/v1/route-receipts/:receiptId",
      capix_model_list: "/api/v1/models",
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
      z.object(tool("capix_deployments").inputShape).parse({ limit: 101 }),
    );
    assert.throws(() =>
      z.object(tool("capix_inspect_receipt").inputShape).parse({}),
    );
    assert.throws(() =>
      z.object(tool("capix_compute_quote").inputShape).parse({ workloadSpec: { cpu: 2 } }),
    );
    assert.throws(() =>
      z.object(tool("capix_deploy").inputShape).parse({}),
    );
  });

  it("applies defaults from the declared shape", () => {
    const parsed = z.object(tool("capix_deployments").inputShape).parse({});
    assert.equal(parsed.limit, 25);
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
  it("capix_deployments sends the real route's filters as query params", async () => {
    const { client, calls } = makeClient();
    await tool("capix_deployments").handler({ limit: 10, status: "RUNNING" }, { client, ctx });
    assert.deepEqual(calls, [
      {
        method: "get",
        path: "/api/v1/deployments",
        params: { limit: 10, status: "RUNNING", cursor: undefined, projectId: undefined },
      },
    ]);
  });

  it("capix_receipts passes undefined filters through untouched", async () => {
    const { client, calls } = makeClient();
    await tool("capix_receipts").handler({ limit: 50 }, { client, ctx });
    assert.deepEqual(calls[0].params, {
      limit: 50,
      approvalStatus: undefined,
      agentId: undefined,
      cursor: undefined,
      projectId: undefined,
    });
  });

  it("capix_inspect_receipt URL-encodes the path param on the real route-receipts route", async () => {
    const receipt = { id: "rr_1", signature: "sig" };
    const { client, calls } = makeClient({ "/api/v1/route-receipts/rr_1%2Fx": receipt });
    const out = await tool("capix_inspect_receipt").handler(
      { receiptId: "rr_1/x" },
      { client, ctx },
    );
    assert.equal(calls[0].path, "/api/v1/route-receipts/rr_1%2Fx");
    assert.equal(calls[0].params, undefined);
    assert.deepEqual(out, receipt);
  });

  it("capix_model_list forwards only the projectId query param", async () => {
    const { client, calls } = makeClient();
    await tool("capix_model_list").handler({ projectId: "prj_1" }, { client, ctx });
    assert.deepEqual(calls, [
      { method: "get", path: "/api/v1/models", params: { projectId: "prj_1" } },
    ]);
  });
});

// ── POST generation ─────────────────────────────────────────────────────────

describe("generated POST tools", () => {
  it("capix_compute_quote posts the workloadSpec to /api/v1/quotes with an idempotency key but no approval", async () => {
    const { client, calls } = makeClient();
    const spec = {
      workloadSpec: { type: "replicated_service.v1", cpu: 4, ramMb: 8192, storageGb: 40, region: "us" },
      paymentAsset: "AUTO",
    };
    await tool("capix_compute_quote").handler(spec, { client, ctx });
    assert.deepEqual(calls, [
      {
        method: "post",
        path: "/api/v1/quotes",
        // undefined optional fields are dropped from the wire body.
        body: spec,
        opts: { idempotent: true },
      },
    ]);
  });

  it("capix_deploy posts quoteId to /api/v1/deployments idempotently with the approval token", async () => {
    const { client, calls } = makeClient();
    await tool("capix_deploy").handler({ quoteId: "qt_1" }, { client, ctx: approvedCtx });
    assert.deepEqual(calls, [
      {
        method: "post",
        path: "/api/v1/deployments",
        body: { quoteId: "qt_1" },
        opts: { idempotent: true, approvalToken: "appr_test" },
      },
    ]);
  });

  it("capix_cancel posts to the operation itself (POST /operations/:id is the cancel) with no body", async () => {
    const { client, calls } = makeClient();
    await tool("capix_cancel").handler({ operationId: "op_1" }, { client, ctx: approvedCtx });
    assert.deepEqual(calls, [
      {
        method: "post",
        path: "/api/v1/operations/op_1",
        body: undefined,
        opts: { idempotent: true, approvalToken: "appr_test" },
      },
    ]);
  });
});

// ── DELETE generation ───────────────────────────────────────────────────────

describe("generated DELETE tools", () => {
  it("capix_delete issues DELETE /api/v1/deployments/:id after the approval gate", async () => {
    const { client, calls } = makeClient();
    await tool("capix_delete").handler({ id: "dep_9" }, { client, ctx: approvedCtx });
    assert.deepEqual(calls, [{ method: "delete", path: "/api/v1/deployments/dep_9" }]);
  });
});

// ── Mutation conventions: approval + idempotency ────────────────────────────

describe("generated mutation conventions", () => {
  it("refuses billable mutations without an approval token (no HTTP call)", async () => {
    for (const [name, args] of [
      ["capix_deploy", { quoteId: "qt_1" }],
      ["capix_delete", { id: "dep_9" }],
      ["capix_cancel", { operationId: "op_1" }],
    ] as const) {
      const { client, calls } = makeClient();
      await assert.rejects(
        tool(name).handler(args, { client, ctx }),
        (err: unknown) => {
          assert.equal((err as { capixCode?: string }).capixCode, "approval_required");
          assert.equal((err as { status?: number }).status, 402);
          return true;
        },
      );
      assert.deepEqual(calls, [], `${name} made an HTTP call without approval`);
    }
  });
});

// ── capix_model_quote (hand-written, POST /api/v1/quotes) ───────────────────

describe("capix_model_quote", () => {
  it("wraps the model spec into a private_inference.v1 workloadSpec with an idempotency key", async () => {
    const { client, calls } = makeClient();
    await tool("capix_model_quote").handler(
      { modelId: "llama-3.1-8b-instruct", cpu: 8, ramMb: 32768, storageGb: 100, gpu: 1, region: "eu" },
      { client, ctx },
    );
    assert.deepEqual(calls, [
      {
        method: "post",
        path: "/api/v1/quotes",
        body: {
          workloadSpec: {
            type: "private_inference.v1",
            cpu: 8,
            ramMb: 32768,
            storageGb: 100,
            gpu: 1,
            vramMb: undefined,
            region: "eu",
            maxDurationHours: undefined,
            payload: { modelId: "llama-3.1-8b-instruct", source: "capix-mcp" },
          },
          paymentAsset: undefined,
          projectId: undefined,
        },
        opts: { idempotent: true },
      },
    ]);
  });

  it("requires the resource footprint upstream mandates", () => {
    const shape = z.object(tool("capix_model_quote").inputShape);
    assert.throws(() => shape.parse({ modelId: "m" }));
    assert.throws(() => shape.parse({ modelId: "m", cpu: 0, ramMb: 1, storageGb: 0 }));
    assert.ok(shape.parse({ modelId: "m", cpu: 1, ramMb: 128, storageGb: 0 }));
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
        throw apiError;
      },
      isAuthenticated: () => true,
    };

    await assert.rejects(
      tool("capix_inspect_receipt").handler({ receiptId: "rr_1" }, { client, ctx }),
      (err: unknown) => {
        assert.ok(err instanceof CapixApiError);
        assert.deepEqual((err as CapixApiError).problem, problem);
        return true;
      },
    );
    await assert.rejects(
      tool("capix_deploy").handler({ quoteId: "qt_1" }, { client, ctx: approvedCtx }),
      (err: unknown) => {
        assert.ok(err instanceof CapixApiError);
        assert.equal((err as CapixApiError).capixCode, "insufficient_funds");
        return true;
      },
    );
    await assert.rejects(
      tool("capix_delete").handler({ id: "dep_9" }, { client, ctx: approvedCtx }),
      (err: unknown) => {
        assert.ok(err instanceof CapixApiError);
        return true;
      },
    );
  });
});
