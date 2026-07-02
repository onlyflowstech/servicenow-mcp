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
import { ProfileManager, Profile } from "../profile-manager.js";
import { ok, err, withWarnings } from "../utils.js";

export const definition = {
  name: "sn_profile",
  description:
    "Manage ServiceNow instance profiles. List configured profiles, show the active profile, switch the default, inspect connection details, or add a new profile (persisted to the config file). " +
    'Add examples -- basic: {action:"add", name:"dev", instance:"https://dev.service-now.com", username:"admin", credential:"env:SN_PASSWORD_DEV"}; ' +
    'oauth: {action:"add", name:"dev", instance:"https://dev.service-now.com", auth_type:"oauth", client_id:"<client_id>", client_secret:"env:SN_CLIENT_SECRET_DEV"} (grant_type "password" additionally needs username + credential); ' +
    'apikey: {action:"add", name:"dev", instance:"https://dev.service-now.com", auth_type:"apikey", api_key:"env:SN_API_KEY_DEV"}. ' +
    "Secrets (credential, client_secret, api_key) must be env:VAR_NAME references to variables set in the server's environment -- plain-text secrets are rejected.",
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
        description: "ServiceNow username (add action: required for basic auth and the OAuth \"password\" grant)",
      },
      credential: {
        type: "string",
        description: "Credential source (add action: required for basic auth and the OAuth \"password\" grant). Must be 'env:VAR_NAME' referencing an environment variable -- plain-text secrets are never persisted.",
      },
      description: {
        type: "string",
        description: "Human-readable description of the profile (optional, for add action)",
      },
      auth_type: {
        type: "string",
        enum: ["basic", "oauth", "apikey"],
        description:
          'Auth scheme for the add action (default "basic"). "oauth" requires client_id + client_secret (plus username + credential when grant_type is "password"); "apikey" requires api_key.',
      },
      client_id: {
        type: "string",
        description: 'OAuth client id (add action, required when auth_type is "oauth")',
      },
      client_secret: {
        type: "string",
        description:
          'OAuth client secret source (add action, required when auth_type is "oauth"). Must be \'env:VAR_NAME\' referencing an environment variable -- plain-text secrets are never persisted.',
      },
      grant_type: {
        type: "string",
        enum: ["client_credentials", "password"],
        description:
          'OAuth grant type (add action, default "client_credentials"). "password" additionally requires username and credential.',
      },
      api_key: {
        type: "string",
        description:
          'API key source (add action, required when auth_type is "apikey"). Must be \'env:VAR_NAME\' referencing an environment variable -- plain-text secrets are never persisted.',
      },
      api_key_header: {
        type: "string",
        description: 'Header the API key is sent in (add action, default "x-sn-apikey")',
      },
      timeout_ms: {
        type: "integer",
        minimum: 1,
        description: "Per-request timeout in ms for this profile (add action, default 30000)",
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
  auth_type: z.enum(["basic", "oauth", "apikey"]).optional(),
  client_id: z.string().optional(),
  client_secret: z.string().optional(),
  grant_type: z.enum(["client_credentials", "password"]).optional(),
  api_key: z.string().optional(),
  api_key_header: z.string().optional(),
  timeout_ms: z.number().int().min(1).optional(),
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
        // NOTE: never include secret material here (password, clientSecret,
        // apiKey) -- this output goes straight into the model context.
        return ok({
          name: args.name,
          instance: config.instance,
          user: config.user,
          auth_type: config.authType ?? "basic",
          display_value: config.displayValue,
          rel_depth: config.relDepth,
          timeout_ms: config.timeoutMs,
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

        const authType = args.auth_type ?? "basic";

        // Per-auth-type required parameters (mirrors ProfileManager.getConfig,
        // which only resolves a user credential for basic auth and the OAuth
        // "password" grant).
        if (authType === "oauth") {
          if (!args.client_id) {
            return err('client_id is required when auth_type is "oauth"');
          }
          if (!args.client_secret) {
            return err('client_secret is required when auth_type is "oauth" (e.g. env:SN_CLIENT_SECRET_MYINSTANCE)');
          }
        }
        if (authType === "apikey" && !args.api_key) {
          return err('api_key is required when auth_type is "apikey" (e.g. env:SN_API_KEY_MYINSTANCE)');
        }
        const needsUserCredential =
          authType === "basic" ||
          (authType === "oauth" && args.grant_type === "password");
        if (needsUserCredential) {
          const reason =
            authType === "basic"
              ? "basic auth (the default auth_type)"
              : 'the OAuth "password" grant';
          if (!args.username) {
            return err(`username is required for ${reason}`);
          }
          if (!args.credential) {
            return err(`credential is required for ${reason} (e.g. env:SN_PASSWORD_MYINSTANCE)`);
          }
        }

        // Secrets must use env:VAR_NAME indirection. ProfileManager enforces
        // the same rule before persisting; checking here names the exact
        // tool parameter and explains the convention.
        const secretParams: Array<[param: string, value: string | undefined]> = [
          ["credential", args.credential],
          ["client_secret", args.client_secret],
          ["api_key", args.api_key],
        ];
        for (const [param, value] of secretParams) {
          const problem = envRefError(value, param);
          if (problem) {
            return err(problem);
          }
        }

        // The profile persists fine with an unset env var, but it cannot
        // authenticate until the variable exists -- warn instead of failing.
        const warnings: string[] = [];
        for (const [param, value] of secretParams) {
          const warning = unsetEnvWarning(value, param);
          if (warning) {
            warnings.push(warning);
          }
        }

        const profile: Profile = {
          instance: args.instance,
          username: args.username,
          credential: args.credential,
          description: args.description,
        };
        if (args.auth_type !== undefined) profile.authType = args.auth_type;
        if (args.client_id !== undefined) profile.clientId = args.client_id;
        if (args.client_secret !== undefined) profile.clientSecret = args.client_secret;
        if (args.grant_type !== undefined) profile.grantType = args.grant_type;
        if (args.api_key !== undefined) profile.apiKey = args.api_key;
        if (args.api_key_header !== undefined) profile.apiKeyHeader = args.api_key_header;
        if (args.timeout_ms !== undefined) profile.timeoutMs = args.timeout_ms;

        profileManager.addProfile(args.name, profile);

        // NOTE: only env: references (never resolved secret values) may
        // appear here -- this output goes straight into the model context.
        return ok(
          withWarnings(
            {
              added: args.name,
              instance: args.instance,
              auth_type: authType,
              username: args.username,
              credential_source: args.credential,
              client_id: args.client_id,
              client_secret_source: args.client_secret,
              grant_type:
                authType === "oauth"
                  ? args.grant_type ?? "client_credentials"
                  : args.grant_type,
              api_key_source: args.api_key,
              api_key_header: args.api_key_header,
              timeout_ms: args.timeout_ms,
              config_path: profileManager.getConfigPath(),
            },
            warnings
          )
        );
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

// ── Secret-hygiene helpers ─────────────────────────────────────────

/**
 * Return an error message when a secret value is not an "env:VAR_NAME"
 * reference (mirrors ProfileManager's requireEnvIndirection, but names
 * the tool parameter). Plain-text secrets are never persisted.
 */
function envRefError(value: string | undefined, param: string): string | undefined {
  if (value === undefined) return undefined;
  if (value.startsWith("env:") && value.slice(4).length > 0) return undefined;
  return (
    `${param} must be an env:VAR_NAME reference (e.g. "env:SN_SECRET_DEV") -- ` +
    `plain-text secrets are never persisted to config.json. Set the secret in an ` +
    `environment variable in the MCP server's environment, then pass "env:<VAR_NAME>" here.`
  );
}

/**
 * Return a warning when an "env:VAR_NAME" secret references a variable
 * that is not currently set. The profile persists fine, but it cannot
 * authenticate until the variable is set in the environment the server
 * is launched with.
 */
function unsetEnvWarning(value: string | undefined, param: string): string | undefined {
  if (value === undefined || !value.startsWith("env:")) return undefined;
  const varName = value.slice(4);
  if (process.env[varName]) return undefined;
  return (
    `${param} references environment variable "${varName}" which is not set in the ` +
    `server's environment -- the profile was saved but cannot authenticate until the ` +
    `variable is set in the environment the server is launched with.`
  );
}
