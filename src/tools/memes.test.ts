/**
 * Tests for the meme + image tools (tools/memes.ts):
 *
 *   lifecycle  capix_meme · capix_image_gen        (billable, idempotent POSTs)
 *   discovery  capix_meme_templates                (read-only GET catalog)
 *
 * Runs on the built-in node:test runner via tsx (no extra dev dependency):
 *   npm test
 *
 * Follows the generate.test.ts pattern: a recording fake CapixClientLike
 * stands in for the network so each test can assert the exact canonical
 * route, body, and post options (idempotency / approval) a handler issues —
 * plus the response truncation that keeps inline SVG / base64 payloads out
 * of the agent's context.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import { MEME_IMAGE_TOOL_NAMES, memeImageTools } from "./memes.js";
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

function tool(name: string): ToolDef {
  const found = TOOL_MAP.get(name);
  assert.ok(found, `tool missing: ${name}`);
  return found;
}

// ── Registration ────────────────────────────────────────────────────────────

describe("meme/image tool registration", () => {
  it("declares exactly the three expected tools", () => {
    assert.deepEqual(MEME_IMAGE_TOOL_NAMES, [
      "capix_meme",
      "capix_image_gen",
      "capix_meme_templates",
    ]);
    assert.equal(memeImageTools.length, 3);
  });

  it("is aggregated into the global TOOLS registry with no name collisions", () => {
    for (const name of MEME_IMAGE_TOOL_NAMES) {
      assert.ok(TOOL_NAMES.includes(name), `${name} missing from TOOLS`);
      assert.equal(TOOL_MAP.get(name)?.name, name);
    }
    assert.equal(TOOLS.length, 67);
    assert.equal(new Set(TOOL_NAMES).size, TOOL_NAMES.length);
  });

  it("preserves scope and billable/approval flags", () => {
    const flags = Object.fromEntries(
      MEME_IMAGE_TOOL_NAMES.map((n) => {
        const t = tool(n);
        return [n, `${t.scope}|${t.billable}|${t.requiresApproval}`];
      }),
    );
    assert.deepEqual(flags, {
      capix_meme: "lifecycle|true|true",
      capix_image_gen: "lifecycle|true|true",
      capix_meme_templates: "discovery|false|false",
    });
  });
});

// ── Input validation (Zod shapes, as enforced by the McpServer) ─────────────

describe("meme/image input validation", () => {
  it("capix_meme requires a topic and rejects unknown vibes", () => {
    assert.throws(() => z.object(tool("capix_meme").inputShape).parse({}));
    assert.throws(() =>
      z.object(tool("capix_meme").inputShape).parse({ topic: "gm", vibe: "corporate" }),
    );
  });

  it("capix_meme accepts every catalog vibe and an optional templateId", () => {
    for (const vibe of ["degen", "pump", "bagholder", "unhinged", "dev", "spicy"]) {
      const parsed = z.object(tool("capix_meme").inputShape).parse({ topic: "gm", vibe });
      assert.equal(parsed.vibe, vibe);
    }
    const parsed = z
      .object(tool("capix_meme").inputShape)
      .parse({ topic: "gm", templateId: "drake" });
    assert.equal(parsed.templateId, "drake");
  });

  it("capix_image_gen enforces the control-plane prompt bounds (2–1000 chars)", () => {
    assert.throws(() => z.object(tool("capix_image_gen").inputShape).parse({}));
    assert.throws(() => z.object(tool("capix_image_gen").inputShape).parse({ prompt: "x" }));
    assert.throws(() =>
      z.object(tool("capix_image_gen").inputShape).parse({ prompt: "y".repeat(1001) }),
    );
    const parsed = z.object(tool("capix_image_gen").inputShape).parse({ prompt: "a capybara" });
    assert.equal(parsed.prompt, "a capybara");
  });

  it("capix_meme_templates takes no arguments", () => {
    assert.deepEqual(z.object(tool("capix_meme_templates").inputShape).parse({}), {});
  });
});

// ── Generated GET: meme catalog ─────────────────────────────────────────────

describe("capix_meme_templates", () => {
  it("GETs the public catalog with no query params", async () => {
    const catalog = {
      templates: [{ id: "drake", name: "Drake" }],
      vibes: ["degen", "pump", "bagholder", "unhinged", "dev", "spicy"],
      aiCanvasAvailable: true,
    };
    const { client, calls } = makeClient({ "/api/v1/memes": catalog });
    const out = await tool("capix_meme_templates").handler({}, { client, ctx });
    assert.deepEqual(calls, [{ method: "get", path: "/api/v1/memes", params: undefined }]);
    assert.deepEqual(out, catalog);
  });
});

// ── Mutation conventions: approval + idempotency ────────────────────────────

describe("meme/image mutation conventions", () => {
  it("capix_meme posts idempotently with the bound approval token", async () => {
    const { client, calls } = makeClient();
    await tool("capix_meme").handler(
      { topic: "solana to the moon", vibe: "pump", templateId: "drake" },
      { client, ctx: approvedCtx },
    );
    assert.deepEqual(calls, [
      {
        method: "post",
        path: "/api/v1/memes",
        body: { topic: "solana to the moon", vibe: "pump", templateId: "drake" },
        opts: { idempotent: true, approvalToken: "appr_test" },
      },
    ]);
  });

  it("capix_meme drops omitted optional fields from the body (ai-canvas default)", async () => {
    const { client, calls } = makeClient();
    await tool("capix_meme").handler({ topic: "gm" }, { client, ctx: approvedCtx });
    assert.deepEqual(calls[0].body, { topic: "gm" });
  });

  it("capix_meme stays idempotent across repeated identical calls", async () => {
    const { client, calls } = makeClient();
    const args = { topic: "repeated", vibe: "degen" };
    await tool("capix_meme").handler(args, { client, ctx: approvedCtx });
    await tool("capix_meme").handler(args, { client, ctx: approvedCtx });
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.deepEqual(call.opts, { idempotent: true, approvalToken: "appr_test" });
      assert.deepEqual(call.body, args);
    }
  });

  it("capix_image_gen posts the prompt idempotently with approval", async () => {
    const { client, calls } = makeClient();
    await tool("capix_image_gen").handler(
      { prompt: "a capybara trading perpetuals" },
      { client, ctx: approvedCtx },
    );
    assert.deepEqual(calls, [
      {
        method: "post",
        path: "/api/v1/images",
        body: { prompt: "a capybara trading perpetuals" },
        opts: { idempotent: true, approvalToken: "appr_test" },
      },
    ]);
  });

  it("refuses both billable tools without an approval token (no HTTP call)", async () => {
    const { client, calls } = makeClient();
    for (const [name, args] of [
      ["capix_meme", { topic: "gm" }],
      ["capix_image_gen", { prompt: "a capybara" }],
    ] as const) {
      await assert.rejects(
        tool(name).handler(args, { client, ctx }),
        (err: unknown) => {
          assert.equal((err as { capixCode?: string }).capixCode, "approval_required");
          assert.equal((err as { status?: number }).status, 402);
          return true;
        },
      );
    }
    assert.deepEqual(calls, []);
  });
});

// ── Problem passthrough (RFC 9457) ──────────────────────────────────────────

describe("meme/image problem+json passthrough", () => {
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
      tool("capix_meme").handler({ topic: "gm" }, { client, ctx: approvedCtx }),
      (err: unknown) => {
        assert.ok(err instanceof CapixApiError);
        assert.deepEqual((err as CapixApiError).problem, problem);
        return true;
      },
    );
    await assert.rejects(
      tool("capix_image_gen").handler({ prompt: "a capybara" }, { client, ctx: approvedCtx }),
      (err: unknown) => {
        assert.ok(err instanceof CapixApiError);
        assert.equal((err as CapixApiError).capixCode, "insufficient_funds");
        return true;
      },
    );
    await assert.rejects(
      tool("capix_meme_templates").handler({}, { client, ctx }),
      (err: unknown) => {
        assert.ok(err instanceof CapixApiError);
        assert.equal((err as CapixApiError).status, 402);
        return true;
      },
    );
  });
});

// ── Output formatting: payload truncation ───────────────────────────────────

describe("meme/image output truncation", () => {
  it("capix_meme replaces the inline SVG with a share-URL pointer", async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg">${"<text>wagmi</text>".repeat(500)}</svg>`;
    const upstream = {
      memeId: "meme_abc123",
      svg,
      caption: "gm",
      captions: { top: "gm", bottom: "wagmi" },
      templateId: "ai-canvas",
      vibe: "degen",
      mode: "ai-canvas",
      shareUrl: "https://capix.network/meme/meme_abc123",
      charge: { kind: "balance", amountMinor: "1000000", asset: "USDC", scale: 6 },
    };
    const { client } = makeClient({ "/api/v1/memes": upstream });
    const out = await tool("capix_meme").handler({ topic: "gm" }, { client, ctx: approvedCtx });

    // The SVG payload itself must not survive into the tool output.
    assert.notEqual(out.svg, svg);
    assert.ok(!JSON.stringify(out).includes("<text>wagmi</text>"));
    const placeholder = out.svg as string;
    assert.match(placeholder, /^\[omitted \d+ chars — /);
    assert.ok(placeholder.includes(String(svg.length)), "placeholder reports the original size");
    assert.ok(placeholder.includes("https://capix.network/meme/meme_abc123"), "points at the share URL");
    assert.ok(placeholder.includes("/api/v1/memes/meme_abc123"), "points at the retrieval route");

    // Everything else — captions, charge, ids — passes through untouched.
    assert.equal(out.memeId, "meme_abc123");
    assert.equal(out.shareUrl, "https://capix.network/meme/meme_abc123");
    assert.deepEqual(out.captions, { top: "gm", bottom: "wagmi" });
    assert.deepEqual(out.charge, { kind: "balance", amountMinor: "1000000", asset: "USDC", scale: 6 });
  });

  it("capix_image_gen replaces the base64 raster with an image-id pointer", async () => {
    const base64 = Buffer.alloc(512 * 1024, 7).toString("base64");
    const upstream = {
      imageId: "img_xyz789",
      base64,
      contentType: "image/png",
      prompt: "a capybara trading perpetuals",
      charge: { kind: "balance", amountMinor: "100000", asset: "USDC", scale: 6 },
    };
    const { client } = makeClient({ "/api/v1/images": upstream });
    const out = await tool("capix_image_gen").handler(
      { prompt: "a capybara trading perpetuals" },
      { client, ctx: approvedCtx },
    );

    // The base64 payload itself must not survive into the tool output.
    assert.notEqual(out.base64, base64);
    assert.ok(JSON.stringify(out).length < 1024, "output stays small");
    const placeholder = out.base64 as string;
    assert.match(placeholder, /^\[omitted \d+ chars — /);
    assert.ok(placeholder.includes(String(base64.length)), "placeholder reports the original size");
    assert.ok(placeholder.includes("img_xyz789"), "points at the image id");
    assert.ok(placeholder.includes("/api/v1/memes/img_xyz789"), "points at the retrieval route");

    assert.equal(out.imageId, "img_xyz789");
    assert.equal(out.contentType, "image/png");
    assert.equal(out.prompt, "a capybara trading perpetuals");
    assert.deepEqual(out.charge, { kind: "balance", amountMinor: "100000", asset: "USDC", scale: 6 });
  });

  it("leaves responses without inline payloads untouched", async () => {
    const upstream = { memeId: "meme_1", captions: {}, charge: { kind: "free", freeUsedToday: 1, freePerDay: 3 } };
    const { client } = makeClient({ "/api/v1/memes": upstream });
    const out = await tool("capix_meme").handler({ topic: "gm" }, { client, ctx: approvedCtx });
    assert.deepEqual(out, upstream);
  });
});
