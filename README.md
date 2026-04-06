# OAuth-Capable MCP Bridge

This repository demonstrates a reusable pattern for an OAuth-capable remote MCP bridge.

The current implementation is preconfigured for Swiggy, but the same structure can be adapted for other OAuth-protected MCP servers.

This project creates an internal MCP bridge for an OAuth-protected MCP provider, with Swiggy as the bundled example target.

It solves the common office-network problem where an MCP client can reach a remote MCP endpoint but does not fully complete the upstream OAuth flow itself:

- LM Studio or any other remote MCP client can connect to a normal internal Streamable HTTP MCP endpoint.
- The bridge completes upstream OAuth once through a browser-based admin route.
- Refreshable OAuth tokens are stored locally and reused for proxied MCP calls.
- You can optionally gate internal clients with a simple bearer token while still hiding the upstream OAuth complexity from them.

## What It Does

The bridge exposes:

- `GET/POST/DELETE /mcp`: the internal MCP endpoint your office clients connect to
- `GET /admin/login`: starts the upstream Swiggy OAuth flow
- `GET /admin/oauth/callback`: receives the upstream OAuth callback
- `GET /admin/status`: shows bridge health and proxied tool state
- `POST /admin/sync-tools`: refreshes the tool catalog after login or upstream changes
- `GET /healthz`: health probe

Inside MCP itself, the bridge also exposes a few local helper tools:

- `bridge_status`
- `bridge_sync_tools`
- `bridge_login_url`

In the current example configuration, after OAuth succeeds it syncs tools from:

- `https://mcp.swiggy.com/food`
- `https://mcp.swiggy.com/im`
- `https://mcp.swiggy.com/dineout`

Duplicate tool names are de-duplicated by first endpoint wins, matching the current Swiggy multi-endpoint pattern.

## General Applicability

This bridge pattern is not limited to Swiggy.

It is suitable for any OAuth-protected MCP server where you want to:

- complete OAuth once in a controlled environment
- persist refreshable credentials on the bridge side
- expose a simpler internal MCP endpoint to office users or approved tools

The current codebase is still Swiggy-focused:

- endpoint defaults point to `mcp.swiggy.com`
- tool discovery is performed against the Swiggy service URLs in `.env.example`
- naming and examples in the code are still Swiggy-specific

So the project is best described as:

- a general OAuth-capable MCP bridge pattern
- with a concrete Swiggy implementation included out of the box

## Quick Start

1. Install dependencies.

```bash
npm install
```

2. Copy the environment file and edit values as needed.

```bash
cp .env.example .env
```

3. Start the bridge.

```bash
npm run dev
```

4. Open the admin login URL in a browser.

```text
http://localhost:3100/admin/login
```

5. Finish the upstream OAuth flow in the browser.

6. Point your MCP client at:

```text
http://localhost:3100/mcp
```

If you set `INTERNAL_BEARER_TOKEN`, your MCP client must send:

```text
Authorization: Bearer <your token>
```

## Environment

Important variables:

- `PUBLIC_BASE_URL`: must match how the browser reaches this service, because the OAuth callback URL is derived from it
- `INTERNAL_BEARER_TOKEN`: optional internal gate for `/mcp`
- `MCP_ALLOWED_TOOLS`: optional comma-separated allowlist if you only want approved Swiggy tools exposed
- `TOKEN_STORE_PATH`: where the bridge persists the upstream OAuth client info and tokens

## Before Uploading

Treat this repo as public-safe by default.

- `.env` is local-only and must not be committed.
- `data/swiggy-oauth.json` is local-only and must not be committed.
- The bridge can recreate the OAuth token later by running `npm run dev` or `npm start` and completing `/admin/login` again.
- If a real token or secret was ever pasted into docs, screenshots, chat, or Git history, revoke it and issue a new one.

Publish-time Git hygiene checklist:

1. Initialize Git only after confirming the ignore rules are in place.
2. Review the first staged file set before pushing so only source, docs, lockfiles, and safe templates are included.
3. If this folder is later moved under another Git repository, re-check that `.env`, `data/swiggy-oauth.json`, `dist/`, and `node_modules/` are still ignored.

## Recommended Office Setup

For a clean internal deployment:

1. Put this bridge behind your office VPN or internal reverse proxy.
2. Set `PUBLIC_BASE_URL` to the internal hostname users will open in a browser.
3. Optionally set `INTERNAL_BEARER_TOKEN` or front it with SSO at the reverse proxy.
4. Complete `/admin/login` once with the account you want the bridge to use.
5. Share only the internal `/mcp` endpoint with LM Studio or other approved clients.

## Notes

- Existing MCP clients may need to reconnect after the first successful OAuth so they receive the newly synced tools.
- The bridge currently proxies tools only. That is the important path for most OAuth-protected MCP office-access setups.
- Tokens are stored on disk in JSON for operational simplicity. In production, move this to encrypted secret storage if needed.
