/**
 * Capix MCP Server — resources (capix:// URIs).
 *
 * Resources are read-only views the MCP client can list and read by URI. They
 * mirror the discovery + website sub-ports: account, balance, projects,
 * catalogs, deployments, receipts, attestations, websites, and memory/skills
 * intelligence surfaces.
 *
 * `registerResources(server, client)` wires each `capix://…` URI to a
 * `readResource` callback that delegates to the canonical Capix API client.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CapixClient } from "./client.js";

/** Static resource descriptor surfaced via resources/list. */
export interface CapixResource {
  uri: string;
  name: string;
  description: string;
  mimeType: "application/json";
}

export const CAPIX_RESOURCES: CapixResource[] = [
  {
    uri: "capix://account",
    name: "Account",
    description: "Authenticated account inspection snapshot (wallet, spending limit, active deploys).",
    mimeType: "application/json",
  },
  {
    uri: "capix://balance",
    name: "Balance",
    description: "Customer cash balance (available / held / total) per asset.",
    mimeType: "application/json",
  },
  {
    uri: "capix://projects",
    name: "Projects",
    description: "Projects visible to the authenticated account.",
    mimeType: "application/json",
  },
  {
    uri: "capix://models",
    name: "Models",
    description: "Live model endpoint catalog (model id, context length, price per 1k tokens).",
    mimeType: "application/json",
  },
  {
    uri: "capix://deployments",
    name: "Deployments",
    description: "Deployments for the account/project with phase + allocation state.",
    mimeType: "application/json",
  },
  {
    uri: "capix://receipts",
    name: "Receipts",
    description: "Settled work receipts (cost records).",
    mimeType: "application/json",
  },
  {
    uri: "capix://memory",
    name: "Memory",
    description: "Recent Capix intelligence memory nodes for the active project.",
    mimeType: "application/json",
  },
  {
    uri: "capix://skills",
    name: "Skills",
    description: "Registered Capix skills available to the project.",
    mimeType: "application/json",
  },
];

/** canonical → API path mapping for each capix:// resource. */
type ResourceReader = (client: CapixClient) => Promise<unknown>;

const RESOURCE_READERS: Record<string, ResourceReader> = {
  account: (c) => c.get("/api/v1/account"),
  balance: (c) => c.get("/api/v1/account/balance"),
  projects: (c) => c.get("/api/v1/projects", { limit: 50 }),
  models: (c) => c.get("/api/v1/catalog/models"),
  deployments: (c) => c.get("/api/v1/deployments", { limit: 50 }),
  receipts: (c) => c.get("/api/v1/receipts", { limit: 50 }),
  memory: (c) => c.get("/api/v1/account/memory"),
  skills: (c) => c.get("/api/v1/account/skills"),
};

/**
 * Register all capix:// resources with the given McpServer. Each resource's
 * read callback delegates to the canonical Capix API client and returns the
 * raw JSON object as a text content block.
 */
export function registerResources(server: McpServer, client: CapixClient): void {
  for (const res of CAPIX_RESOURCES) {
    const key = res.uri.replace(/^capix:\/\//, "");
    const reader = RESOURCE_READERS[key];
    if (!reader) continue;

    server.registerResource(res.name, res.uri, {
      description: res.description,
      mimeType: res.mimeType,
    }, async () => {
      const data = await reader(client);
      const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
      return {
        contents: [
          {
            uri: res.uri,
            mimeType: res.mimeType,
            text,
          },
        ],
      };
    });
  }
}
