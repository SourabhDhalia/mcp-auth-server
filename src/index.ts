// SPDX-License-Identifier: Apache-2.0

import "dotenv/config";

import { randomUUID } from "node:crypto";

import cors from "cors";
import type { NextFunction, Request, Response } from "express";

import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import { loadConfig } from "./config.js";
import { OAuthMcpBridgeManager } from "./lib/oauthMcpBridgeManager.js";

const config = loadConfig();
const bridgeManager = new OAuthMcpBridgeManager(config);

const app = createMcpExpressApp({ host: config.host });

app.use(
  cors({
    origin: true,
    exposedHeaders: [
      "Mcp-Session-Id",
      "Last-Event-Id",
      "Mcp-Protocol-Version",
      "WWW-Authenticate",
    ],
  }),
);

type SessionEntry = {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
};

const sessions = new Map<string, SessionEntry>();

type BrowserStatusSnapshot = {
  bridgeId?: string;
  bridgeName?: string;
  providerName?: string;
  authorized?: boolean;
  authorizationPending?: boolean;
  pendingAuthorizationUrl?: string;
  tokenStorePath?: string;
  loginUrl?: string;
  toolCount?: number;
  proxiedTools?: Array<{
    name: string;
    endpoint: string;
    url: string;
  }>;
  endpoints?: Array<{
    key: string;
    name: string;
    url: string;
  }>;
  allowedTools?: string[] | null;
  lastSyncAt?: string;
  lastSyncError?: string;
  tokenExpiresAt?: string | null;
};

