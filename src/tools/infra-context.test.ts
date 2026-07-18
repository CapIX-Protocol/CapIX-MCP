/**
 * Tests for the infra-context tool group (tools/infra-context.ts).
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
import { TOOLS, TOOL_MAP, TOOL_NAMES } from "../tools.js";
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
      const key = `${path}${params ? ` ${JSON.stringify(params)}` : ""}`;
      if (key in responses) return responses[key] as T;
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
  it("declares exactly the five documented tools", () => {
    assert.deepEqual(INFRA_CONTEXT_TOOL_NAMES, [
      "capix_marketplace_browse",
      "capix_node_status",
      "capix_earnings_check",
      "capix_model_list",
      "capix_deployment_list",
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
    assert.equal(TOOLS.length, 64);
  });

  it("has no name collisions with the existing 59 tools", () => {
    const seen = new Set<string>();
    for (const t of TOOLS) {
      assert.ok(!seen.has(t.name), `duplicate tool name: ${t.name}`);
      seen.add(t.name);
    }
  });
});

// ── Handlers ────────────────────────────────────────────────────────────────

describe("capix_marketplace_browse", () => {
  it("queries the offers route with filters", async () => {
    const offers = { entries: [{ askId: 1, gpu: "A100" }], fetchedAt: "2026-07-18T00:00:00Z" };
    const { client, calls } = makeClient({ "/api/v1/marketplace/offers": offers });
    const out = await tool("capix_marketplace_browse").handler(
      { gpu: "A100", region: "us-east", limit: 10 },
      { client, ctx },
    );
    assert.deepEqual(out, offers);
    assert.deepEqual(calls, [
      {
        method: "get",
        path: "/api/v1/marketplace/offers",
        params: { gpu: "A100", region: "us-east", limit: 10 },
      },
    ]);
  });

  it("passes undefined filters through untouched", async () => {
    const { client, calls } = makeClient();
    await tool("capix_marketplace_browse").handler({ limit: 50 }, { client, ctx });
    assert.deepEqual(calls[0].params, { gpu: undefined, region: undefined, limit: 50 });
  });
});

describe("capix_node_status", () => {
  it("queries node status without a filter", async () => {
    const { client, calls } = makeClient();
    await tool("capix_node_status").handler({}, { client, ctx });
    assert.deepEqual(calls, [
      { method: "get", path: "/api/v1/nodes/status", params: { deploymentId: undefined } },
    ]);
  });

  it("forwards a deployment filter", async () => {
    const { client, calls } = makeClient();
    await tool("capix_node_status").handler({ deploymentId: "dep_123" }, { client, ctx });
    assert.equal(calls[0].params?.deploymentId, "dep_123");
  });
});

describe("capix_earnings_check", () => {
  it("returns the earnings payload unchanged", async () => {
    const earnings = {
      wallet: { amount: "1250", asset: "USD-credit", scale: 2 },
      totalSpent: { amount: "500", asset: "USD-credit", scale: 2 },
      activeDeployments: 2,
      devTokenBalance: 7,
      devTokenTotalEarned: 42,
      asOf: "2026-07-18T00:00:00Z",
    };
    const { client, calls } = makeClient({ "/api/v1/earnings": earnings });
    const out = await tool("capix_earnings_check").handler({}, { client, ctx });
    assert.deepEqual(out, earnings);
    assert.deepEqual(calls, [{ method: "get", path: "/api/v1/earnings", params: undefined }]);
  });
});

describe("capix_model_list", () => {
  it("queries the model catalog with a category filter", async () => {
    const { client, calls } = makeClient();
    await tool("capix_model_list").handler({ category: "chat", limit: 25 }, { client, ctx });
    assert.deepEqual(calls, [
      {
        method: "get",
        path: "/api/v1/models",
        params: { category: "chat", limit: 25 },
      },
    ]);
  });
});

describe("capix_deployment_list", () => {
  it("requests the inventory without node detail by default", async () => {
    const { client, calls } = makeClient();
    await tool("capix_deployment_list").handler(
      { limit: 50, phase: "running", includeNodes: false },
      { client, ctx },
    );
    assert.deepEqual(calls, [
      {
        method: "get",
        path: "/api/v1/deployments",
        params: { limit: 50, phase: "running", include: undefined },
      },
    ]);
  });

  it("opts into embedded node health when asked", async () => {
    const { client, calls } = makeClient();
    await tool("capix_deployment_list").handler(
      { limit: 5, includeNodes: true },
      { client, ctx },
    );
    assert.equal(calls[0].params?.include, "nodes,health");
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
      tool("capix_earnings_check").handler({}, { client, ctx }),
      (err: unknown) => {
        assert.equal((err as Error).message, "boom");
        assert.equal((err as { capixCode?: string }).capixCode, "upstream_error");
        return true;
      },
    );
  });
});
