import { resolve } from "node:path";

export interface EndpointConfig {
  key: string;
  name: string;
  url: string;
}

export interface BridgeConfig {
  host: string;
  port: number;
  publicBaseUrl: string;
  internalBearerToken?: string;
  allowedTools?: Set<string>;
  swiggyServerUrl: string;
  swiggyScope: string;
  swiggyClientName: string;
  tokenStorePath: string;
  upstreamTimeoutMs: number;
  endpoints: EndpointConfig[];
}

function normalizeBaseUrl(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function parsePort(value: string | undefined, fallback: number): number {
  const parsed = value ? Number.parseInt(value, 10) : fallback;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseAllowedTools(value: string | undefined): Set<string> | undefined {
  if (!value) {
    return undefined;
  }

  const items = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  return items.length > 0 ? new Set(items) : undefined;
}

export function loadConfig(): BridgeConfig {
  const host = process.env.HOST || "0.0.0.0";
  const port = parsePort(process.env.PORT, 3100);
  const publicBaseUrl = normalizeBaseUrl(
    process.env.PUBLIC_BASE_URL || `http://localhost:${port}`,
  );

  return {
    host,
    port,
    publicBaseUrl,
    internalBearerToken: process.env.INTERNAL_BEARER_TOKEN || undefined,
    allowedTools: parseAllowedTools(process.env.MCP_ALLOWED_TOOLS),
    swiggyServerUrl: process.env.SWIGGY_SERVER_URL || "https://mcp.swiggy.com",
    swiggyScope:
      process.env.SWIGGY_SCOPE || "mcp:tools mcp:resources mcp:prompts",
    swiggyClientName:
      process.env.SWIGGY_CLIENT_NAME || "Swiggy MCP Office Bridge",
    tokenStorePath: resolve(
      process.cwd(),
      process.env.TOKEN_STORE_PATH || "./data/swiggy-oauth.json",
    ),
    upstreamTimeoutMs: parsePort(process.env.UPSTREAM_TIMEOUT_MS, 30000),
    endpoints: [
      {
        key: "food",
        name: "Swiggy Food",
        url: process.env.SWIGGY_FOOD_URL || "https://mcp.swiggy.com/food",
      },
      {
        key: "instamart",
        name: "Swiggy Instamart",
        url: process.env.SWIGGY_INSTAMART_URL || "https://mcp.swiggy.com/im",
      },
      {
        key: "dineout",
        name: "Swiggy Dineout",
        url: process.env.SWIGGY_DINEOUT_URL || "https://mcp.swiggy.com/dineout",
      },
    ],
  };
}
