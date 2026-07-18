/**
 * Capix API client — the canonical HTTP boundary for the MCP server.
 *
 * Every tool handler delegates to an instance of this class; the client is the
 * only place that touches `fetch`, auth headers, problem+json parsing, or
 * idempotency keys. Mirrors the conventions of
 * services/intelligence/mcp-bridge.ts and Capix-Backend API routes.
 *
 * Design guarantees:
 *
 *   - canonical endpoints   — all calls go to `/api/v1/*` (never legacy
 *                             `/api/llm/*` or `/api/cloud/*` paths).
 *   - problem+json          — non-2xx responses are parsed as RFC 7807
 *                             ProblemDetail and surfaced as CapixApiError.
 *   - idempotency keys      — POST/DELETE mutations get an `Idempotency-Key`
 *                             header derived from the request body so retries
 *                             are safe (§4 ledger holds are deduped upstream).
 *   - approval tokens       — billable mutations forward the bound
 *                             approvalToken as `X-Capix-Approval-Token`.
 *   - auth broker first     — when `@capix/auth-broker` is importable and a
 *                             stored refresh token exists, the client obtains
 *                             a fresh OAuth access token via the broker's
 *                             crash-safe dual-slot rotation. Otherwise it
 *                             falls back to the `CAPIX_API_KEY` env var.
 */

import { randomUUID, createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  AccountInfo,
  AuthBrokerLike,
  AuthConfig,
  AuthState,
  CapixClientLike,
  ProblemDetail,
  TokenSet,
} from "./types.js";
import { CapixApiError, DEFAULT_CAPIX_BASE_URL, DEFAULT_OAUTH_CLIENT_ID, DEFAULT_OAUTH_SCOPE } from "./types.js";

// ===========================================================================
// Auth providers
// ===========================================================================

/** A pluggable source of a Bearer access token for the API client. */
export interface AuthProvider {
  getToken(): Promise<string | null>;
  isAuthenticated(): boolean;
  getAccount(): AccountInfo | null;
}

/** Stateless provider that returns a static API key from the environment. */
export class ApiKeyAuthProvider implements AuthProvider {
  private readonly apiKey: string;
  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }
  async getToken(): Promise<string | null> {
    return this.apiKey || null;
  }
  isAuthenticated(): boolean {
    return Boolean(this.apiKey);
  }
  getAccount(): AccountInfo | null {
    return null;
  }
}

/**
 * Provider backed by the shared @capix/auth-broker. The broker itself is
 * dynamically imported so this package has no hard dependency on the private
 * protocol workspace.
 */
export class BrokerAuthProvider implements AuthProvider {
  private readonly broker: AuthBrokerLike;
  private cached: { token: string; expiresAt: number } | null = null;

  constructor(broker: AuthBrokerLike) {
    this.broker = broker;
  }

  async getToken(): Promise<string | null> {
    if (this.cached && this.cached.expiresAt > Date.now() + 60_000) {
      return this.cached.token;
    }
    // Do NOT gate on the synchronous getState() here: the shared broker
    // awaits its credential-store load internally and single-flights the
    // refresh grant, so a cold-started process can mint a token even before
    // getState() flips to "authenticated".
    try {
      const token = await this.broker.getAccessToken();
      const account = this.broker.getAccount();
      this.cached = { token, expiresAt: account?.expiresAt ?? Date.now() + 3_600_000 };
      return token;
    } catch {
      return null;
    }
  }

  isAuthenticated(): boolean {
    return this.cached !== null || this.broker.getState() === "authenticated";
  }

  getAccount(): AccountInfo | null {
    return this.broker.getAccount();
  }
}

/**
 * Try to construct a BrokerAuthProvider by dynamically importing
 * `@capix/auth-broker`. Returns null when the package is not installed or no
 * stored credentials are present, so the caller can fall back to an API key.
 */
