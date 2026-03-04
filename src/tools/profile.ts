/**
 * sn_profile -- Manage ServiceNow instance profiles at runtime.
 *
 * Actions:
 *   list    - List all configured profiles
 *   active  - Show the currently active profile
 *   switch  - Switch the active (default) profile
 *   info    - Show details for a specific profile
 *   add     - Add a new profile (persisted to config file)
 *
 * @module tools/profile
 */

import { z } from "zod";
import { ProfileManager } from "../profile-manager.js";
import { ok, err } from "../utils.js";

export const definition = {
  name: "sn_profile",
  description:
    "Manage ServiceNow instance profiles. List configured profiles, show the active profile, switch the default, inspect connection details, or add a new profile.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: ["list", "active", "switch", "info", "add"],
        description:
          "Profile operation: list, active, switch, info, or add a new profile",
      },
      name: {
        type: "string",
        description: "Profile name (required for switch, info, and add actions)",
      },
      instance: {
        type: "string",
        description: "ServiceNow instance URL (required for add action, e.g. https://myinstance.service-now.com)",
      },
      username: {
        type: "string",
        description: "ServiceNow username (required for add action)",
      },
      credential: {
        type: "string",
        description: "Credential source (required for add action). Use 'env:VAR_NAME' to reference an environment variable, or a plain string (not recommended).",
      },
      description: {
        type: "string",
        description: "Human-readable description of the profile (optional, for add action)",
      },
    },
    required: ["action"],
  },
};

export const schema = z.object({
  action: z.enum(["list", "active", "switch", "info", "add"]),
  name: z.string().optional(),
  instance: z.string().optional(),
  username: z.string().optional(),
  credential: z.string().optional(),
  description: z.string().optional(),
});

export async function handler(
  args: z.infer<typeof schema>,
  profileManager: ProfileManager
) {
  try {
    switch (args.action) {
      case "list": {
        const profiles = profileManager.listProfiles();
        const active = profileManager.getActiveProfileName();
        return ok({ profiles, active_profile: active });
      }

      case "active": {
        const active = profileManager.getActiveProfileName();
        const config = profileManager.getConfig();
        return ok({
          active_profile: active,
          instance: config.instance,
          user: config.user,
        });
      }

      case "switch": {
        if (!args.name) {
          return err("name is required for the switch action");
        }
        profileManager.switchProfile(args.name);
        const config = profileManager.getConfig();
        return ok({
          switched_to: args.name,
          instance: config.instance,
          user: config.user,
        });
      }

      case "info": {
        if (!args.name) {
          return err("name is required for the info action");
        }
        const config = profileManager.getConfig(args.name);
        const active = profileManager.getActiveProfileName();
        return ok({
          name: args.name,
          instance: config.instance,
          user: config.user,
          display_value: config.displayValue,
          rel_depth: config.relDepth,
          active: args.name === active,
        });
      }

      case "add": {
        if (!args.name) {
          return err("name is required for the add action");
        }
        if (!args.instance) {
          return err("instance is required for the add action (e.g. https://myinstance.service-now.com)");
        }
        if (!args.username) {
          return err("username is required for the add action");
        }
        if (!args.credential) {
          return err("credential is required for the add action (e.g. env:SN_PASSWORD_MYINSTANCE)");
        }
        profileManager.addProfile(args.name, {
          instance: args.instance,
          username: args.username,
          credential: args.credential,
          description: args.description,
        });
        return ok({
          added: args.name,
          instance: args.instance,
          username: args.username,
          credential_source: args.credential.startsWith("env:") ? args.credential : "(plain text)",
          config_path: profileManager.getConfigPath(),
        });
      }

      default:
        return err(`Unknown profile action: ${args.action}`);
    }
  } catch (error) {
    if (error instanceof Error) {
      return err(error.message);
    }
    return err(String(error));
  }
}
