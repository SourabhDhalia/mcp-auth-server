// SPDX-License-Identifier: Apache-2.0

import { existsSync } from "node:fs";
import { resolve } from "node:path";

export interface EndpointConfig {
  key: string;
  name: string;
  url: string;
}

export interface BridgeConfig {
  bridgeId: string;
  bridgeName: string;
  host: string;
  port: number;
  publicBaseUrl: string;
  providerName: string;
  internalBearerToken?: string;
  allowedTools?: Set<string>;
  oauthScope: string;
  oauthClientName: string;
  tokenStorePath: string;
  upstreamTimeoutMs: number;
  endpoints: EndpointConfig[];
}

const DEFAULT_PROVIDER_NAME = "Swiggy";
const DEFAULT_BRIDGE_NAME = "MCP Auth Server";
const DEFAULT_OAUTH_SCOPE = "mcp:tools mcp:resources mcp:prompts";
const DEFAULT_TOKEN_STORE_PATH = "./data/oauth-tokens.json";
const LEGACY_SWIGGY_TOKEN_STORE_PATH = "./data/swiggy-oauth.json";

function normalizeBaseUrl(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function slugify(value: string, fallback: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug || fallback;
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

function parseEndpointConfig(rawValue: unknown, index: number): EndpointConfig {
  if (typeof rawValue !== "object" || rawValue === null || Array.isArray(rawValue)) {
    throw new Error(
      "Each entry in MCP_UPSTREAM_ENDPOINTS_JSON must be an object.",
    );
  }

  const raw = rawValue as Record<string, unknown>;
  const url = typeof raw.url === "string" ? raw.url : undefined;
  const name =
    typeof raw.name === "string" ? raw.name : `Endpoint ${index + 1}`;
  const keySource =
    typeof raw.key === "string" && raw.key.trim() ? raw.key : name;

  if (!url) {
    throw new Error(
      "Each entry in MCP_UPSTREAM_ENDPOINTS_JSON must include a string url field.",
    );
  }

  return {
    key: slugify(keySource, `endpoint-${index + 1}`),
    name,
    url,
  };
}

function parseEndpointsJson(value: string | undefined): EndpointConfig[] | undefined {
  if (!value) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("MCP_UPSTREAM_ENDPOINTS_JSON must be valid JSON.");
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(
      "MCP_UPSTREAM_ENDPOINTS_JSON must be a non-empty JSON array.",
    );
  }

  return parsed.map((entry, index) => parseEndpointConfig(entry, index));
}

function singleEndpointFromEnv(providerName: string): EndpointConfig[] | undefined {
  const url = process.env.UPSTREAM_MCP_URL;
  if (!url) {
    return undefined;
  }

  const name = process.env.UPSTREAM_ENDPOINT_NAME || `${providerName} Primary`;
  const key = process.env.UPSTREAM_ENDPOINT_KEY || slugify(name, "primary");

  return [{ key, name, url }];
}

function resolveTokenStorePath(): string {
  const explicit =
    process.env.TOKEN_STORE_PATH || process.env.SWIGGY_TOKEN_STORE_PATH;
  if (explicit) {
    return resolve(process.cwd(), explicit);
  }

  const genericPath = resolve(process.cwd(), DEFAULT_TOKEN_STORE_PATH);
  const legacyPath = resolve(process.cwd(), LEGACY_SWIGGY_TOKEN_STORE_PATH);

  if (existsSync(genericPath)) {
    return genericPath;
  }

  if (existsSync(legacyPath)) {
    return legacyPath;
  }

  return genericPath;
}

function defaultSwiggyEndpoints(): EndpointConfig[] {
  return [
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
  ];
}

export function loadConfig(): BridgeConfig {
  const host = process.env.HOST || "0.0.0.0";
  const port = parsePort(process.env.PORT, 3100);
  const publicBaseUrl = normalizeBaseUrl(
    process.env.PUBLIC_BASE_URL || `http://localhost:${port}`,
  );
  const bridgeName = process.env.BRIDGE_NAME || DEFAULT_BRIDGE_NAME;
  const providerName =
    process.env.UPSTREAM_PROVIDER_NAME || DEFAULT_PROVIDER_NAME;
  const endpoints =
    parseEndpointsJson(process.env.MCP_UPSTREAM_ENDPOINTS_JSON) ||
    singleEndpointFromEnv(providerName) ||
    defaultSwiggyEndpoints();

  return {
    bridgeId: slugify(process.env.BRIDGE_ID || bridgeName, "mcp-auth-server"),
    bridgeName,
    host,
    port,
    publicBaseUrl,
    providerName,
    internalBearerToken: process.env.INTERNAL_BEARER_TOKEN || undefined,
    allowedTools: parseAllowedTools(process.env.MCP_ALLOWED_TOOLS),
    oauthScope: process.env.OAUTH_SCOPE || process.env.SWIGGY_SCOPE || DEFAULT_OAUTH_SCOPE,
    oauthClientName:
      process.env.OAUTH_CLIENT_NAME ||
      process.env.SWIGGY_CLIENT_NAME ||
      `${providerName} MCP Auth Bridge`,
    tokenStorePath: resolveTokenStorePath(),
    upstreamTimeoutMs: parsePort(process.env.UPSTREAM_TIMEOUT_MS, 30000),
    endpoints,
  };
}
