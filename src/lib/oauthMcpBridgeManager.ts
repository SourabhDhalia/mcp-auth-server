// SPDX-License-Identifier: Apache-2.0

import * as z from "zod/v4";

import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  McpServer,
  RegisteredTool,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OAuthClientMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  CallToolResultSchema,
  ListToolsResultSchema,
  type CallToolRequest,
  type CallToolResult,
  type ListToolsRequest,
} from "@modelcontextprotocol/sdk/types.js";

import type { BridgeConfig, EndpointConfig } from "../config.js";
import { FileOAuthClientProvider } from "./fileOAuthClientProvider.js";
import { jsonSchemaToToolInput } from "./jsonSchemaToZod.js";

interface UpstreamTool {
  endpoint: EndpointConfig;
  name: string;
  description?: string;
  inputSchema?: unknown;
}

interface UpstreamConnection {
  endpoint: EndpointConfig;
  client: Client;
  transport: StreamableHTTPClientTransport;
}

interface LocalBinding {
  server: McpServer;
  proxyHandles: Map<string, RegisteredTool>;
}

function buildErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function describeTool(tool: UpstreamTool): string {
  const sourceLine = `Source: ${tool.endpoint.name} (${tool.endpoint.url})`;
  if (!tool.description) {
    return sourceLine;
  }

  return `${tool.description}\n\n${sourceLine}`;
}

function makeTransportClientName(config: BridgeConfig, suffix: string): string {
  return `${config.bridgeId}-${suffix}`;
}

export class OAuthMcpBridgeManager {
  private readonly provider: FileOAuthClientProvider;
  private readonly bindings = new Set<LocalBinding>();
  private readonly connections = new Map<string, UpstreamConnection>();
  private readonly proxiedTools = new Map<string, UpstreamTool>();
  private pendingAuth?:
    | {
        startedAt: string;
        transport: StreamableHTTPClientTransport;
      }
    | undefined;
  private pendingAuthorizationUrl?: string;
  private lastSyncAt?: string;
  private lastSyncError?: string;
  private syncInFlight?: Promise<void>;

  constructor(private readonly config: BridgeConfig) {
    const callbackUrl = new URL(
      "/admin/oauth/callback",
      this.config.publicBaseUrl,
    ).toString();

    const metadata: OAuthClientMetadata = {
      client_name: this.config.oauthClientName,
      redirect_uris: [callbackUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: this.config.oauthScope,
    };

    this.provider = new FileOAuthClientProvider(
      this.config.tokenStorePath,
      callbackUrl,
      metadata,
      (authorizationUrl) => {
        this.pendingAuthorizationUrl = authorizationUrl.toString();
      },
    );
  }

  attachServer(server: McpServer): void {
    const binding: LocalBinding = {
      server,
      proxyHandles: new Map<string, RegisteredTool>(),
    };

    this.bindings.add(binding);
    this.registerControlTools(binding);
    this.applyCatalogToBinding(binding);
  }

  detachServer(server: McpServer): void {
    for (const binding of this.bindings) {
      if (binding.server === server) {
        this.bindings.delete(binding);
        break;
      }
    }
  }

  getStatusSnapshot(): Record<string, unknown> {
    const tokens = this.provider.tokens() as Record<string, unknown> | undefined;

    return {
      bridgeId: this.config.bridgeId,
      bridgeName: this.config.bridgeName,
      providerName: this.config.providerName,
      authorized: Boolean(tokens),
      authorizationPending: Boolean(this.pendingAuth),
      pendingAuthorizationUrl: this.pendingAuthorizationUrl,
      tokenStorePath: this.config.tokenStorePath,
      loginUrl: this.getLoginUrl(),
      toolCount: this.proxiedTools.size,
      proxiedTools: [...this.proxiedTools.values()].map((tool) => ({
        name: tool.name,
        endpoint: tool.endpoint.name,
        url: tool.endpoint.url,
      })),
      endpoints: this.config.endpoints,
      allowedTools: this.config.allowedTools
        ? [...this.config.allowedTools.values()].sort()
        : null,
      lastSyncAt: this.lastSyncAt,
      lastSyncError: this.lastSyncError,
      tokenExpiresAt:
        tokens?.expires_at ||
        tokens?.expiresAt ||
        tokens?.expiration ||
        null,
    };
  }

  getLoginUrl(): string {
    return new URL("/admin/login", this.config.publicBaseUrl).toString();
  }

  async beginLogin(): Promise<{
    authorizationUrl?: string;
    alreadyAuthorized: boolean;
  }> {
    this.pendingAuthorizationUrl = undefined;

    const bootstrapClient = new Client(
      {
        name: makeTransportClientName(this.config, "bootstrap"),
        version: "0.1.0",
      },
      { capabilities: {} },
    );

    const bootstrapTransport = new StreamableHTTPClientTransport(
      new URL(this.config.endpoints[0]!.url),
      {
        authProvider: this.provider,
        requestInit: {
          redirect: "follow",
        },
      },
    );

    this.pendingAuth = {
      startedAt: new Date().toISOString(),
      transport: bootstrapTransport,
    };

    try {
      await bootstrapClient.connect(bootstrapTransport);
      await bootstrapTransport.close();
      this.pendingAuth = undefined;
      await this.syncTools();
      return { alreadyAuthorized: true };
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        if (!this.pendingAuthorizationUrl) {
          throw new Error(
            "Upstream OAuth is required, but no authorization URL was returned by the upstream server.",
          );
        }

        return {
          alreadyAuthorized: false,
          authorizationUrl: this.pendingAuthorizationUrl,
        };
      }

      this.pendingAuth = undefined;
      throw error;
    }
  }

