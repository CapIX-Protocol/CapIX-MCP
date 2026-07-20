/**
 * Tests for the factory tools (tools/factory.ts) added in the 2026-07 repair:
 *
 *   jobs (6)     capix_job_submit · capix_job_list · capix_job_get ·
 *                capix_job_logs · capix_job_cancel · capix_job_rerun
 *   training (4) capix_training_submit · capix_training_list ·
 *                capix_training_get · capix_training_deploy
 *   agents (4)   capix_agent_deploy · capix_agent_list · capix_agent_get ·
 *                capix_agent_destroy
 *
 * Each suite covers registration, input validation, the exact
 * path/method/body/query dispatched, problem+json passthrough, and the
 * mutation conventions (approval gate + Idempotency-Key opts) — the same
 * pattern as generate.test.ts, against a recording fake CapixClientLike.
 *
 * Runs on the built-in node:test runner via tsx (no extra dev dependency):
 *   npm test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import { factoryTools, FACTORY_TOOL_NAMES } from "./factory.js";
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

function tool(name: string): ToolDef {
  const found = TOOL_MAP.get(name);
  assert.ok(found, `tool missing: ${name}`);
  return found;
}

const MUTATIONS = [
  "capix_job_submit",
  "capix_job_cancel",
  "capix_job_rerun",
  "capix_training_submit",
  "capix_training_deploy",
  "capix_agent_deploy",
  "capix_agent_destroy",
] as const;

// ── Registration ────────────────────────────────────────────────────────────

describe("factory tool registration", () => {
  it("declares exactly the 14 factory tools", () => {
    assert.equal(factoryTools.length, 14);
    assert.deepEqual(FACTORY_TOOL_NAMES, [
      "capix_job_submit",
      "capix_job_list",
      "capix_job_get",
      "capix_job_logs",
      "capix_job_cancel",
      "capix_job_rerun",
      "capix_training_submit",
      "capix_training_list",
      "capix_training_get",
      "capix_training_deploy",
      "capix_agent_deploy",
      "capix_agent_list",
      "capix_agent_get",
      "capix_agent_destroy",
    ]);
  });

  it("is aggregated into the global registry, all in the lifecycle scope", () => {
    for (const name of FACTORY_TOOL_NAMES) {
      assert.ok(TOOL_NAMES.includes(name), `${name} missing from TOOLS`);
      assert.equal(TOOL_MAP.get(name)?.scope, "lifecycle", name);
    }
  });

  it("marks mutations billable/approval-gated and reads read-only", () => {
    const expected: Record<string, [boolean, boolean]> = {
      capix_job_submit: [true, true],
      capix_job_list: [false, false],
      capix_job_get: [false, false],
      capix_job_logs: [false, false],
      capix_job_cancel: [false, true],
      capix_job_rerun: [true, true],
      capix_training_submit: [true, true],
      capix_training_list: [false, false],
      capix_training_get: [false, false],
      capix_training_deploy: [false, true],
      capix_agent_deploy: [true, true],
      capix_agent_list: [false, false],
      capix_agent_get: [false, false],
      capix_agent_destroy: [true, true],
    };
    for (const t of factoryTools) {
      assert.deepEqual([t.billable, t.requiresApproval], expected[t.name], t.name);
    }
  });
});

// ── Input validation ────────────────────────────────────────────────────────

describe("factory input validation", () => {
  it("capix_job_submit requires image and a non-empty command", () => {
    const shape = z.object(tool("capix_job_submit").inputShape);
    assert.throws(() => shape.parse({ command: ["echo"] }));
    assert.throws(() => shape.parse({ image: "alpine", command: [] }));
    assert.ok(shape.parse({ image: "alpine", command: ["echo", "hi"] }));
  });

  it("capix_job_logs bounds the limit to the upstream 5000 cap", () => {
    const shape = z.object(tool("capix_job_logs").inputShape);
    assert.throws(() => shape.parse({ id: "job_1", limit: 5001 }));
    const parsed = shape.parse({ id: "job_1" });
    assert.equal(parsed.after, 0);
    assert.equal(parsed.limit, 1000);
  });

  it("capix_training_submit enforces the base-model allowlist and outputName rules", () => {
    const shape = z.object(tool("capix_training_submit").inputShape);
    const base = { outputName: "my-adapter", dataset: { url: "https://example.com/d.jsonl" } };
    assert.throws(() => shape.parse({ ...base, baseModel: "gpt-4" }));
    assert.throws(() => shape.parse({ ...base, baseModel: "llama-3.2-1b-instruct", outputName: "-bad" }));
    assert.ok(shape.parse({ ...base, baseModel: "llama-3.2-1b-instruct" }));
  });

  it("capix_training_submit accepts exactly one dataset variant", () => {
    const shape = z.object(tool("capix_training_submit").inputShape);
    const base = { baseModel: "qwen2.5-7b-instruct", outputName: "adapter" };
    assert.throws(() => shape.parse({ ...base, dataset: {} }));
    assert.throws(() => shape.parse({ ...base, dataset: { url: "http://insecure.example.com" } }));
    assert.ok(shape.parse({ ...base, dataset: { inlineJsonl: "{}\n".repeat(50) } }));
  });

  it("capix_agent_deploy enforces runtime/tier enums and duration bounds", () => {
    const shape = z.object(tool("capix_agent_deploy").inputShape);
    const base = { runtime: "openclaw", tier: "micro", name: "my-agent" };
    assert.throws(() => shape.parse({ ...base, runtime: "hal" }));
    assert.throws(() => shape.parse({ ...base, tier: "enterprise" }));
    assert.throws(() => shape.parse({ ...base, durationHours: 169 }));
    const parsed = shape.parse(base);
    assert.equal(parsed.durationHours, 1);
  });
});

// ── Jobs dispatch ───────────────────────────────────────────────────────────

describe("jobs tools dispatch", () => {
  it("capix_job_submit POSTs the spec idempotently with the approval token", async () => {
    const { client, calls } = makeClient();
    const spec = { image: "alpine:3", command: ["echo", "hi"], tierId: "standard", timeoutSeconds: 600 };
    await tool("capix_job_submit").handler(spec, { client, ctx: approvedCtx });
    assert.deepEqual(calls, [
      {
        method: "post",
        path: "/api/v1/jobs",
        body: spec,
        opts: { idempotent: true, approvalToken: "appr_test" },
      },
    ]);
  });

  it("capix_job_list GETs the collection", async () => {
    const { client, calls } = makeClient();
    await tool("capix_job_list").handler({}, { client, ctx });
    assert.deepEqual(calls, [{ method: "get", path: "/api/v1/jobs", params: undefined }]);
  });

  it("capix_job_get dispatches detail as ?id= (no /jobs/[id] route exists)", async () => {
    const job = { job: { id: "job_1", status: "running" } };
    const { client, calls } = makeClient({ "/api/v1/jobs": job });
    const out = await tool("capix_job_get").handler({ id: "job_1" }, { client, ctx });
    assert.deepEqual(calls, [{ method: "get", path: "/api/v1/jobs", params: { id: "job_1" } }]);
    assert.deepEqual(out, job);
  });

  it("capix_job_logs fills the path param and sends the after cursor as query", async () => {
    const { client, calls } = makeClient();
    await tool("capix_job_logs").handler({ id: "job_9", after: 42, limit: 500 }, { client, ctx });
    assert.deepEqual(calls, [
      { method: "get", path: "/api/v1/jobs/job_9/logs", params: { after: 42, limit: 500 } },
    ]);
  });

  it("capix_job_cancel POSTs to the cancel sub-route with no body", async () => {
    const { client, calls } = makeClient();
    await tool("capix_job_cancel").handler({ id: "job_9" }, { client, ctx: approvedCtx });
    assert.deepEqual(calls, [
      {
        method: "post",
        path: "/api/v1/jobs/job_9/cancel",
        body: undefined,
        opts: { idempotent: true, approvalToken: "appr_test" },
      },
    ]);
  });

  it("capix_job_rerun POSTs idempotently with the approval token and no body", async () => {
    const { client, calls } = makeClient();
    await tool("capix_job_rerun").handler({ id: "job_9" }, { client, ctx: approvedCtx });
    assert.deepEqual(calls, [
      {
        method: "post",
        path: "/api/v1/jobs/job_9/rerun",
        body: undefined,
        opts: { idempotent: true, approvalToken: "appr_test" },
      },
    ]);
  });
});

// ── Training dispatch ───────────────────────────────────────────────────────

describe("training tools dispatch", () => {
  it("capix_training_submit POSTs the spec idempotently with the approval token", async () => {
    const { client, calls } = makeClient();
    const spec = {
      baseModel: "llama-3.2-1b-instruct",
      outputName: "adapter-1",
      dataset: { url: "https://example.com/data.jsonl" },
      lora: { rank: 16, alpha: 32, epochs: 3, learningRate: 2e-4 },
    };
    await tool("capix_training_submit").handler(spec, { client, ctx: approvedCtx });
    assert.deepEqual(calls, [
      {
        method: "post",
        path: "/api/v1/training",
        body: spec,
        opts: { idempotent: true, approvalToken: "appr_test" },
      },
    ]);
  });

  it("capix_training_list and capix_training_get GET the real routes", async () => {
    const { client, calls } = makeClient();
    await tool("capix_training_list").handler({}, { client, ctx });
    await tool("capix_training_get").handler({ id: "tr_1" }, { client, ctx });
    assert.deepEqual(calls, [
      { method: "get", path: "/api/v1/training", params: undefined },
      { method: "get", path: "/api/v1/training/tr_1", params: undefined },
    ]);
  });

  it("capix_training_deploy POSTs to the deploy sub-route with no body", async () => {
    const { client, calls } = makeClient();
    await tool("capix_training_deploy").handler({ id: "tr_1" }, { client, ctx: approvedCtx });
    assert.deepEqual(calls, [
      {
        method: "post",
        path: "/api/v1/training/tr_1/deploy",
        body: undefined,
        opts: { idempotent: true, approvalToken: "appr_test" },
      },
    ]);
  });
});

// ── Agent-deploys dispatch ──────────────────────────────────────────────────

describe("agent-deploy tools dispatch", () => {
  it("capix_agent_deploy POSTs the spec idempotently with the approval token", async () => {
    const { client, calls } = makeClient();
    const spec = { runtime: "openclaw", tier: "micro", name: "my-agent", durationHours: 4 };
    await tool("capix_agent_deploy").handler(spec, { client, ctx: approvedCtx });
    assert.deepEqual(calls, [
      {
        method: "post",
        path: "/api/v1/agent-deploys",
        body: spec,
        opts: { idempotent: true, approvalToken: "appr_test" },
      },
    ]);
  });

  it("capix_agent_list forwards the projectId filter", async () => {
    const { client, calls } = makeClient();
    await tool("capix_agent_list").handler({ projectId: "prj_1" }, { client, ctx });
    assert.deepEqual(calls, [
      { method: "get", path: "/api/v1/agent-deploys", params: { projectId: "prj_1" } },
    ]);
  });

  it("capix_agent_get GETs the by-id route", async () => {
    const { client, calls } = makeClient();
    await tool("capix_agent_get").handler({ id: "agd_1" }, { client, ctx });
    assert.deepEqual(calls, [
      { method: "get", path: "/api/v1/agent-deploys/agd_1", params: undefined },
    ]);
  });

  it("capix_agent_destroy issues DELETE on the by-id route", async () => {
    const { client, calls } = makeClient();
    await tool("capix_agent_destroy").handler({ id: "agd_1" }, { client, ctx: approvedCtx });
    assert.deepEqual(calls, [{ method: "delete", path: "/api/v1/agent-deploys/agd_1" }]);
  });
});

// ── Mutation conventions: approval gate + idempotency ───────────────────────

describe("factory mutation conventions", () => {
  it("refuses every mutation without an approval token (no HTTP call)", async () => {
    const argsByTool: Record<string, Record<string, unknown>> = {
      capix_job_submit: { image: "alpine", command: ["true"] },
      capix_job_cancel: { id: "job_1" },
      capix_job_rerun: { id: "job_1" },
      capix_training_submit: {
        baseModel: "llama-3.2-1b-instruct",
        outputName: "a",
        dataset: { url: "https://example.com/d.jsonl" },
      },
      capix_training_deploy: { id: "tr_1" },
      capix_agent_deploy: { runtime: "hermes", tier: "nano", name: "x" },
      capix_agent_destroy: { id: "agd_1" },
    };
    for (const name of MUTATIONS) {
      const { client, calls } = makeClient();
      await assert.rejects(
        tool(name).handler(argsByTool[name]!, { client, ctx }),
        (err: unknown) => {
          assert.equal((err as { capixCode?: string }).capixCode, "approval_required", name);
          assert.equal((err as { status?: number }).status, 402, name);
          return true;
        },
      );
      assert.deepEqual(calls, [], `${name} made an HTTP call without approval`);
    }
  });
});

// ── Problem passthrough (RFC 9457) ──────────────────────────────────────────

describe("factory problem+json passthrough", () => {
  it("propagates the client's CapixApiError untouched on reads and mutations", async () => {
    const problem: ProblemDetail = {
      type: "https://capix.network/problems/insufficient-funds",
      title: "Insufficient funds",
      status: 402,
      detail: "Balance 100 minor units is below the required hold.",
      capixCode: "CAPIX_INSUFFICIENT_FUNDS",
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
      tool("capix_job_get").handler({ id: "job_1" }, { client, ctx }),
      (err: unknown) => {
        assert.ok(err instanceof CapixApiError);
        assert.deepEqual((err as CapixApiError).problem, problem);
        return true;
      },
    );
    await assert.rejects(
      tool("capix_job_submit").handler(
        { image: "alpine", command: ["true"] },
        { client, ctx: approvedCtx },
      ),
      (err: unknown) => {
        assert.ok(err instanceof CapixApiError);
        assert.equal((err as CapixApiError).capixCode, "CAPIX_INSUFFICIENT_FUNDS");
        return true;
      },
    );
    await assert.rejects(
      tool("capix_agent_destroy").handler({ id: "agd_1" }, { client, ctx: approvedCtx }),
      (err: unknown) => {
        assert.ok(err instanceof CapixApiError);
        return true;
      },
    );
  });
});