function requireInternalBearerToken(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const expectedToken = config.internalBearerToken;
  if (!expectedToken) {
    next();
    return;
  }

  const receivedHeader = req.headers.authorization;
  if (receivedHeader === `Bearer ${expectedToken}`) {
    next();
    return;
  }

  res.status(401).json({
    error: "unauthorized",
    message: "Missing or invalid internal bearer token.",
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function shouldRenderBrowserUi(req: Request): boolean {
  return req.headers.accept?.includes("text/html") ?? false;
}

function formatTimestamp(value: string | null | undefined): string {
  if (!value) {
    return "Not available";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return `${date.toLocaleString()} (${value})`;
}

function renderActions(
  actions: Array<{ href: string; label: string; variant?: "primary" | "secondary" }>,
): string {
  if (actions.length === 0) {
    return "";
  }

  return `
    <div class="actions">
      ${actions
        .map(
          (action) => `
            <a class="button ${action.variant === "secondary" ? "button-secondary" : ""}" href="${escapeHtml(action.href)}">
              ${escapeHtml(action.label)}
            </a>
          `,
        )
        .join("")}
    </div>
  `;
}

function renderMetricCards(
  metrics: Array<{ label: string; value: string; tone?: "good" | "warn" | "neutral" }>,
): string {
  return `
    <section class="metric-grid">
      ${metrics
        .map(
          (metric) => `
            <article class="metric-card">
              <div class="eyebrow">${escapeHtml(metric.label)}</div>
              <div class="metric-value metric-${metric.tone || "neutral"}">${escapeHtml(metric.value)}</div>
            </article>
          `,
        )
        .join("")}
    </section>
  `;
}

function renderList(
  title: string,
  items: string[],
  emptyText: string,
): string {
  return `
    <section class="panel">
      <h2>${escapeHtml(title)}</h2>
      ${
        items.length > 0
          ? `<ul class="detail-list">${items
              .map((item) => `<li>${item}</li>`)
              .join("")}</ul>`
          : `<p class="muted">${escapeHtml(emptyText)}</p>`
      }
    </section>
  `;
}

function renderShell(
  title: string,
  options: {
    kicker?: string;
    summary?: string;
    body: string;
    actions?: Array<{
      href: string;
      label: string;
      variant?: "primary" | "secondary";
    }>;
    badge?: string;
  },
): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <style>
      :root {
        --ink: #1c2435;
        --muted: #5f6b85;
        --line: rgba(28, 36, 53, 0.12);
        --surface: rgba(255, 255, 255, 0.84);
        --accent: #d45c2b;
        --accent-soft: rgba(212, 92, 43, 0.14);
        --good: #127a52;
        --warn: #9a4b1f;
      }
      body {
        font-family: "Avenir Next", "Segoe UI", sans-serif;
        background:
          radial-gradient(circle at top left, rgba(212, 92, 43, 0.14), transparent 26%),
          radial-gradient(circle at right 20%, rgba(29, 78, 216, 0.11), transparent 24%),
          linear-gradient(180deg, #f3eee5 0%, #f7f2e9 44%, #f3f0ea 100%);
        color: var(--ink);
        margin: 0;
        min-height: 100vh;
        padding: 28px;
      }
      main {
        max-width: 980px;
        margin: 0 auto;
        background: var(--surface);
        border: 1px solid rgba(255, 255, 255, 0.65);
        border-radius: 28px;
        padding: 34px;
        box-shadow: 0 18px 50px rgba(22, 31, 48, 0.12);
        backdrop-filter: blur(14px);
      }
      .hero {
        display: grid;
        grid-template-columns: 1.2fr 0.8fr;
        gap: 18px;
        align-items: start;
        margin-bottom: 24px;
      }
      .hero-copy {
        padding-right: 8px;
      }
      .hero-card {
        background: rgba(255, 255, 255, 0.72);
        border: 1px solid var(--line);
        border-radius: 22px;
        padding: 18px;
      }
      .kicker {
        display: inline-block;
        margin-bottom: 10px;
        padding: 6px 10px;
        border-radius: 999px;
        background: var(--accent-soft);
        color: var(--accent);
        font-size: 0.78rem;
        font-weight: 700;
        letter-spacing: 0.06em;
        text-transform: uppercase;
      }
      h1 {
        margin-top: 0;
        margin-bottom: 12px;
        font-size: clamp(2rem, 4vw, 3.4rem);
        line-height: 0.95;
        letter-spacing: -0.04em;
      }
      h2 {
        margin: 0 0 12px;
        font-size: 1.05rem;
        letter-spacing: -0.02em;
      }
      p {
        margin: 0 0 10px;
        color: var(--muted);
        line-height: 1.55;
      }
      .summary {
        font-size: 1.04rem;
        max-width: 62ch;
      }
      .badge {
        display: inline-block;
        padding: 8px 12px;
        border-radius: 999px;
        background: rgba(28, 36, 53, 0.08);
        color: var(--ink);
        font-size: 0.82rem;
        font-weight: 700;
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-top: 18px;
      }
      .button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 42px;
        padding: 0 16px;
        border-radius: 999px;
        background: var(--accent);
        color: #fff;
        text-decoration: none;
        font-weight: 700;
        box-shadow: inset 0 -2px 0 rgba(0, 0, 0, 0.12);
      }
      .button-secondary {
        background: rgba(255, 255, 255, 0.92);
        color: var(--ink);
        border: 1px solid var(--line);
        box-shadow: none;
      }
      .metric-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 12px;
        margin: 10px 0 24px;
      }
      .metric-card,
      .panel {
        background: rgba(255, 255, 255, 0.78);
        border: 1px solid var(--line);
        border-radius: 22px;
        padding: 18px;
      }
      .eyebrow {
        margin-bottom: 8px;
        color: var(--muted);
        font-size: 0.78rem;
        font-weight: 700;
        letter-spacing: 0.06em;
        text-transform: uppercase;
      }
      .metric-value {
        font-size: 1.2rem;
        font-weight: 800;
        letter-spacing: -0.03em;
      }
      .metric-good {
        color: var(--good);
      }
      .metric-warn {
        color: var(--warn);
      }
      .panel-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
        gap: 14px;
      }
      .panel-wide {
        margin-top: 14px;
      }
      .detail-list {
        margin: 0;
        padding-left: 18px;
        color: var(--muted);
      }
      .detail-list li {
        margin-bottom: 8px;
        line-height: 1.45;
      }
      .muted {
        color: var(--muted);
      }
      code {
        background: rgba(28, 36, 53, 0.08);
        padding: 2px 7px;
        border-radius: 8px;
        color: var(--ink);
      }
      .mono {
        font-family: ui-monospace, "SFMono-Regular", Menlo, monospace;
        word-break: break-word;
      }
      .tool-catalog {
        max-height: 520px;
        overflow: auto;
        padding-right: 4px;
      }
      .tool-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
        gap: 10px;
      }
      .tool-card {
        padding: 14px;
        border-radius: 16px;
        background: rgba(28, 36, 53, 0.04);
        border: 1px solid var(--line);
      }
      .tool-name {
        margin: 0 0 6px;
        font-size: 0.98rem;
        font-weight: 800;
        letter-spacing: -0.02em;
      }
      .tool-meta {
        margin: 0;
        color: var(--muted);
        font-size: 0.9rem;
      }
      @media (max-width: 760px) {
        body {
          padding: 16px;
        }
        main {
          padding: 22px;
          border-radius: 22px;
        }
        .hero {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <section class="hero">
        <div class="hero-copy">
          ${options.kicker ? `<div class="kicker">${escapeHtml(options.kicker)}</div>` : ""}
          <h1>${escapeHtml(title)}</h1>
          ${options.summary ? `<p class="summary">${escapeHtml(options.summary)}</p>` : ""}
          ${renderActions(options.actions || [])}
        </div>
        <div class="hero-card">
          ${options.badge ? `<div class="badge">${escapeHtml(options.badge)}</div>` : ""}
        </div>
      </section>
      ${options.body}
    </main>
  </body>
</html>`;
}

function renderHtml(title: string, body: string): string {
  return renderShell(title, {
    kicker: "Browser View",
    badge: config.providerName,
    actions: [
      { href: "/healthz", label: "Health" },
      { href: "/admin/status", label: "Status" },
      { href: "/admin/login", label: "Login", variant: "secondary" },
    ],
    body: `<section class="panel">${body}</section>`,
  });
}

function renderHealthPage(snapshot: BrowserStatusSnapshot): string {
  const metrics = renderMetricCards([
    {
      label: "Bridge",
      value: snapshot.bridgeName || config.bridgeName,
    },
    {
      label: "Provider",
      value: snapshot.providerName || config.providerName,
    },
    {
      label: "OAuth",
      value: snapshot.authorized ? "Authorized" : "Login needed",
      tone: snapshot.authorized ? "good" : "warn",
    },
    {
      label: "Tools",
      value: String(snapshot.toolCount ?? 0),
      tone: (snapshot.toolCount ?? 0) > 0 ? "good" : "neutral",
    },
  ]);

  const panels = `
    <div class="panel-grid">
      ${renderList(
        "Endpoints",
        (snapshot.endpoints || []).map(
          (endpoint) =>
            `<strong>${escapeHtml(endpoint.name)}</strong><br /><span class="mono">${escapeHtml(endpoint.url)}</span>`,
        ),
        "No upstream endpoints are configured.",
      )}
      ${renderList(
        "Status",
        [
          `Bridge ID: <span class="mono">${escapeHtml(snapshot.bridgeId || config.bridgeId)}</span>`,
          `Login URL: <span class="mono">${escapeHtml(snapshot.loginUrl || `${config.publicBaseUrl}/admin/login`)}</span>`,
          `Last sync: ${escapeHtml(formatTimestamp(snapshot.lastSyncAt))}`,
          `Token store: <span class="mono">${escapeHtml(snapshot.tokenStorePath || "Not configured")}</span>`,
        ],
        "No status details available.",
      )}
    </div>
  `;

  return renderShell("Bridge Health", {
    kicker: "Browser Dashboard",
    summary:
      "This page is for people checking the bridge in a browser. MCP clients should connect to the /mcp endpoint directly.",
    badge: snapshot.authorized ? "OAuth Ready" : "OAuth Needed",
    actions: [
      { href: "/admin/status", label: "View Full Status" },
      { href: "/admin/login", label: "Open Login" },
      { href: "/mcp", label: "About /mcp", variant: "secondary" },
    ],
    body: `${metrics}${panels}`,
  });
}

function renderStatusPage(snapshot: BrowserStatusSnapshot): string {
  const toolCatalog =
    (snapshot.proxiedTools || []).length > 0
      ? `
        <section class="panel panel-wide">
          <h2>All Proxied Tools</h2>
          <div class="tool-catalog">
            <div class="tool-grid">
              ${(snapshot.proxiedTools || [])
                .map(
                  (tool) => `
                    <article class="tool-card">
                      <div class="tool-name">${escapeHtml(tool.name)}</div>
                      <p class="tool-meta">${escapeHtml(tool.endpoint)}</p>
                      <p class="tool-meta mono">${escapeHtml(tool.url)}</p>
                    </article>
                  `,
                )
                .join("")}
            </div>
          </div>
        </section>
      `
      : `
        <section class="panel panel-wide">
          <h2>All Proxied Tools</h2>
          <p class="muted">No tools have been synced yet.</p>
        </section>
      `;

  const metrics = renderMetricCards([
    {
      label: "Authorization",
      value: snapshot.authorized ? "Connected" : "Not connected",
      tone: snapshot.authorized ? "good" : "warn",
    },
    {
      label: "Pending Login",
      value: snapshot.authorizationPending ? "In progress" : "None",
      tone: snapshot.authorizationPending ? "warn" : "neutral",
    },
    {
      label: "Tool Catalog",
      value: `${snapshot.toolCount ?? 0} tools`,
      tone: (snapshot.toolCount ?? 0) > 0 ? "good" : "neutral",
    },
    {
      label: "Allowed Tools",
      value:
        snapshot.allowedTools === null
          ? "All"
          : `${snapshot.allowedTools?.length ?? 0} selected`,
    },
  ]);

  const panels = `
    <div class="panel-grid">
      ${renderList(
        "Upstream Endpoints",
        (snapshot.endpoints || []).map(
          (endpoint) =>
            `<strong>${escapeHtml(endpoint.name)}</strong><br /><span class="mono">${escapeHtml(endpoint.url)}</span>`,
        ),
        "No endpoints are configured.",
      )}
      ${renderList(
        "Recent State",
        [
          `Provider: <strong>${escapeHtml(snapshot.providerName || config.providerName)}</strong>`,
          `Login URL: <span class="mono">${escapeHtml(snapshot.loginUrl || `${config.publicBaseUrl}/admin/login`)}</span>`,
          `Token expires: ${escapeHtml(formatTimestamp(snapshot.tokenExpiresAt))}`,
          `Last sync: ${escapeHtml(formatTimestamp(snapshot.lastSyncAt))}`,
          `Last sync error: ${escapeHtml(snapshot.lastSyncError || "None")}`,
        ],
        "No recent state is available.",
      )}
      ${renderList(
        "Sample Tools",
        (snapshot.proxiedTools || [])
          .slice(0, 6)
          .map(
            (tool) =>
              `<strong>${escapeHtml(tool.name)}</strong><br /><span class="muted">${escapeHtml(tool.endpoint)}</span>`,
          ),
        "No tools have been synced yet.",
      )}
    </div>
    ${toolCatalog}
  `;

  return renderShell("Bridge Status", {
    kicker: "Operations View",
    summary:
      "This is the human-friendly view of the current bridge state. JSON status is still available to non-browser callers on the same route.",
    badge: `${snapshot.toolCount ?? 0} Tools`,
    actions: [
      { href: "/healthz", label: "Health Overview" },
      { href: "/admin/login", label: "Refresh Login" },
      { href: "/mcp", label: "About /mcp", variant: "secondary" },
    ],
    body: `${metrics}${panels}`,
  });
}

app.get("/healthz", (req, res) => {
  const snapshot = bridgeManager.getStatusSnapshot() as BrowserStatusSnapshot;

  if (shouldRenderBrowserUi(req)) {
    res.status(200).send(renderHealthPage(snapshot));
    return;
  }

  res.json({
    ok: true,
    service: config.bridgeId,
    status: snapshot,
  });
});

app.get("/admin/status", (req, res) => {
  const snapshot = bridgeManager.getStatusSnapshot() as BrowserStatusSnapshot;

  if (shouldRenderBrowserUi(req)) {
    res.status(200).send(renderStatusPage(snapshot));
    return;
  }

  res.json(snapshot);
});

app.get("/admin/login", async (_req, res) => {
  try {
    const login = await bridgeManager.beginLogin();
    if (login.alreadyAuthorized) {
      res
        .status(200)
        .send(
          renderHtml(
            "Bridge Authorized",
            `<p>${config.providerName} OAuth is already valid for this bridge.</p><p>The proxied tool catalog has been refreshed. Reconnect your MCP client if it was already open.</p>`,
          ),
        );
      return;
    }

    res.redirect(login.authorizationUrl!);
  } catch (error) {
    res.status(500).send(
      renderHtml(
        "Login Failed",
        `<p>${String(error instanceof Error ? error.message : error)}</p>`,
      ),
    );
  }
});

app.get("/admin/oauth/callback", async (req, res) => {
  const code = typeof req.query.code === "string" ? req.query.code : undefined;
  const error = typeof req.query.error === "string" ? req.query.error : undefined;

  if (error) {
    res.status(400).send(
      renderHtml(
        "OAuth Failed",
        `<p>Upstream ${config.providerName} OAuth returned an error: <code>${error}</code></p>`,
      ),
    );
    return;
  }

  if (!code) {
    res.status(400).send(
      renderHtml(
        "OAuth Failed",
        "<p>No authorization code was provided by the upstream server.</p>",
      ),
    );
    return;
  }

  try {
    await bridgeManager.completeLogin(code);
    res.status(200).send(
      renderHtml(
        "Bridge Ready",
        `<p>${config.providerName} OAuth completed successfully and the tool catalog was refreshed.</p><p>Your internal MCP clients can now connect to <code>/mcp</code>. Existing clients should reconnect to pick up the latest tools.</p>`,
      ),
    );
  } catch (callbackError) {
    res.status(500).send(
      renderHtml(
        "OAuth Failed",
        `<p>${String(
          callbackError instanceof Error
            ? callbackError.message
            : callbackError,
        )}</p>`,
      ),
    );
  }
});

app.post("/admin/sync-tools", async (_req, res) => {
  try {
    await bridgeManager.syncTools(true);
    res.json({
      ok: true,
      status: bridgeManager.getStatusSnapshot(),
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: String(error instanceof Error ? error.message : error),
    });
  }
});

async function handleMcpRequest(req: Request, res: Response): Promise<void> {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  try {
    let entry = sessionId ? sessions.get(sessionId) : undefined;

    if (!entry && !sessionId && isInitializeRequest(req.body)) {
      const server = new McpServer(
        {
          name: config.bridgeId,
          version: "0.1.0",
        },
        {
          capabilities: {
            logging: {},
          },
        },
      );

      bridgeManager.attachServer(server);

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId) => {
          sessions.set(newSessionId, { server, transport });
        },
      });

      transport.onclose = () => {
        if (transport.sessionId) {
          sessions.delete(transport.sessionId);
        }
        bridgeManager.detachServer(server);
      };

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    if (!entry && sessionId) {
      res.status(404).json({
        jsonrpc: "2.0",
        error: {
          code: -32001,
          message: "Session not found.",
        },
        id: null,
      });
      return;
    }

    if (!entry) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Bad request: missing or invalid MCP session state.",
        },
        id: null,
      });
      return;
    }

    await entry.transport.handleRequest(req, res, req.body);
  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: String(error instanceof Error ? error.message : error),
        },
        id: null,
      });
    }
  }
}

app.post("/mcp", requireInternalBearerToken, async (req, res) => {
  await handleMcpRequest(req, res);
});

app.get("/mcp", requireInternalBearerToken, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId) {
    res.status(400).send(
      renderHtml(
        "MCP Client Endpoint",
        "<p><code>/mcp</code> is the Streamable HTTP MCP endpoint for MCP clients, not a normal browser page.</p><p>If you are testing in a browser, use <code>/healthz</code>, <code>/admin/status</code>, or <code>/admin/login</code> instead.</p><p>If you are connecting an MCP client, point it to <code>/mcp</code> and let the client create the MCP session automatically.</p>",
      ),
    );
    return;
  }

  const entry = sessions.get(sessionId);
  if (!entry) {
    res.status(404).send("Session not found.");
    return;
  }

  await entry.transport.handleRequest(req, res);
});

app.delete("/mcp", requireInternalBearerToken, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId) {
    res.status(400).send("Missing MCP session ID.");
    return;
  }

  const entry = sessions.get(sessionId);
  if (!entry) {
    res.status(404).send("Session not found.");
    return;
  }

  await entry.transport.handleRequest(req, res);
});

const server = app.listen(config.port, config.host, () => {
  console.log(
    `${config.bridgeName} listening on ${config.publicBaseUrl} with MCP endpoint ${config.publicBaseUrl}/mcp`,
  );
  console.log(`Admin login: ${config.publicBaseUrl}/admin/login`);
  void bridgeManager.syncTools().catch((error) => {
    console.warn(
      `Initial tool sync skipped: ${String(
        error instanceof Error ? error.message : error,
      )}`,
    );
  });
});

process.on("SIGINT", async () => {
  for (const [sessionId, entry] of sessions) {
    try {
      await entry.transport.close();
    } catch {
      // Best-effort shutdown.
    }
    bridgeManager.detachServer(entry.server);
    sessions.delete(sessionId);
  }

  server.close(() => {
    process.exit(0);
  });
});