export async function tryCreateBrokerAuthProvider(opts?: {
  baseUrl?: string;
  clientId?: string;
  scope?: string;
}): Promise<BrokerAuthProvider | null> {
  const baseUrl = opts?.baseUrl ?? process.env.CAPIX_BASE_URL ?? DEFAULT_CAPIX_BASE_URL;
  const clientId = opts?.clientId ?? process.env.CAPIX_OAUTH_CLIENT_ID ?? DEFAULT_OAUTH_CLIENT_ID;
  const scope = opts?.scope ?? DEFAULT_OAUTH_SCOPE;

  // Dynamic import of the optional @capix/auth-broker peer dependency. The
  // ambient declaration in src/auth-broker.d.ts lets TypeScript resolve the
  // module at compile time; the runtime import succeeds only when the package
  // is actually installed.
  let mod: typeof import("@capix/auth-broker") | null = null;
  try {
    mod = await import("@capix/auth-broker");
  } catch {
    return null;
  }
  if (!mod) return null;

  // Prefer the shared package's platform-aware store selection (OS keychain
  // via keytar/security/cmdkey/secret-tool, 0600 file fallback). The explicit
  // Keytar→File chain below supports older broker builds that predate
  // createDefaultCredentialStore.
  let store: import("@capix/auth-broker").CredentialStore;
  if (typeof mod.createDefaultCredentialStore === "function") {
    store = mod.createDefaultCredentialStore(clientId);
  } else {
    try {
      store = new mod.KeytarCredentialStore(clientId);
    } catch {
      store = new mod.FileCredentialStore(join(homedir(), ".capix", "credentials.json"));
    }
  }

  const config: AuthConfig = { baseUrl, clientId, scope };
  const broker: AuthBrokerLike = new mod.AuthBroker(config, store);

  // If there's no stored refresh token we cannot authenticate headlessly.
  const active = await store.get(clientId, "refresh-token:active").catch(() => null);
  if (!active) return null;

  return new BrokerAuthProvider(broker);
}

/** Resolve the best available auth provider: broker first, then API key. */
export async function resolveAuthProvider(opts?: {
  baseUrl?: string;
  apiKey?: string;
}): Promise<AuthProvider> {
  const broker = await tryCreateBrokerAuthProvider({ baseUrl: opts?.baseUrl });
  if (broker) return broker;

  const key = opts?.apiKey ?? process.env.CAPIX_API_KEY ?? "";
  return new ApiKeyAuthProvider(key);
}

// ===========================================================================
// Canonical Capix API client
// ===========================================================================

export interface CapixClientOptions {
  baseUrl: string;
  authProvider: AuthProvider;
  /** Default project id used for unscoped read calls. */
  projectId?: string;
  /** Optional fetch override (for tests). */
  fetchImpl?: typeof fetch;
  /** Logger for diagnostic stderr output. */
  log?: (msg: string) => void;
}

export class CapixClient implements CapixClientLike {
  private readonly baseUrl: string;
  private readonly auth: AuthProvider;
  private readonly projectId?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly log: (msg: string) => void;

  constructor(opts: CapixClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.auth = opts.authProvider;
    this.projectId = opts.projectId ?? process.env.CAPIX_PROJECT_ID;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.log = opts.log ?? (() => {});
  }

  isAuthenticated(): boolean {
    return this.auth.isAuthenticated();
  }

  getAccount(): AccountInfo | null {
    return this.auth.getAccount();
  }

  getProjectId(): string | undefined {
    return this.projectId;
  }

  // -------------------------------------------------------------------------
  // Core HTTP methods — all canonical /api/v1/* paths.
  // -------------------------------------------------------------------------

  async get<T = unknown>(
    path: string,
    params?: Record<string, unknown>,
  ): Promise<T> {
    const url = this.buildUrl(path, params);
    const token = await this.requireToken();
    const res = await this.fetchImpl(url, {
      method: "GET",
      headers: this.headers(token),
    });
    return this.parse<T>(res, "GET", path);
  }

  async post<T = unknown>(
    path: string,
    body?: Record<string, unknown>,
    opts?: { idempotent?: boolean; approvalToken?: string },
  ): Promise<T> {
    const url = this.buildUrl(path);
    const token = await this.requireToken();
    const headers: Record<string, string> = this.headers(token);
    if (opts?.idempotent) {
      headers["Idempotency-Key"] = this.idempotencyKey(path, body);
    }
    if (opts?.approvalToken) {
      headers["X-Capix-Approval-Token"] = opts.approvalToken;
    }
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    return this.parse<T>(res, "POST", path);
  }

