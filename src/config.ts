/**
 * Configuration — reads ServiceNow credentials from environment variables.
 *
 * @module config
 */

export interface ServiceNowConfig {
  instance: string;
  user: string;
  password: string;
  displayValue: string;
  relDepth: number;
}

/**
 * Load and validate configuration from environment variables.
 * Throws descriptive errors when required variables are missing.
 */
export function loadConfig(): ServiceNowConfig {
  const instance = process.env.SN_INSTANCE;
  const user = process.env.SN_USER;
  const password = process.env.SN_PASSWORD;
  const displayValue = process.env.SN_DISPLAY_VALUE ?? "true";
  const relDepth = parseInt(process.env.SN_REL_DEPTH ?? "3", 10);

  const missing: string[] = [];
  if (!instance) missing.push("SN_INSTANCE");
  if (!user) missing.push("SN_USER");
  if (!password) missing.push("SN_PASSWORD");

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(", ")}\n\n` +
        "Set them in your MCP client configuration:\n" +
        '  SN_INSTANCE  — ServiceNow instance URL (e.g. https://yourinstance.service-now.com)\n' +
        '  SN_USER      — ServiceNow username\n' +
        '  SN_PASSWORD  — ServiceNow password\n'
    );
  }

  // Normalize instance URL: strip trailing slash, ensure https://
  let normalizedInstance = instance!.replace(/\/+$/, "");
  if (!normalizedInstance.startsWith("http")) {
    normalizedInstance = `https://${normalizedInstance}`;
  }

  return {
    instance: normalizedInstance,
    user: user!,
    password: password!,
    displayValue,
    relDepth: isNaN(relDepth) ? 3 : relDepth,
  };
}
