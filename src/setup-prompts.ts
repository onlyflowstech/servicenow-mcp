/** MCP prompts for local ServiceNow MCP onboarding. */

import { z } from "zod";

import type { McpServerRegistrationSurface } from "./server.js";

const profileNameArg = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .optional()
  .describe("Desired ServiceNow MCP profile name, for example dev or prod.");

const instanceArg = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .optional()
  .describe("ServiceNow instance origin, for example https://dev.service-now.com.");

const authTypeArg = z
  .enum(["oauth", "basic", "apikey"])
  .optional()
  .describe("Authentication mode to configure with the protected profile CLI.");

type PromptSurface = Pick<McpServerRegistrationSurface, "registerPrompt">;

/** Register prompts that let MCP clients expose a safe setup slash-command flow. */
export function registerSetupPrompts(surface: PromptSurface): void {
  surface.registerPrompt(
    "servicenow-mcp.add-profile",
    {
      title: "Add a ServiceNow MCP profile",
      description:
        "Guide creation of an explicit, default-deny ServiceNow profile without putting secrets in chat or argv.",
      argsSchema: {
        profile: profileNameArg,
        instance: instanceArg,
        auth_type: authTypeArg,
      },
    },
    (args) => {
      const profile = args.profile?.trim() || "dev";
      const instance = args.instance?.trim() || "https://yourinstance.service-now.com";
      const authType = args.auth_type || "oauth";
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: renderAddProfilePrompt(profile, instance, authType),
            },
          },
        ],
      };
    }
  );
}

function renderAddProfilePrompt(
  profile: string,
  instance: string,
  authType: "oauth" | "basic" | "apikey"
): string {
  const command = profileCreateCommand(profile, instance, authType);
  return [
    "Help me add this ServiceNow MCP profile safely.",
    "",
    `Profile: ${profile}`,
    `Instance: ${instance}`,
    `Auth type: ${authType}`,
    "",
    "Rules:",
    "- Do not ask me to paste ServiceNow passwords, API keys, client secrets, bearer tokens, encryption keys, or secret-reference values into chat.",
    "- Use the protected local CLI for credential capture; it prompts or reads bounded stdin so secrets do not enter argv or shell history.",
    "- Keep the profile explicit. Do not create or rely on any default profile.",
    "- Table access is default-deny. Ask me which tables I need and whether each is read or write before proposing a grant, and propose the narrowest set that does the job.",
    "",
    "Step 1 - create the profile. Run this locally:",
    command,
    "",
    "Step 2 - grant least-privilege table access. A profile with no rules denies",
    "every tool call, so this step is required. Substitute my answers for the",
    "table names; do not guess them:",
    grantCommand(profile),
    "",
    "Notes on step 2:",
    "- Default tools are sn_query, sn_get, sn_aggregate, sn_schema for a read grant, plus sn_create and sn_update for a write grant. Add --tools to narrow further.",
    "- sn_delete, sn_batch, and sn_atf are never granted implicitly; name them with --tools only if I ask.",
    "- If a table extends another (change_request and task, for example), add --related \"<table>=<parent>\".",
    "- Add --dry-run first to show me the resulting rules before writing them.",
    "",
    `Step 3 - verify. Run "servicenow-mcp-setup doctor --profile ${profile}" and report`,
    "any failed check with the remedy it prints. Then confirm with a safe diagnostic",
    "call such as sn_profile using the explicit profile name. Restart the service",
    "after any profile change.",
  ].join("\n");
}

function grantCommand(profile: string): string {
  return [
    "servicenow-mcp-setup",
    "grant",
    "--profile",
    shellQuote(profile),
    "--read",
    "<comma,separated,read,tables>",
    "--write",
    "<comma,separated,write,tables>",
  ].join(" ");
}

function profileCreateCommand(
  profile: string,
  instance: string,
  authType: "oauth" | "basic" | "apikey"
): string {
  const base = [
    "servicenow-mcp-profile",
    "create",
    "--name",
    shellQuote(profile),
    "--instance",
    shellQuote(instance),
    "--auth-type",
    authType,
  ];
  if (authType === "oauth") {
    base.push("--client-id", "<client-id>", "--source", "reference", "--provider", "env");
  } else if (authType === "basic") {
    base.push("--username", "<username>", "--source", "encrypted");
  } else {
    base.push("--api-key-header", "Authorization", "--source", "reference", "--provider", "env");
  }
  return base.join(" ");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}