  async delete<T = unknown>(path: string): Promise<T> {
    const url = this.buildUrl(path);
    const token = await this.requireToken();
    const headers = this.headers(token);
    headers["Idempotency-Key"] = this.idempotencyKey(path);
    const res = await this.fetchImpl(url, { method: "DELETE", headers });
    return this.parse<T>(res, "DELETE", path);
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private buildUrl(path: string, params?: Record<string, unknown>): string {
    const url = new URL(this.baseUrl + path);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === null) continue;
        if (Array.isArray(v)) {
          for (const item of v) url.searchParams.append(k, String(item));
        } else if (typeof v === "object") {
          url.searchParams.set(k, JSON.stringify(v));
        } else if (typeof v === "boolean") {
          url.searchParams.set(k, v ? "true" : "false");
        } else {
          url.searchParams.set(k, String(v));
        }
      }
    }
    return url.toString();
  }

  private headers(token: string): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (token) h.Authorization = `Bearer ${token}`;
    if (this.projectId) h["X-Capix-Project"] = this.projectId;
    return h;
  }

  private async requireToken(): Promise<string> {
    const token = await this.auth.getToken();
    if (!token) {
      const problem: ProblemDetail = {
        type: "about:blank",
        title: "Not authenticated",
        status: 401,
        detail:
          "No Capix credentials available. Run `capix-mcp login` to authenticate via OAuth, or set CAPIX_API_KEY.",
        capixCode: "not_authenticated",
        retryClass: "none",
      };
      throw new CapixApiError(problem);
    }
    return token;
  }

  /**
   * Derive a stable idempotency key from the request path + body hash + a
   * fresh nonce. The nonce ensures that the *caller's* retries (same args)
   * collapse while distinct invocations get distinct keys.
   */
  private idempotencyKey(path: string, body?: unknown): string {
    const nonce = randomUUID();
    const bodyHash = body ? createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 16) : "0";
    const pathHash = createHash("sha256").update(path).digest("hex").slice(0, 16);
    return `capix-${pathHash}-${bodyHash}-${nonce}`;
  }

  /**
   * Parse a fetch Response. Non-2xx responses are decoded as problem+json
   * (RFC 7807) and thrown as CapixApiError. Empty 204 responses yield null.
   */
  private async parse<T>(res: Response, method: string, path: string): Promise<T> {
    if (res.status === 204) return null as T;

    const contentType = res.headers.get("content-type") ?? "";

    if (!res.ok) {
      let problem: ProblemDetail;
      if (contentType.includes("application/problem+json") || contentType.includes("application/json")) {
        try {
          problem = (await res.json()) as ProblemDetail;
        } catch {
          problem = this.fallbackProblem(res, method, path);
        }
      } else {
        problem = this.fallbackProblem(res, method, path);
      }
      if (!problem.capixCode) problem.capixCode = "http_error";
      if (!problem.status) problem.status = res.status;
      this.log(`${method} ${path} → ${res.status} (${problem.capixCode})`);
      throw new CapixApiError(problem);
    }

    if (contentType.includes("application/json")) {
      return (await res.json()) as T;
    }
    // Fallback: treat as text.
    const text = await res.text();
    return (text || null) as unknown as T;
  }

  private fallbackProblem(res: Response, method: string, path: string): ProblemDetail {
    return {
      type: "about:blank",
      title: `${method} ${path} failed`,
      status: res.status,
      detail: `Capix API returned ${res.status} ${res.statusText} for ${method} ${path}`,
      capixCode: res.status >= 500 ? "upstream_error" : "http_error",
      retryClass: res.status >= 500 ? "retry-after" : "none",
    };
  }
}

// ===========================================================================
// Convenience factory
// ===========================================================================

/** Build a CapixClient from environment defaults (broker → API key fallback). */
export async function createClient(opts?: {
  baseUrl?: string;
  apiKey?: string;
  projectId?: string;
  log?: (msg: string) => void;
}): Promise<CapixClient> {
  const baseUrl = opts?.baseUrl ?? process.env.CAPIX_BASE_URL ?? DEFAULT_CAPIX_BASE_URL;
  const authProvider = await resolveAuthProvider({ baseUrl, apiKey: opts?.apiKey });
  return new CapixClient({
    baseUrl,
    authProvider,
    projectId: opts?.projectId,
    log: opts?.log,
  });
}

export type { AuthState, TokenSet };
