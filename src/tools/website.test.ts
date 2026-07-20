/**
 * Tests for the website tools retargeted in the 2026-07 repair from the
 * nonexistent singular /api/v1/website/* family to the real
 * /api/v1/websites/* family (app/api/v1/websites/* in the protocol repo):
 *
 *   capix_website_create    POST   /api/v1/websites              (billable)
 *   capix_website_list      GET    /api/v1/websites              (read-only)
 *   capix_website_get       GET    /api/v1/websites/:id          (read-only)
 *   capix_website_promote   POST   /api/v1/websites/:id/promote  (billable)
 *   capix_website_rollback  POST   /api/v1/websites/:id/rollback (billable)
 *   capix_website_destroy   DELETE /api/v1/websites/:id          (billable)
 *
 * Runs on the built-in node:test runner via tsx (no extra dev dependency):
 *   npm test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import { websiteTools } from "../tools.js";
import { TOOL_MAP } from "../tools.js";
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

const WEBSITE_TOOL_NAMES = [
  "capix_website_create",
  "capix_website_list",
  "capix_website_get",
  "capix_website_promote",
  "capix_website_rollback",
  "capix_website_destroy",
] as const;

// ── Registration ────────────────────────────────────────────────────────────

describe("website tool registration", () => {
  it("declares exactly the six real-contract tools", () => {
    assert.equal(websiteTools.length, 6);
    assert.deepEqual(
      websiteTools.map((t) => t.name),
      [...WEBSITE_TOOL_NAMES],
    );
  });

  it("targets the plural /api/v1/websites family everywhere", () => {
    for (const t of websiteTools) {
      assert.ok(
        t.routePath === "/api/v1/websites" || t.routePath.startsWith("/api/v1/websites/"),
        `${t.name} targets ${t.routePath}`,
      );
    }
  });

  it("marks create/promote/rollback/destroy billable and list/get read-only", () => {
    const expected: Record<string, [boolean, boolean]> = {
      capix_website_create: [true, true],
      capix_website_list: [false, false],
      capix_website_get: [false, false],
      capix_website_promote: [true, true],
      capix_website_rollback: [true, true],
      capix_website_destroy: [true, true],
    };
    for (const t of websiteTools) {
      assert.deepEqual([t.billable, t.requiresApproval], expected[t.name], t.name);
    }
  });
});

// ── Input validation ────────────────────────────────────────────────────────

describe("website input validation", () => {
  it("capix_website_create requires name and sourceRef", () => {
    const shape = z.object(tool("capix_website_create").inputShape);
    assert.throws(() => shape.parse({ sourceRef: "https://github.com/x/y" }));
    assert.throws(() => shape.parse({ name: "mysite" }));
    assert.throws(() => shape.parse({ name: "", sourceRef: "" }));
    assert.ok(shape.parse({ name: "mysite", sourceRef: "https://github.com/x/y" }));
  });

  it("by-id tools require the id", () => {
    for (const name of ["capix_website_get", "capix_website_promote", "capix_website_rollback", "capix_website_destroy"]) {
      assert.throws(() => z.object(tool(name).inputShape).parse({}), name);
    }
  });
});

// ── Dispatch ────────────────────────────────────────────────────────────────

describe("website tools dispatch", () => {
  it("capix_website_create POSTs name/sourceRef/buildCommand idempotently", async () => {
    const { client, calls } = makeClient();
    const spec = { name: "mysite", sourceRef: "https://github.com/x/y", buildCommand: "pnpm build" };
    await tool("capix_website_create").handler(spec, { client, ctx: approvedCtx });
    assert.deepEqual(calls, [
      {
        method: "post",
        path: "/api/v1/websites",
        body: spec,
        opts: { idempotent: true, approvalToken: "appr_test" },
      },
    ]);
  });

  it("capix_website_create drops undefined optional fields from the body", async () => {
    const { client, calls } = makeClient();
    await tool("capix_website_create").handler(
      { name: "mysite", sourceRef: "https://github.com/x/y" },
      { client, ctx: approvedCtx },
    );
    assert.deepEqual(calls[0].body, { name: "mysite", sourceRef: "https://github.com/x/y" });
  });

  it("capix_website_list GETs the collection", async () => {
    const { client, calls } = makeClient();
    await tool("capix_website_list").handler({}, { client, ctx });
    assert.deepEqual(calls, [{ method: "get", path: "/api/v1/websites", params: undefined }]);
  });

  it("capix_website_get GETs the by-id route, URL-encoding the id", async () => {
    const website = { website: { id: "web_1", status: "live" } };
    const { client, calls } = makeClient({ "/api/v1/websites/web_1%2Fx": website });
    const out = await tool("capix_website_get").handler({ id: "web_1/x" }, { client, ctx });
    assert.deepEqual(calls, [
      { method: "get", path: "/api/v1/websites/web_1%2Fx", params: undefined },
    ]);
    assert.deepEqual(out, website);
  });

  it("capix_website_promote POSTs the action sub-path with optional releaseId body", async () => {
    const { client, calls } = makeClient();
    await tool("capix_website_promote").handler({ id: "web_1" }, { client, ctx: approvedCtx });
    await tool("capix_website_promote").handler(
      { id: "web_1", releaseId: "rel_9" },
      { client, ctx: approvedCtx },
    );
    assert.deepEqual(calls[0], {
      method: "post",
      path: "/api/v1/websites/web_1/promote",
      body: undefined,
      opts: { idempotent: true, approvalToken: "appr_test" },
    });
    assert.deepEqual(calls[1], {
      method: "post",
      path: "/api/v1/websites/web_1/promote",
      body: { releaseId: "rel_9" },
      opts: { idempotent: true, approvalToken: "appr_test" },
    });
  });

  it("capix_website_rollback POSTs the rollback sub-path", async () => {
    const { client, calls } = makeClient();
    await tool("capix_website_rollback").handler({ id: "web_1" }, { client, ctx: approvedCtx });
    assert.deepEqual(calls[0], {
      method: "post",
      path: "/api/v1/websites/web_1/rollback",
      body: undefined,
      opts: { idempotent: true, approvalToken: "appr_test" },
    });
  });

  it("capix_website_destroy issues DELETE on the by-id route", async () => {
    const { client, calls } = makeClient();
    await tool("capix_website_destroy").handler({ id: "web_1" }, { client, ctx: approvedCtx });
    assert.deepEqual(calls, [{ method: "delete", path: "/api/v1/websites/web_1" }]);
  });
});

// ── Mutation conventions + problem passthrough ──────────────────────────────

describe("website mutation conventions", () => {
  it("refuses every mutation without an approval token (no HTTP call)", async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["capix_website_create", { name: "s", sourceRef: "https://github.com/x/y" }],
      ["capix_website_promote", { id: "web_1" }],
      ["capix_website_rollback", { id: "web_1" }],
      ["capix_website_destroy", { id: "web_1" }],
    ];
    for (const [name, args] of cases) {
      const { client, calls } = makeClient();
      await assert.rejects(
        tool(name).handler(args, { client, ctx }),
        (err: unknown) => {
          assert.equal((err as { capixCode?: string }).capixCode, "approval_required", name);
          assert.equal((err as { status?: number }).status, 402, name);
          return true;
        },
      );
      assert.deepEqual(calls, [], `${name} made an HTTP call without approval`);
    }
  });

  it("propagates problem+json untouched (e.g. CAPIX_WEBSITE_NOT_FOUND)", async () => {
    const problem: ProblemDetail = {
      type: "about:blank",
      title: "Website not found",
      status: 404,
      capixCode: "CAPIX_WEBSITE_NOT_FOUND",
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
      tool("capix_website_get").handler({ id: "web_x" }, { client, ctx }),
      (err: unknown) => {
        assert.ok(err instanceof CapixApiError);
        assert.deepEqual((err as CapixApiError).problem, problem);
        return true;
      },
    );
  });
});
