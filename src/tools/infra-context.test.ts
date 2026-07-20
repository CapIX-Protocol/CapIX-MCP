/**
 * Tests for the infra-context tool group (tools/infra-context.ts) after the
 * 2026-07 repair: two read-only tools backed by real routes.
 *
 *   capix_marketplace_browse  GET /api/v1/marketplace/offers
 *   capix_model_list          GET /api/v1/models
 *
 * (capix_node_status, capix_earnings_check and capix_deployment_list were
 * removed — no /api/v1/nodes/status, no /api/v1/earnings, and the deployment
 * inventory is served by capix_deployments.)
 *
 * Runs on the built-in node:test runner via tsx (no extra dev dependency):
 *   npm test
 *
 * A recording fake CapixClientLike stands in for the network so each test can
 * assert the exact canonical route + query params a handler issues, and the
 * structured object it returns.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { infraContextTools, INFRA_CONTEXT_TOOL_NAMES } from "./infra-context.js";
import { TOOL_MAP, TOOL_NAMES } from "../tools.js";
import type { CapixClientLike, ToolCallContext, ToolDef } from "../types.js";

// ── Fakes ───────────────────────────────────────────────────────────────────

interface RecordedCall {
  method: "get" | "post" | "delete";
  path: string;
  params?: Record<string, unknown>;
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
    async post<T>(path: string): Promise<T> {
      calls.push({ method: "post", path });
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

function tool(name: string): ToolDef {
  const found = infraContextTools.find((t) => t.name === name);
  assert.ok(found, `tool missing: ${name}`);
  return found;
}

// ── Registration ────────────────────────────────────────────────────────────

describe("infra-context tool registration", () => {
  it("declares exactly the two real-route tools", () => {
    assert.deepEqual(INFRA_CONTEXT_TOOL_NAMES, [
      "capix_marketplace_browse",
      "capix_model_list",
    ]);
  });

  it("marks every tool read-only in the infra-context scope", () => {
    for (const t of infraContextTools) {
      assert.equal(t.scope, "infra-context", t.name);
      assert.equal(t.billable, false, t.name);
      assert.equal(t.requiresApproval, false, t.name);
    }
  });

  it("is aggregated into the global TOOLS registry", () => {
    for (const name of INFRA_CONTEXT_TOOL_NAMES) {
      assert.ok(TOOL_NAMES.includes(name), `${name} missing from TOOLS`);
      assert.equal(TOOL_MAP.get(name)?.name, name);
    }
  });
});

// ── Handlers ────────────────────────────────────────────────────────────────

describe("capix_marketplace_browse", () => {
  it("queries the offers route with the real filter params", async () => {
    const offers = { entries: [{ askId: 1, gpuModel: "A100" }], nextCursor: "c2" };
    const { client, calls } = makeClient({ "/api/v1/marketplace/offers": offers });
    const out = await tool("capix_marketplace_browse").handler(
      { gpuModel: "A100", region: "us-east", trustTier: "verified", capability: "gpu", limit: 10 },
      { client, ctx },
    );
    assert.deepEqual(out, offers);
    assert.deepEqual(calls, [
      {
        method: "get",
        path: "/api/v1/marketplace/offers",
        params: {
          gpuModel: "A100",
          region: "us-east",
          trustTier: "verified",
          capability: "gpu",
          limit: 10,
          cursor: undefined,
        },
      },
    ]);
  });

  it("passes undefined filters through untouched", async () => {
    const { client, calls } = makeClient();
    await tool("capix_marketplace_browse").handler({ limit: 50 }, { client, ctx });
    assert.deepEqual(calls[0].params, {
      gpuModel: undefined,
      region: undefined,
      trustTier: undefined,
      capability: undefined,
      limit: 50,
      cursor: undefined,
    });
  });
});

describe("capix_model_list", () => {
  it("queries the model catalog with only the projectId param", async () => {
    const { client, calls } = makeClient();
    await tool("capix_model_list").handler({ projectId: "prj_1" }, { client, ctx });
    assert.deepEqual(calls, [
      { method: "get", path: "/api/v1/models", params: { projectId: "prj_1" } },
    ]);
  });
});

describe("error propagation", () => {
  it("lets client errors reject so the server wrapper can format them", async () => {
    const client: CapixClientLike = {
      async get(): Promise<never> {
        throw Object.assign(new Error("boom"), { capixCode: "upstream_error", status: 502 });
      },
      async post(): Promise<never> {
        throw new Error("unreachable");
      },
      async delete(): Promise<never> {
        throw new Error("unreachable");
      },
      isAuthenticated: () => true,
    };
    await assert.rejects(
      tool("capix_marketplace_browse").handler({ limit: 50 }, { client, ctx }),
      (err: unknown) => {
        assert.equal((err as Error).message, "boom");
        assert.equal((err as { capixCode?: string }).capixCode, "upstream_error");
        return true;
      },
    );
  });
});
