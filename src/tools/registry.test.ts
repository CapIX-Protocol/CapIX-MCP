/**
 * Registry gate — the anti-regression test for the 2026-07 repair.
 *
 * Every registered tool declares the canonical control-plane path it
 * dispatches to (ToolDef.routePath). This suite asserts that each of those
 * paths targets a route family that EXISTS in the control plane, as encoded
 * in ../route-families.ts from the live audit of app/api/v1/* — and that no
 * tool regresses onto a family that was removed because the backend never
 * implemented it (e.g. /api/v1/website singular, /api/v1/networking,
 * /api/v1/verification).
 *
 * Runs on the built-in node:test runner via tsx (no extra dev dependency):
 *   npm test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { TOOLS, TOOL_COUNT, TOOL_NAMES } from "../tools.js";
import {
  REAL_ROUTE_FAMILIES,
  REMOVED_ROUTE_FAMILIES,
  isRealRoutePath,
  isRemovedRoutePath,
} from "../route-families.js";

describe("registry route-family gate", () => {
  it("every tool declares a routePath inside a REAL route family", () => {
    for (const t of TOOLS) {
      assert.ok(t.routePath, `${t.name} has no routePath declaration`);
      assert.ok(
        isRealRoutePath(t.routePath),
        `${t.name} targets ${t.routePath}, which is outside REAL_ROUTE_FAMILIES — ` +
          "either the route family does not exist upstream (remove the tool) or the " +
          "allowlist needs a new entry with backend evidence",
      );
    }
  });

  it("no tool targets a removed (never-implemented) route family", () => {
    for (const t of TOOLS) {
      assert.ok(
        !isRemovedRoutePath(t.routePath),
        `${t.name} targets removed family ${t.routePath}`,
      );
    }
  });

  it("registers exactly 37 tools with no name collisions", () => {
    assert.equal(TOOL_COUNT, 37);
    assert.equal(TOOLS.length, 37);
    assert.equal(new Set(TOOL_NAMES).size, TOOL_NAMES.length);
  });

  it("uses only scopes that have live tools", () => {
    const scopes = new Set(TOOLS.map((t) => t.scope));
    assert.deepEqual([...scopes].sort(), [
      "discovery",
      "infra-context",
      "lifecycle",
      "planning",
      "verification",
      "website",
    ]);
  });
});

describe("route-family allowlist helpers", () => {
  it("distinguishes the plural websites family from the removed singular", () => {
    assert.ok(isRealRoutePath("/api/v1/websites"));
    assert.ok(isRealRoutePath("/api/v1/websites/:id/promote"));
    assert.ok(isRemovedRoutePath("/api/v1/website/sites"));
    assert.ok(!isRealRoutePath("/api/v1/website/sites"));
  });

  it("flags every removed family as not real", () => {
    for (const prefix of REMOVED_ROUTE_FAMILIES) {
      assert.ok(isRemovedRoutePath(prefix), `${prefix} should be flagged removed`);
      // /api/v1/account/balance nests under the REAL /api/v1/account family,
      // so the family-level gate cannot reject it by prefix; every other
      // removed family must be rejected outright.
      if (prefix === "/api/v1/account/balance") continue;
      assert.ok(!isRealRoutePath(`${prefix}/anything`), `${prefix}/anything should not be real`);
    }
  });

  it("accepts :param paths for every real family", () => {
    for (const { prefix } of REAL_ROUTE_FAMILIES) {
      assert.ok(isRealRoutePath(prefix), prefix);
      assert.ok(isRealRoutePath(`${prefix}/:id`), prefix);
    }
  });

  it("rejects unknown families", () => {
    assert.ok(!isRealRoutePath("/api/v1/nope"));
    assert.ok(!isRealRoutePath("/api/v2/jobs"));
    assert.ok(!isRealRoutePath("/api/v1"));
  });
});
