/**
 * Capix API client — thin wrapper over the Capix network REST API.
 *
 * All deploy/destroy/status/billing calls go through capix.network.
 * The session token is passed as a Bearer header — same as the web console
 * and the Capix IDE extension. So a user who's authenticated anywhere
 * is authenticated everywhere.
 */

const CAPIX_BASE_URL = process.env.CAPIX_BASE_URL?.replace(/\/$/, "") || "https://capix.network";
const CAPIX_API_KEY = process.env.CAPIX_API_KEY || "";

function authHeaders(): Record<string, string> {
  return CAPIX_API_KEY ? { Authorization: `Bearer ${CAPIX_API_KEY}` } : {};
}

async function apiRequest<T>(
  path: string,
  method: "GET" | "POST" | "DELETE" = "GET",
  body?: unknown,
  params?: Record<string, string>,
): Promise<T> {
  const url = new URL(`${CAPIX_BASE_URL}${path}`);
  if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url.toString(), {
    method,
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: body ? JSON.stringify(body) : undefined,
  });

  return res.json() as Promise<T>;
}

// ── Model catalog ──────────────────────────────────────────────────────────

export interface CatalogModel {
  id: string;
  label: string;
  family: string;
  category: string;
  paramB: number;
  minVramGb: number;
  gpuCount: number;
  maxModelLen: number;
  quantization: string;
  gated: boolean;
  tagline: string;
  description: string;
  partner?: string;
  uncensored?: boolean;
  multimodal?: boolean;
  featured?: boolean;
  badge?: string;
}

export async function getCatalog(): Promise<CatalogModel[]> {
  const res = await apiRequest<{ ok: boolean; models: CatalogModel[] }>("/api/llm/models");
  return res.ok ? res.models : [];
}

// ── GPU offers ─────────────────────────────────────────────────────────────

export interface GpuOffer {
  askId: number;
  gpu: string;
  numGpus: number;
  vramGb: number;
  totalVramGb: number;
  cpuCores: number;
  ramGb: number;
  pricePerHr: number;
  roundedPricePerHr: number;
  location: string;
  reliability: number;
}

export async function getOffers(modelId: string, region?: string): Promise<GpuOffer[]> {
  const params: Record<string, string> = { modelId };
  if (region && region !== "global") params.region = region;
  const res = await apiRequest<{ ok: boolean; offers: GpuOffer[] }>("/api/llm/offers", "GET", undefined, params);
  return res.ok ? res.offers : [];
}

// ── Deploy a model ─────────────────────────────────────────────────────────

export interface DeployResult {
  ok: boolean;
  instanceId: number;
  apiKey: string;
  model: { id: string; label: string; maxModelLen: number };
  gpu: string;
  location: string;
  pricePerHr: number;
  chargedUsd: number;
  endpoint: string | null;
  error?: string;
}

export async function deployModel(
  modelId: string,
  askId: number,
  durationHours: number,
  hfToken?: string,
): Promise<DeployResult> {
  return apiRequest<DeployResult>("/api/llm/deploy", "POST", {
    modelId,
    askId,
    durationHours,
    hfToken,
  });
}

// ── Deploy a custom model (Hugging Face link) ──────────────────────────────

export async function deployCustomModel(opts: {
  link: string;
  askId: number;
  durationHours: number;
  minVramGb?: number;
  gpuCount?: number;
  hfToken?: string;
  manual?: boolean;
}): Promise<DeployResult & { error?: string }> {
  return apiRequest<DeployResult & { error?: string }>("/api/llm/custom", "POST", {
    action: "deploy",
    ...opts,
  });
}

// ── Status / endpoint resolution ───────────────────────────────────────────

export interface DeployStatus {
  ok: boolean;
  instanceId: number;
  modelLabel: string;
  hasApiKey: boolean;
  state: "loading" | "running" | "stopped" | "unknown";
  endpoint: string | null;
  ready: boolean;
  baseOpenAiUrl: string | null;
  gpu: string;
  location: string;
  pricePerHr: number;
  sshHost: string | null;
  sshPort: number | null;
}

export async function getDeployStatus(instanceId: number): Promise<DeployStatus> {
  return apiRequest<DeployStatus>(`/api/llm/${instanceId}?action=status`);
}

export async function getDeployApiKey(instanceId: number): Promise<{ ok: boolean; apiKey?: string; error?: string }> {
  return apiRequest(`/api/llm/${instanceId}?action=reveal-key`);
}

// ── List + destroy ─────────────────────────────────────────────────────────

export async function listDeploys(): Promise<{ ok: boolean; deploys: unknown[] }> {
  return apiRequest("/api/llm/0?action=list");
}

export async function destroyDeploy(instanceId: number): Promise<{ ok: boolean }> {
  return apiRequest(`/api/llm/${instanceId}`, "DELETE");
}

// ── Billing ───────────────────────────────────────────────────────────────

export interface BillingData {
  ok: boolean;
  balance: { usd: number; sol: number; usdc: number };
  activeInstances: number;
  totalSpent: number;
}

export async function getBalance(): Promise<BillingData> {
  return apiRequest<BillingData>("/api/cloud/billing");
}

// ── Hosted endpoints ───────────────────────────────────────────────────────

export interface HostedEndpoint {
  modelId: string;
  modelLabel: string;
  baseUrl: string;
  region: string;
  healthy: boolean;
  isSuperGemma: boolean;
  apiKeyMasked: string;
}

export async function getHostedEndpoints(): Promise<HostedEndpoint[]> {
  const res = await apiRequest<{ ok: boolean; endpoints: HostedEndpoint[] }>("/api/llm/hosted");
  return res.ok ? res.endpoints : [];
}

export async function revealHostedKey(modelId: string): Promise<{ ok: boolean; apiKey?: string; error?: string }> {
  return apiRequest(`/api/llm/hosted?reveal=true&modelId=${encodeURIComponent(modelId)}`);
}

export const configured = () => Boolean(CAPIX_API_KEY);
export const baseUrl = () => CAPIX_BASE_URL;
