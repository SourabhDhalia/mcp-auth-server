# MCP Auth Server

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](./LICENSE)
![Node >=20](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)
![MCP Bridge](https://img.shields.io/badge/MCP-OAuth%20Bridge-111827)

`mcp-auth-server` is a remote MCP bridge for OAuth-protected MCP servers.

It sits between an upstream MCP provider and internal tools like LM Studio, Cursor, Claude Desktop, or custom office integrations. The bridge completes OAuth in a browser once, stores refreshable credentials on the server side, then exposes a simpler internal Streamable HTTP MCP endpoint to clients that should not manage the upstream OAuth flow directly.

The codebase is now structured as a general-purpose MCP auth bridge, with Swiggy kept as the bundled default preset and example configuration.

## Why This Exists

Some MCP clients can connect to remote MCP servers but do not reliably complete upstream OAuth flows. In those cases you usually want one of these:

- use a desktop client that fully supports the provider's auth flow
- place an internal bridge in front of the provider and centralize login there

This project implements the second path.

## Features

- Exposes a standard internal MCP endpoint at `GET/POST/DELETE /mcp`
- Completes upstream OAuth through `/admin/login` and `/admin/oauth/callback`
- Stores refreshable OAuth state locally on the bridge host
- Discovers upstream tools dynamically and proxies them through one MCP surface
- Supports optional tool allowlisting via `MCP_ALLOWED_TOOLS`
- Supports a single upstream MCP endpoint or a multi-endpoint provider layout
- Keeps backward compatibility with older Swiggy-focused configuration names

## Default Preset

Out of the box, the bridge is configured for Swiggy as an example OAuth-protected MCP provider. If you do nothing, it will discover tools from:

- `https://mcp.swiggy.com/food`
- `https://mcp.swiggy.com/im`
- `https://mcp.swiggy.com/dineout`

To use another provider, update the generic environment variables in `.env`.

## Quick Start

1. Install dependencies.

```bash
npm install
```

2. Copy the environment template.

```bash
cp .env.example .env
```

3. Start the bridge.

```bash
npm run dev
```

4. Open the admin login URL.

```text
http://localhost:3100/admin/login
```

5. Complete the upstream OAuth flow.

6. Point your MCP client at:

```text
http://localhost:3100/mcp
```

If you set `INTERNAL_BEARER_TOKEN`, your MCP client must also send:

```text
Authorization: Bearer <your token>
```

## Configuration

Core variables:

- `BRIDGE_NAME`: human-readable bridge name shown in logs and status
- `UPSTREAM_PROVIDER_NAME`: display name for the upstream provider
- `PUBLIC_BASE_URL`: browser-visible base URL used to build the OAuth callback
- `INTERNAL_BEARER_TOKEN`: optional internal gate for `/mcp`
- `MCP_ALLOWED_TOOLS`: optional comma-separated allowlist of proxied tools
- `TOKEN_STORE_PATH`: local path for persisted OAuth client and token state

For upstream MCP endpoints, choose one of these patterns:

Single endpoint:

```env
UPSTREAM_PROVIDER_NAME=Example Provider
UPSTREAM_MCP_URL=https://example.com/mcp
UPSTREAM_ENDPOINT_NAME=Example Primary
UPSTREAM_ENDPOINT_KEY=primary
OAUTH_CLIENT_NAME=Example Provider MCP Bridge
OAUTH_SCOPE=mcp:tools mcp:resources mcp:prompts
```

Multiple endpoints:

```env
UPSTREAM_PROVIDER_NAME=Example Provider
MCP_UPSTREAM_ENDPOINTS_JSON=[{"key":"core","name":"Example Core","url":"https://example.com/mcp/core"},{"key":"billing","name":"Example Billing","url":"https://example.com/mcp/billing"}]
OAUTH_CLIENT_NAME=Example Provider MCP Bridge
OAUTH_SCOPE=mcp:tools mcp:resources mcp:prompts
```

Swiggy-compatible aliases remain supported for older setups:

- `SWIGGY_FOOD_URL`
- `SWIGGY_INSTAMART_URL`
- `SWIGGY_DINEOUT_URL`
- `SWIGGY_SCOPE`
- `SWIGGY_CLIENT_NAME`

## Admin and MCP Routes

- `GET /healthz`: health probe and bridge status
- `GET /admin/status`: current bridge state, endpoints, and tool catalog summary
- `GET /admin/login`: starts upstream OAuth
- `GET /admin/oauth/callback`: completes upstream OAuth
- `POST /admin/sync-tools`: refreshes the tool catalog
- `GET/POST/DELETE /mcp`: Streamable HTTP MCP endpoint for clients

Inside MCP, the bridge also exposes:

- `bridge_status`
- `bridge_sync_tools`
- `bridge_login_url`

## Security Notes

- `.env` is local-only and must not be committed.
- Token files under `data/` are local-only and must not be committed.
- By default the bridge stores OAuth state on disk for operational simplicity. For production deployments, move this to encrypted secret storage if needed.
- If a real token or secret is ever pasted into Git history, screenshots, or docs, revoke it and issue a new one.

## Public Upload Checklist

1. Confirm `.env`, `data/`, `dist/`, and `node_modules/` stay ignored.
2. Review the staged file set before pushing.
3. Re-run `npm run typecheck` and `npm run build`.
4. If you change providers, double-check the public docs do not include live credentials or tenant-specific URLs you should keep private.

## Positioning

This project is best described as:

- a reusable OAuth-capable MCP auth bridge
- a practical remote-MCP compatibility layer for office environments
- a Swiggy-ready example implementation that can be adapted to other OAuth-protected MCP providers
