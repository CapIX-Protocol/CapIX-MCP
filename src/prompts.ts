/**
 * Capix MCP Server — prompts.
 *
 * Prompts are parameterised, server-side message templates the MCP client can
 * list and instantiate. Each prompt returns a short multi-message transcript
 * that guides an agent through a common Capix workflow (deploy, diagnose,
 * preview, plan, cleanup) — always ending with an assistant reminder that
 * billable tools require a bound approval token before they will execute.
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
      "Plan, quote, and deploy a repository as a Capix workload (compute or website).",
    arguments: [
      { name: "repoUrl", description: "Git repository URL.", required: true },
      { name: "branch", description: "Branch to deploy (default: main)." },
      { name: "region", description: "Preferred region." },
      { name: "workloadType", description: "Workload type, e.g. replicated_service.v1." },
    ],
  },
  {
    name: "diagnose_deployment",
    description:
      "Diagnose a failing deployment: pull logs, metrics, and health checks.",
    arguments: [
      { name: "deploymentId", description: "Deployment to diagnose.", required: true },
    ],
  },
  {
    name: "create_preview",
    description:
      "Create a preview deployment of a website from a branch.",
    arguments: [
      { name: "siteId", description: "Website project id.", required: true },
      { name: "branch", description: "Branch to preview.", required: true },
    ],
  },
  {
    name: "plan_stack",
    description:
      "Validate and plan a multi-service stack from a manifest URL or inline spec.",
    arguments: [
      { name: "manifestUrl", description: "Stack manifest URL or inline spec.", required: true },
    ],
  },
  {
    name: "cleanup_task",
    description:
      "Destroy all resources scoped to a completed task (§18 cleanup gate).",
    arguments: [
      { name: "taskId", description: "Task-scoped resource id.", required: true },
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
        repoUrl: z.string().describe("Git repository URL."),
        branch: z.string().optional().describe("Branch to deploy (default: main)."),
        region: z.string().optional().describe("Preferred region."),
        workloadType: z.string().optional().describe("Workload type, e.g. replicated_service.v1."),
      },
    },
    async (args) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              `Deploy the repository ${args.repoUrl} (branch ${args.branch ?? "main"}) as a Capix workload.`,
              args.region ? `Target region: ${args.region}.` : "Region: auto-select cheapest feasible.",
              args.workloadType ? `Workload type: ${args.workloadType}.` : "",
              "Steps:",
              "1. capix_compute_plan — plan the deployment shape.",
              "2. capix_compute_quote — obtain a canonical quote.",
              "3. capix_deploy — provision against the quote (requires approvalToken).",
              "4. capix_run_health_checks — verify readiness.",
            ].filter(Boolean).join("\n"),
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
              "1. capix_inspect_logs — recent log lines.",
              "2. capix_inspect_metrics — resource metrics.",
              "3. capix_run_health_checks — probe results.",
              "Summarise the failure mode and propose remediation (restart vs redeploy vs rollback).",
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

  // create_preview
  server.registerPrompt(
    "create_preview",
    {
      description: CAPIX_PROMPTS[2]!.description,
      argsSchema: {
        siteId: z.string().describe("Website project id."),
        branch: z.string().describe("Branch to preview."),
      },
    },
    async (args) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              `Create a preview deployment for website ${args.siteId}, branch ${args.branch}.`,
              "1. capix_website_preview — build a preview (requires approvalToken).",
              "2. Return the preview URL.",
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

  // plan_stack
  server.registerPrompt(
    "plan_stack",
    {
      description: CAPIX_PROMPTS[3]!.description,
      argsSchema: {
        manifestUrl: z.string().describe("Stack manifest URL or inline spec."),
      },
    },
    async (args) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              `Validate and plan the stack manifest at ${args.manifestUrl}.`,
              "1. capix_stack_validate — check the manifest.",
              "2. capix_stack_plan — produce a service plan graph + aggregate quote.",
              "Report feasibility and per-service cost.",
            ].join("\n"),
          },
        },
        {
          role: "assistant" as const,
          content: {
            type: "text" as const,
            text: "Stack planning tools are read-only and may auto-run; no approval token required.",
          },
        },
      ],
    }),
  );

  // cleanup_task
  server.registerPrompt(
    "cleanup_task",
    {
      description: CAPIX_PROMPTS[4]!.description,
      argsSchema: {
        taskId: z.string().describe("Task-scoped resource id."),
      },
    },
    async (args) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              `Destroy all task-scoped resources for ${args.taskId} (§18 cleanup gate).`,
              "1. capix_destroy_task_resources — release allocations (requires approvalToken).",
              "2. capix_receipts — confirm final settlement.",
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
