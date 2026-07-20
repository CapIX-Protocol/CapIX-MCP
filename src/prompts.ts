/**
 * Capix MCP Server — prompts.
 *
 * Prompts are parameterised, server-side message templates the MCP client can
 * list and instantiate. Each prompt returns a short multi-message transcript
 * that guides an agent through a common Capix workflow (deploy, diagnose,
 * ship a website, cleanup) — always ending with an assistant reminder that
 * billable tools require a bound approval token before they will execute.
 *
 * 2026-07 repair: every prompt references only tools that exist in the
 * post-repair registry. The plan_stack prompt was removed (no stack backend)
 * and create_preview became ship_website (website previews are implicit per
 * release; there is no preview-trigger route).
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** Static prompt descriptor surfaced via prompts/list. */
export interface CapixPrompt {
  name: string;
  description: string;
  arguments: Array<{ name: string; description: string; required?: boolean }>;
}

export const CAPIX_PROMPTS: CapixPrompt[] = [
  {
    name: "deploy_repository",
    description:
      "Quote and deploy a workload on Capix compute, then track the operation.",
    arguments: [
      { name: "workloadType", description: "Workload type, e.g. replicated_service.v1.", required: true },
      { name: "region", description: "Preferred region (eu | us | asia | global)." },
    ],
  },
  {
    name: "diagnose_deployment",
    description:
      "Diagnose a failing deployment: inspect phase, placement receipt, and settlement.",
    arguments: [
      { name: "deploymentId", description: "Deployment to diagnose.", required: true },
    ],
  },
  {
    name: "ship_website",
    description:
      "Create a website from a source ref, wait for the build, and promote it to production.",
    arguments: [
      { name: "name", description: "Site name.", required: true },
      { name: "sourceRef", description: "Source reference (repository/archive URL).", required: true },
    ],
  },
  {
    name: "cleanup_task",
    description:
      "Destroy the resources created for a completed task (§18 cleanup gate).",
    arguments: [
      { name: "taskId", description: "Task label for the cleanup summary.", required: true },
    ],
  },
];

const APPROVAL_REMINDER =
  "Plan validated. Awaiting your approval token before any billable Capix tool runs.";

/**
 * Register all Capix prompts with the given McpServer. Prompt callbacks are
 * pure (no API calls) — they render a guided transcript the agent then drives
 * by calling the referenced tools.
 */
export function registerPrompts(server: McpServer): void {
  // deploy_repository
  server.registerPrompt(
    "deploy_repository",
    {
      description: CAPIX_PROMPTS[0]!.description,
      argsSchema: {
        workloadType: z.string().describe("Workload type, e.g. replicated_service.v1."),
        region: z.string().optional().describe("Preferred region (eu | us | asia | global)."),
      },
    },
    async (args) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              `Deploy a ${args.workloadType} workload on Capix.`,
              args.region ? `Target region: ${args.region}.` : "Region: auto-select cheapest feasible.",
              "Steps:",
              "1. capix_compute_catalog — confirm the workload type is enabled and pick a provider/region.",
              "2. capix_compute_quote — obtain a canonical quote (15-minute TTL).",
              "3. capix_deploy — provision against the quote (requires approvalToken).",
              "4. capix_deployments — track the deployment phase until ready.",
            ].join("\n"),
          },
        },
        {
          role: "assistant" as const,
          content: { type: "text" as const, text: APPROVAL_REMINDER },
        },
      ],
    }),
  );

  // diagnose_deployment
  server.registerPrompt(
    "diagnose_deployment",
    {
      description: CAPIX_PROMPTS[1]!.description,
      argsSchema: {
        deploymentId: z.string().describe("Deployment to diagnose."),
      },
    },
    async (args) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              `Diagnose deployment ${args.deploymentId}:`,
              "1. capix_deployments — locate the deployment, its phase, and its allocations.",
              "2. capix_inspect_receipt — review the signed route receipt (placement + pricing evidence) behind it.",
              "3. capix_receipts — check the account's work receipts for related failures.",
              "Summarise the failure mode and propose remediation (redeploy vs terminate).",
            ].join("\n"),
          },
        },
        {
          role: "assistant" as const,
          content: {
            type: "text" as const,
            text: "Diagnosis plan ready. All inspection tools are read-only and may auto-run; no approval token required.",
          },
        },
      ],
    }),
  );

  // ship_website
  server.registerPrompt(
    "ship_website",
    {
      description: CAPIX_PROMPTS[2]!.description,
      argsSchema: {
        name: z.string().describe("Site name."),
        sourceRef: z.string().describe("Source reference (repository/archive URL)."),
      },
    },
    async (args) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              `Ship the website ${args.name} from ${args.sourceRef}.`,
              "1. capix_website_create — create + build (requires approvalToken).",
              "2. capix_website_get — poll until the latest release is built (check its status/step/logTail).",
              "3. Return the preview URL, then capix_website_promote — promote to production (requires approvalToken).",
            ].join("\n"),
          },
        },
        {
          role: "assistant" as const,
          content: { type: "text" as const, text: APPROVAL_REMINDER },
        },
      ],
    }),
  );

  // cleanup_task
  server.registerPrompt(
    "cleanup_task",
    {
      description: CAPIX_PROMPTS[3]!.description,
      argsSchema: {
        taskId: z.string().describe("Task label for the cleanup summary."),
      },
    },
    async (args) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              `Destroy all resources created for ${args.taskId} (§18 cleanup gate).`,
              "1. capix_deployments / capix_agent_list / capix_website_list — enumerate what is still running.",
              "2. capix_delete / capix_agent_destroy / capix_website_destroy — release each one (requires approvalToken).",
              "3. capix_receipts — confirm final settlement.",
            ].join("\n"),
          },
        },
        {
          role: "assistant" as const,
          content: { type: "text" as const, text: APPROVAL_REMINDER },
        },
      ],
    }),
  );
}
