/**
 * Capix MCP Server — shared types.
 *
 * Re-declares the subset of @capix/contracts branded IDs, money, and
 * problem-detail types that the MCP server needs, so this package has zero
 * hard dependencies on the private protocol workspace. The shapes mirror
 * @capix/contracts/src/domain.ts and intelligence.ts exactly.
 *
 * Money is NEVER a JSON number — wire amounts are integer minor/native units
 * serialized as strings (see moneySchema), matching mcp-bridge.ts and the
 * ledger wire form.
 */

// ===========================================================================
// Branded IDs (mirror @capix/contracts/domain.ts)
// ===========================================================================

export type AccountId = string;
export type ProjectId = string;
export type DeploymentId = string;
export type OperationId = string;
export type QuoteId = string;
export type WorkReceiptId = string;
export type AttestationId = string;
export type ProofId = string;
export type WorkloadId = string;
export type SiteId = string;

export type AssetSymbol = "SOL" | "USDC" | "USD-credit";
export type Region = string;
export type ISO8601Timestamp = string;

export interface Money {
  /** Integer minor/native units serialized as a JSON string (never a number). */
  amount: string;
  asset: AssetSymbol;
  /** Integer exponent (SOL=9, USDC=6, USD-credit=2). */
  scale: number;
}

/** RFC 7807 problem+json — the canonical Capix error envelope. */
export interface ProblemDetail {
  type: string;
  title: string;
  status: number;
  detail?: string;
  capixCode: string;
  retryClass?: "none" | "retry" | "retry-after";
  operationId?: OperationId;
  supportId?: string;
  traceId?: string;
  instance?: string;
  errors?: Array<{ field: string; message: string; capixCode?: string }>;
}

// ===========================================================================
// Auth broker types (mirror @capix/auth-broker/src/types.ts)
// ===========================================================================

export type AuthState =
  | "authenticated"
  | "unauthenticated"
  | "refreshing"
  | "error";

export interface AccountInfo {
  accountId: string;
  walletAddress?: string;
  projectId?: string;
  /** Epoch milliseconds when the current access token expires. */
  expiresAt: number;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountId?: string;
}

export interface AuthConfig {
  baseUrl: string;
  clientId: string;
  scope?: string;
  callbackTimeoutMs?: number;
}

export type AuthEvent =
  | { type: "login"; account: AccountInfo }
  | { type: "refresh"; account: AccountInfo }
  | { type: "logout" }
  | { type: "refresh_failed"; reason: string }
  | { type: "token_reuse_detected" };

/** Minimal surface of the @capix/auth-broker AuthBroker class we depend on. */
export interface AuthBrokerLike {
  startLogin(): Promise<{ authorizeUrl: string; state: string }>;
  completeLogin(code: string, state: string): Promise<AccountInfo>;
  startDeviceCodeLogin(): Promise<DeviceCodeChallenge>;
  completeDeviceCodeLogin(challenge: DeviceCodeChallenge): Promise<AccountInfo>;
  getAccessToken(): Promise<string>;
  getState(): AuthState;
  getAccount(): AccountInfo | null;
  logout(): Promise<void>;
  onEvent(handler: (event: AuthEvent) => void): void;
}

export interface DeviceCodeChallenge {
  url: string;
  userCode: string;
  deviceCode: string;
  interval: number;
  expiresIn: number;
}

/** Minimal surface of the credential store we use to load refresh tokens. */
export interface CredentialStoreLike {
  get(service: string, account: string): Promise<string | null>;
  set(service: string, account: string, secret: string): Promise<void>;
  delete(service: string, account: string): Promise<void>;
}

// ===========================================================================
// Tool framework types
// ===========================================================================

/** Logical grouping for a Capix MCP tool (mirrors ToolScope in protocol repo). */
export type ToolScope =
  | "discovery"
  | "planning"
  | "lifecycle"
  | "networking"
  | "testing"
  | "verification"
  | "website"
  | "infra-context";

/** Per-call context threaded into every tool handler. */
export interface ToolCallContext {
  actor: string;
  traceId?: string;
  /**
   * Opaque token proving the user/agent pre-approved the spend for billable
   * tools. The server validates presence (not cryptographic validity) before
   * dispatch — the ledger/covenant layer is authoritative.
   */
  approvalToken?: string;
}

/** Capix API client surface that every tool handler delegates to. */
export interface CapixClientLike {
  get<T = unknown>(
    path: string,
    params?: Record<string, unknown>,
  ): Promise<T>;
  post<T = unknown>(
    path: string,
    body?: Record<string, unknown>,
    opts?: { idempotent?: boolean; approvalToken?: string },
  ): Promise<T>;
  delete<T = unknown>(path: string): Promise<T>;
  isAuthenticated(): boolean;
}

/** Dependencies handed to every tool handler. */
export interface ToolDeps {
  client: CapixClientLike;
  ctx: ToolCallContext;
}

/** A thrown Capix API error carries the parsed problem+json body. */
export class CapixApiError extends Error {
  readonly problem: ProblemDetail;
  readonly status: number;
  readonly capixCode: string;

  constructor(problem: ProblemDetail) {
    super(problem.detail ?? problem.title);
    this.name = "CapixApiError";
    this.problem = problem;
    this.status = problem.status;
    this.capixCode = problem.capixCode;
  }
}

/**
 * A registered Capix MCP tool definition. `inputShape` and `outputShape` are
 * Zod raw shapes (object-property maps) so they can be handed directly to
 * `McpServer.registerTool`'s `inputSchema`/`outputSchema` config. Each tool
 * carries explicit `billable` / `requiresApproval` flags used by the server
 * to enforce the Capix control-plane invariants:
 *
 *   - read-only tools (billable=false, requiresApproval=false) auto-run
 *   - billable / approval-requiring tools MUST carry a bound approvalToken
 */
export interface ToolDef {
  name: string;
  description: string;
  scope: ToolScope;
  /** Whether the tool performs a stateful mutation that may move money. */
  billable: boolean;
  /** Whether the caller MUST supply an approvalToken before dispatch. */
  requiresApproval: boolean;
  /** Zod raw shape describing the tool input arguments. */
  inputShape: Record<string, import("zod").ZodTypeAny>;
  /**
   * Optional Zod raw shape describing the tool's structured output. When set,
   * the MCP server validates structuredContent against it before returning.
   */
  outputShape?: Record<string, import("zod").ZodTypeAny>;
  /** Handler delegates to the Capix API client and returns structured data. */
  handler: (args: Record<string, unknown>, deps: ToolDeps) => Promise<Record<string, unknown>>;
}

export const CAPIX_SCOPE_LABELS: Record<ToolScope, string> = {
  discovery: "Discovery (read-only)",
  planning: "Planning (read-only)",
  lifecycle: "Lifecycle (billable)",
  networking: "Networking (billable)",
  testing: "Testing",
  verification: "Verification (read-only)",
  website: "Website",
  "infra-context": "Infra context (read-only)",
};

/** Convenience flags for declaring billable vs read-only tools. */
export const BILLABLE = { billable: true, requiresApproval: true } as const;
export const APPROVAL_ONLY = { billable: false, requiresApproval: true } as const;
export const READ_ONLY = { billable: false, requiresApproval: false } as const;

/** Capix canonical base URL + OAuth issuer. */
export const DEFAULT_CAPIX_BASE_URL = "https://capix.network";
export const DEFAULT_OAUTH_CLIENT_ID = "capix-mcp";
export const DEFAULT_OAUTH_SCOPE = "capix:deploy capix:billing capix:compute offline_access";