  async completeLogin(code: string): Promise<void> {
    const pendingAuth = this.pendingAuth;
    this.pendingAuth = undefined;

    if (!pendingAuth) {
      throw new Error(
        "No OAuth login is currently pending. Start with /admin/login first.",
      );
    }

    await pendingAuth.transport.finishAuth(code);
    this.pendingAuthorizationUrl = undefined;
    this.resetConnections();
    await this.syncTools(true);
  }

  async syncTools(forceReconnect = false): Promise<void> {
    if (this.syncInFlight) {
      return this.syncInFlight;
    }

    const run = async () => {
      if (forceReconnect) {
        this.resetConnections();
      }

      const nextCatalog = new Map<string, UpstreamTool>();

      for (const endpoint of this.config.endpoints) {
        const connection = await this.ensureConnected(endpoint);
        const request: ListToolsRequest = {
          method: "tools/list",
          params: {},
        };
        const result = await connection.client.request(
          request,
          ListToolsResultSchema,
        );

        for (const rawTool of result.tools as Array<Record<string, unknown>>) {
          const name = typeof rawTool.name === "string" ? rawTool.name : undefined;
          if (!name) {
            continue;
          }

          if (this.config.allowedTools && !this.config.allowedTools.has(name)) {
            continue;
          }

          if (nextCatalog.has(name)) {
            continue;
          }

          nextCatalog.set(name, {
            endpoint,
            name,
            description:
              typeof rawTool.description === "string"
                ? rawTool.description
                : undefined,
            inputSchema: rawTool.inputSchema,
          });
        }
      }

      this.proxiedTools.clear();
      for (const [name, tool] of nextCatalog) {
        this.proxiedTools.set(name, tool);
      }

      for (const binding of this.bindings) {
        this.applyCatalogToBinding(binding);
      }

      this.lastSyncAt = new Date().toISOString();
      this.lastSyncError = undefined;
    };

    this.syncInFlight = run()
      .catch((error) => {
        this.lastSyncError = buildErrorMessage(error);
        throw error;
      })
      .finally(() => {
        this.syncInFlight = undefined;
      });

    return this.syncInFlight;
  }

  private registerControlTools(binding: LocalBinding): void {
    binding.server.registerTool(
      "bridge_status",
      {
        description:
          "Return bridge health, OAuth status, and the currently proxied upstream tools.",
        inputSchema: {},
      },
      async (): Promise<CallToolResult> => {
        const snapshot = this.getStatusSnapshot();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(snapshot, null, 2),
            },
          ],
          structuredContent: snapshot,
        };
      },
    );

    binding.server.registerTool(
      "bridge_sync_tools",
      {
        description: "Refresh the proxied upstream MCP tool catalog.",
        inputSchema: {
          reconnect: z
            .boolean()
            .optional()
            .describe("Reset upstream MCP sessions before syncing."),
        },
      },
      async ({ reconnect }): Promise<CallToolResult> => {
        try {
          await this.syncTools(Boolean(reconnect));
          const snapshot = this.getStatusSnapshot();
          return {
            content: [
              {
                type: "text",
                text: `Synced ${this.proxiedTools.size} tools successfully.`,
              },
            ],
            structuredContent: snapshot,
          };
        } catch (error) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Sync failed: ${buildErrorMessage(error)}`,
              },
            ],
          };
        }
      },
    );

    binding.server.registerTool(
      "bridge_login_url",
      {
        description:
          "Return the admin login URL operators should open to complete or renew upstream OAuth for this bridge.",
        inputSchema: {},
      },
      async (): Promise<CallToolResult> => ({
        content: [
          {
            type: "text",
            text: this.getLoginUrl(),
          },
        ],
        structuredContent: {
          loginUrl: this.getLoginUrl(),
        },
      }),
    );
  }

  private applyCatalogToBinding(binding: LocalBinding): void {
    for (const [name, handle] of [...binding.proxyHandles.entries()]) {
      if (!this.proxiedTools.has(name)) {
        handle.remove?.();
        binding.proxyHandles.delete(name);
      }
    }

    for (const [name, tool] of this.proxiedTools.entries()) {
      const definition = {
        description: describeTool(tool),
        inputSchema: jsonSchemaToToolInput(tool.inputSchema),
      };

      const existing = binding.proxyHandles.get(name);
      if (existing) {
        existing.update({
          description: definition.description,
          paramsSchema: definition.inputSchema,
          callback: async (args, extra): Promise<CallToolResult> =>
            this.invokeProxiedTool(tool, args, binding.server, extra.sessionId),
        });
        continue;
      }

      const handle = binding.server.registerTool(
        name,
        definition,
        async (args, extra): Promise<CallToolResult> =>
          this.invokeProxiedTool(tool, args, binding.server, extra.sessionId),
      );

      binding.proxyHandles.set(name, handle);
    }
  }

  private async invokeProxiedTool(
    tool: UpstreamTool,
    args: Record<string, unknown>,
    server: McpServer,
    sessionId?: string,
  ): Promise<CallToolResult> {
    try {
      const result = await this.callUpstreamTool(tool, args, false);
      await server.sendLoggingMessage(
        {
          level: "info",
          data: `Proxied ${tool.name} via ${tool.endpoint.name}`,
        },
        sessionId,
      );
      return result;
    } catch (error) {
      const message =
        error instanceof UnauthorizedError
          ? `${this.config.providerName} OAuth is missing or expired. Visit ${this.getLoginUrl()} and retry.`
          : `Proxy failed for ${tool.name}: ${buildErrorMessage(error)}`;

      await server.sendLoggingMessage(
        {
          level: "error",
          data: message,
        },
        sessionId,
      );

      return {
        isError: true,
        content: [
          {
            type: "text",
            text: message,
          },
        ],
      };
    }
  }

  private async callUpstreamTool(
    tool: UpstreamTool,
    args: Record<string, unknown>,
    retried: boolean,
  ): Promise<CallToolResult> {
    try {
      const connection = await this.ensureConnected(tool.endpoint);
      const request: CallToolRequest = {
        method: "tools/call",
        params: {
          name: tool.name,
          arguments: args,
        },
      };

      return await connection.client.request(request, CallToolResultSchema);
    } catch (error) {
      if (!retried && !(error instanceof UnauthorizedError)) {
        this.resetConnection(tool.endpoint.key);
        return this.callUpstreamTool(tool, args, true);
      }

      throw error;
    }
  }

  private async ensureConnected(endpoint: EndpointConfig): Promise<UpstreamConnection> {
    const existing = this.connections.get(endpoint.key);
    if (existing) {
      return existing;
    }

    const client = new Client(
      {
        name: makeTransportClientName(this.config, `upstream-${endpoint.key}`),
        version: "0.1.0",
      },
      { capabilities: {} },
    );

    const transport = new StreamableHTTPClientTransport(new URL(endpoint.url), {
      authProvider: this.provider,
      requestInit: {
        redirect: "follow",
      },
    });

    await client.connect(transport);

    const connection: UpstreamConnection = {
      endpoint,
      client,
      transport,
    };
    this.connections.set(endpoint.key, connection);
    return connection;
  }

  private resetConnections(): void {
    for (const endpointKey of [...this.connections.keys()]) {
      this.resetConnection(endpointKey);
    }
  }

  private resetConnection(endpointKey: string): void {
    const connection = this.connections.get(endpointKey);
    this.connections.delete(endpointKey);

    if (connection?.transport?.close) {
      void connection.transport.close();
    }
  }
}
