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
import { BridgesRegistry } from "./lib/bridgesRegistry.js";
import type { BridgeConfig } from "./config.js";
import type { ManagedBridge } from "./types.js";

const config = loadConfig();
const bridgesRegistry = new BridgesRegistry();

// Map of bridgeId -> { manager, sessions }
type BridgeEntry = {
  manager: OAuthMcpBridgeManager;
  sessions: Map<string, SessionEntry>;
};

const bridges = new Map<string, BridgeEntry>();

// Initialize all enabled bridges
function initializeBridges(): void {
  const enabledBridges = bridgesRegistry.getEnabledBridges();
  console.log(`Initializing ${enabledBridges.length} bridge(s) from registry...`);

  for (const bridge of enabledBridges) {
    try {
      const bridgeConfig = createBridgeConfig(bridge);
      const manager = new OAuthMcpBridgeManager(bridgeConfig);
      bridges.set(bridge.bridgeId, {
        manager,
        sessions: new Map<string, SessionEntry>(),
      });
      console.log(`✓ Initialized bridge: ${bridge.bridgeName} (${bridge.bridgeId})`);
    } catch (error) {
      console.error(
        `✗ Failed to initialize bridge ${bridge.bridgeId}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  if (bridges.size === 0) {
    console.warn("No bridges were initialized. Add bridges via /admin/bridges API.");
  }
}

// Convert ManagedBridge to BridgeConfig for OAuthMcpBridgeManager
function createBridgeConfig(bridge: ManagedBridge): BridgeConfig {
  return {
    bridgeId: bridge.bridgeId,
    bridgeName: bridge.bridgeName,
    providerName: bridge.providerName,
    host: config.host,
    port: config.port,
    publicBaseUrl: config.publicBaseUrl,
    internalBearerToken: config.internalBearerToken,
    allowedTools: config.allowedTools,
    oauthRedirectUri: `${config.publicBaseUrl}/admin/bridges/${bridge.bridgeId}/oauth/callback`,
    oauthScope: bridge.oauthScope,
    oauthClientName: `${bridge.providerName} MCP Auth Bridge`,
    tokenStorePath: `./data/${bridge.bridgeId}-oauth.json`,
    upstreamTimeoutMs: config.upstreamTimeoutMs,
    endpoints: bridge.endpoints,
  };
}

// Get or create a bridge
function getBridge(bridgeId: string): BridgeEntry | undefined {
  return bridges.get(bridgeId);
}

// Get all active bridge IDs
function getActiveBridgeIds(): string[] {
  return Array.from(bridges.keys());
}

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

// This will be populated by initializeBridges() - don't initialize here
// const sessions = new Map<string, SessionEntry>();

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
  if (req.query.format === "json" || req.query.raw === "1") {
    return false;
  }

  const accept = String(req.headers.accept || "");
  const requestedWith = String(req.headers["x-requested-with"] || "").toLowerCase();

  if (requestedWith === "xmlhttprequest") {
    return false;
  }

  if (accept.includes("application/json") && !accept.includes("text/html")) {
    return false;
  }

  return true;
}

function shouldReturnAdminBridgeJson(req: Request): boolean {
  return req.query.format === "json" || req.query.raw === "1";
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

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name || error.constructor.name;
  }

  return String(error);
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
      ${items.length > 0
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

// Multi-Bridge Rendering Functions

function renderBridgeAdminTable(snapshots: any[]): string {
  if (snapshots.length === 0) {
    return `
      <section class="panel">
        <h2>No Bridges Configured</h2>
        <p class="muted">Use the "+ Add Bridge" button below to get started.</p>
      </section>
    `;
  }

  const rows = snapshots
    .map((snapshot) => {
      const bridgeId = snapshot.bridgeId || "unknown";
      const isAuthorized = snapshot.authorized ? "✓" : "✗";
      const authClass = snapshot.authorized ? "status-good" : "status-warn";
      return `
        <tr>
          <td><strong>${escapeHtml(snapshot.bridgeName || bridgeId)}</strong><br><span class="mono">${escapeHtml(bridgeId)}</span></td>
          <td>${escapeHtml(snapshot.providerName || "Unknown")}</td>
          <td class="${authClass}">${isAuthorized} ${snapshot.authorized ? "Connected" : "Login needed"}</td>
          <td>${snapshot.toolCount ?? 0} tools</td>
          <td>
            <a href="/mcp/${escapeHtml(bridgeId)}" class="button button-tiny">Endpoint</a>
            <a href="/admin/bridges/${escapeHtml(bridgeId)}" class="button button-tiny">Details</a>
            <a href="/admin/bridges/${escapeHtml(bridgeId)}/login" class="button button-tiny">Auth</a>
          </td>
        </tr>
      `;
    })
    .join("");

  return `
    <section class="panel panel-wide">
      <h2>MCP Bridges</h2>
      <table class="bridges-table">
        <thead>
          <tr>
            <th>Bridge</th>
            <th>Provider</th>
            <th>Status</th>
            <th>Tools</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    </section>
  `;
}

function renderBridgesManagementPage(snapshots: any[]): string {
  return renderShell("Bridges Management", {
    kicker: "Admin",
    summary: `Managing ${snapshots.length} MCP bridge(s)`,
    badge: `${snapshots.length} Active`,
    actions: [
      { href: "/healthz", label: "Dashboard" },
      { href: "/admin/status", label: "Status View", variant: "secondary" },
    ],
    body: `
      ${renderBridgeAdminTable(snapshots)}
      <section class="panel">
        <h2>Add New Bridge</h2>
        <p class="muted">Add a new MCP bridge to the system.</p>
        <button onclick="showBridgeForm()" class="button">+ Add Bridge</button>
      </section>
      ${renderBridgeFormModal()}
      <style>
        .bridges-table {
          width: 100%;
          border-collapse: collapse;
          margin: 14px 0;
        }
        .bridges-table th {
          background: rgba(28, 36, 53, 0.08);
          padding: 12px;
          text-align: left;
          font-weight: 700;
          border-bottom: 2px solid var(--line);
          color: var(--ink);
        }
        .bridges-table td {
          padding: 14px 12px;
          border-bottom: 1px solid var(--line);
        }
        .bridges-table tr:hover {
          background: rgba(28, 36, 53, 0.04);
        }
        .mono {
          font-family: ui-monospace, monospace;
          font-size: 0.85rem;
          color: var(--muted);
        }
        .status-good {
          color: var(--good);
          font-weight: 700;
        }
        .status-warn {
          color: var(--warn);
          font-weight: 700;
        }
        .button-tiny {
          padding: 6px 10px !important;
          font-size: 0.8rem !important;
          min-height: 28px !important;
          margin-right: 4px;
        }
      </style>
      <script>
        function showBridgeForm() {
          document.getElementById('bridgeFormModal').style.display = 'block';
        }

        function closeBridgeForm() {
          document.getElementById('bridgeFormModal').style.display = 'none';
        }

        function submitBridgeForm(event) {
          event.preventDefault();
          const formData = new FormData(event.target);
          const bridgeId = String(formData.get('bridgeId'));
          const bridgeName = String(formData.get('bridgeName'));
          const providerName = String(formData.get('providerName'));
          
          try {
            const endpoints = JSON.parse(String(formData.get('endpoints')));
            
            fetch('/admin/bridges', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ bridgeId, bridgeName, providerName, endpoints })
            })
              .then(r => r.json())
              .then(d => {
                if (d.ok) {
                  alert('Bridge added! Redirecting to login...');
                  location.href = \`/admin/bridges/\${bridgeId}/login\`;
                } else {
                  alert('Error: ' + d.error);
                }
              })
              .catch(e => alert('Failed to add bridge: ' + e.message));
          } catch (e) {
            alert('Invalid JSON in endpoints: ' + e.message);
          }
        }
      </script>
    `,
  });
}

function renderBridgeFormModal(): string {
  return `
    <div id="bridgeFormModal" class="modal" style="display: none;">
      <div class="modal-content">
        <span class="close" onclick="closeBridgeForm()">&times;</span>
        <h2>Add New MCP Bridge</h2>
        <form onsubmit="submitBridgeForm(event)">
          <div class="form-group">
            <label for="bridgeId">Bridge ID <span style="color: var(--accent);">*</span></label>
            <input type="text" id="bridgeId" name="bridgeId" placeholder="e.g., zepto, blinkit, etc." required pattern="[a-z0-9-]+">
            <small style="color: var(--muted);">Lowercase, hyphens allowed. Must be unique.</small>
          </div>
          <div class="form-group">
            <label for="bridgeName">Bridge Name <span style="color: var(--accent);">*</span></label>
            <input type="text" id="bridgeName" name="bridgeName" placeholder="e.g., Zepto MCP, Blinkit Express" required>
            <small style="color: var(--muted);">Display name for this bridge.</small>
          </div>
          <div class="form-group">
            <label for="providerName">Provider Name <span style="color: var(--accent);">*</span></label>
            <input type="text" id="providerName" name="providerName" placeholder="e.g., Zepto, Blinkit" required>
            <small style="color: var(--muted);">Name of the service provider.</small>
          </div>
          <div class="form-group">
            <label for="endpoints">Endpoints (JSON array) <span style="color: var(--accent);">*</span></label>
            <textarea id="endpoints" name="endpoints" rows="5" required placeholder='[
  {
    "name": "Primary API",
    "url": "https://api.provider.com/mcp",
    "key": "primary"
  },
  {
    "name": "Secondary API",
    "url": "https://api2.provider.com/mcp",
    "key": "secondary"
  }
]'></textarea>
            <small style="color: var(--muted);">Each endpoint needs: name, url, and optional key.</small>
          </div>
          <div class="form-actions">
            <button type="submit" class="button">Add Bridge</button>
            <button type="button" class="button button-secondary" onclick="closeBridgeForm()">Cancel</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

// Multi-Bridge Rendering Functions

function renderBridgeCard(snapshot: any): string {
  const bridgeId = snapshot.bridgeId || "unknown";
  return `
    <article class="bridge-card">
      <div class="bridge-header">
        <h3>${escapeHtml(snapshot.bridgeName || bridgeId)}</h3>
        <span class="badge ${snapshot.authorized ? "badge-good" : "badge-warn"}">
          ${snapshot.authorized ? "Authorized" : "Login needed"}
        </span>
      </div>
      <div class="bridge-metrics">
        <div class="metric-mini">
          <div class="metric-label">Provider</div>
          <div class="metric-value">${escapeHtml(snapshot.providerName || "Unknown")}</div>
        </div>
        <div class="metric-mini">
          <div class="metric-label">Tools</div>
          <div class="metric-value">${snapshot.toolCount ?? 0}</div>
        </div>
      </div>
      <div class="bridge-actions">
        <a href="/admin/bridges/${escapeHtml(bridgeId)}/login" class="button button-small">Login</a>
        <a href="/admin/bridges/${escapeHtml(bridgeId)}" class="button button-small button-secondary">View Details</a>
      </div>
    </article>
  `;
}

function renderMultiBridgeHealth(snapshots: any[]): string {
  const bridgesHtml = snapshots.length > 0
    ? `<div class="bridges-grid">${snapshots.map(renderBridgeCard).join("")}</div>`
    : `<p class="muted">No bridges are configured. Use the API to add one.</p>`;

  const addBridgeButton = `
    <div style="margin-top: 20px; text-align: center;">
      <button onclick="showAddBridgeModal()" class="button">+ Add MCP Bridge</button>
    </div>
  `;

  return renderShell("MCP Bridges Overview", {
    kicker: "Dashboard",
    summary: `${snapshots.length} bridge(s) active`,
    badge: `${snapshots.length} Bridges`,
    actions: [
      { href: "/admin/status", label: "Detailed Status" },
      { href: "/admin/bridges", label: "API", variant: "secondary" },
    ],
    body: `
      <section class="panel">
        ${bridgesHtml}
        ${addBridgeButton}
      </section>
      ${renderAddBridgeModal()}
      <script>
        function showAddBridgeModal() {
          document.getElementById('addBridgeModal').style.display = 'block';
        }

        function closeAddBridgeModal() {
          document.getElementById('addBridgeModal').style.display = 'none';
        }

        function submitAddBridge(event) {
          event.preventDefault();
          const formData = new FormData(event.target);
          const bridgeId = String(formData.get('bridgeId'));
          const bridgeName = String(formData.get('bridgeName'));
          const providerName = String(formData.get('providerName'));
          const endpoints = JSON.parse(String(formData.get('endpoints')));

          fetch('/admin/bridges', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ bridgeId, bridgeName, providerName, endpoints })
          })
            .then(r => r.json())
            .then(d => {
              if (d.ok) {
                alert('Bridge added! Redirecting to login...');
                location.href = \`/admin/bridges/\${bridgeId}/login\`;
              } else {
                alert('Error: ' + d.error);
              }
            })
            .catch(e => alert('Failed to add bridge: ' + e.message));
        }
      </script>
    `,
  });
}

function renderMultiBridgeStatus(snapshots: any[]): string {
  const bridgeDetails = snapshots
    .map((snapshot) => {
      const bridgeId = snapshot.bridgeId || "unknown";
      const metrics = renderMetricCards([
        {
          label: "Authorization",
          value: snapshot.authorized ? "Connected" : "Not connected",
          tone: snapshot.authorized ? "good" : "warn",
        },
        {
          label: "Tools",
          value: `${snapshot.toolCount ?? 0}`,
          tone: (snapshot.toolCount ?? 0) > 0 ? "good" : "neutral",
        },
        {
          label: "Last Sync",
          value: snapshot.lastSyncAt ? new Date(snapshot.lastSyncAt).toLocaleTimeString() : "Never",
          tone: "neutral",
        },
      ]);

      const endpoints = (snapshot.endpoints || [])
        .map(
          (ep: any) =>
            `<strong>${escapeHtml(ep.name)}</strong><br /><span class="mono">${escapeHtml(ep.url)}</span>`,
        );

      return `
        <section class="panel panel-bridge">
          <div class="panel-header">
            <h2>${escapeHtml(snapshot.bridgeName || bridgeId)}</h2>
            <span class="endpoint-path">/mcp/${escapeHtml(bridgeId)}</span>
          </div>
          ${metrics}
          <div class="bridge-section">
            <h3>Endpoints</h3>
            ${endpoints.length > 0 ? `<ul class="detail-list">${endpoints.map((e: string) => `<li>${e}</li>`).join("")}</ul>` : '<p class="muted">No endpoints configured</p>'}
          </div>
          <div class="bridge-actions">
            <a href="/admin/bridges/${escapeHtml(bridgeId)}/login" class="button button-small">Authorize</a>
            <a href="/admin/bridges/${escapeHtml(bridgeId)}/sync-tools" onclick="syncBridgeTools(event, '${escapeHtml(bridgeId)}')" class="button button-small">Sync Tools</a>
            <a href="/admin/bridges/${escapeHtml(bridgeId)}" class="button button-small button-secondary">API</a>
          </div>
        </section>
      `;
    })
    .join("");

  return renderShell("MCP Bridges Status", {
    kicker: "Operations",
    summary: `Managing ${snapshots.length} MCP bridge(s)`,
    badge: `${snapshots.length} Bridges`,
    actions: [
      { href: "/healthz", label: "Quick Overview" },
      { href: "#", label: "+ Add Bridge", variant: "secondary" },
    ],
    body: `
      ${bridgeDetails}
      ${renderAddBridgeModal()}
      <script>
        function syncBridgeTools(event, bridgeId) {
          event.preventDefault();
          fetch(\`/admin/bridges/\${bridgeId}/sync-tools\`, { method: 'POST' })
            .then(r => r.json())
            .then(d => {
              alert('Tools synced for ' + bridgeId);
              location.reload();
            })
            .catch(e => alert('Sync failed: ' + e.message));
        }

        function showAddBridgeModal() {
          document.getElementById('addBridgeModal').style.display = 'block';
        }

        function closeAddBridgeModal() {
          document.getElementById('addBridgeModal').style.display = 'none';
        }

        function submitAddBridge(event) {
          event.preventDefault();
          const formData = new FormData(event.target);
          const bridgeId = String(formData.get('bridgeId'));
          const bridgeName = String(formData.get('bridgeName'));
          const providerName = String(formData.get('providerName'));
          const endpoints = JSON.parse(String(formData.get('endpoints')));

          fetch('/admin/bridges', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ bridgeId, bridgeName, providerName, endpoints })
          })
            .then(r => r.json())
            .then(d => {
              if (d.ok) {
                alert('Bridge added! Redirecting to login...');
                location.href = \`/admin/bridges/\${bridgeId}/login\`;
              } else {
                alert('Error: ' + d.error);
              }
            })
            .catch(e => alert('Failed to add bridge: ' + e.message));
        }
      </script>
    `,
  });
}

function renderAddBridgeModal(): string {
  return `
    <div id="addBridgeModal" class="modal" style="display: none;">
      <div class="modal-content">
        <span class="close" onclick="closeAddBridgeModal()">&times;</span>
        <h2>Add New MCP Bridge</h2>
        <form onsubmit="submitAddBridge(event)">
          <div class="form-group">
            <label for="bridgeId">Bridge ID (lowercase, hyphens ok)</label>
            <input type="text" id="bridgeId" name="bridgeId" placeholder="e.g., zepto" required>
          </div>
          <div class="form-group">
            <label for="bridgeName">Bridge Name</label>
            <input type="text" id="bridgeName" name="bridgeName" placeholder="e.g., Zepto MCP" required>
          </div>
          <div class="form-group">
            <label for="providerName">Provider Name</label>
            <input type="text" id="providerName" name="providerName" placeholder="e.g., Zepto" required>
          </div>
          <div class="form-group">
            <label for="endpoints">Endpoints (JSON array)</label>
            <textarea id="endpoints" name="endpoints" rows="4" placeholder='[{"name":"Zepto API","url":"https://api.zepto.com/mcp"}]' required></textarea>
          </div>
          <div class="form-actions">
            <button type="submit" class="button">Add Bridge</button>
            <button type="button" class="button button-secondary" onclick="closeAddBridgeModal()">Cancel</button>
          </div>
        </form>
      </div>
    </div>
    <style>
      .modal {
        position: fixed;
        z-index: 1000;
        left: 0;
        top: 0;
        width: 100%;
        height: 100%;
        background-color: rgba(0,0,0,0.5);
      }
      .modal-content {
        background-color: var(--surface);
        margin: 5% auto;
        padding: 28px;
        border: 1px solid var(--line);
        border-radius: 22px;
        width: 90%;
        max-width: 500px;
      }
      .close {
        color: var(--muted);
        float: right;
        font-size: 28px;
        font-weight: bold;
        cursor: pointer;
      }
      .close:hover {
        color: var(--ink);
      }
      .form-group {
        margin-bottom: 16px;
      }
      .form-group label {
        display: block;
        margin-bottom: 6px;
        font-weight: 700;
        color: var(--ink);
      }
      .form-group input,
      .form-group textarea {
        width: 100%;
        padding: 10px;
        border: 1px solid var(--line);
        border-radius: 8px;
        font-family: inherit;
        box-sizing: border-box;
      }
      .form-actions {
        display: flex;
        gap: 10px;
        margin-top: 20px;
      }
      .form-actions button {
        flex: 1;
      }
      .bridges-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
        gap: 14px;
      }
      .bridge-card {
        background: rgba(255, 255, 255, 0.78);
        border: 1px solid var(--line);
        border-radius: 16px;
        padding: 18px;
      }
      .bridge-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 12px;
      }
      .bridge-header h3 {
        margin: 0;
        font-size: 1.1rem;
      }
      .badge-good {
        background: rgba(18, 122, 82, 0.2);
        color: var(--good);
      }
      .badge-warn {
        background: rgba(154, 75, 31, 0.2);
        color: var(--warn);
      }
      .bridge-metrics {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
        margin-bottom: 14px;
      }
      .metric-mini {
        background: rgba(28, 36, 53, 0.04);
        padding: 10px;
        border-radius: 8px;
      }
      .metric-label {
        font-size: 0.78rem;
        color: var(--muted);
        font-weight: 700;
        text-transform: uppercase;
      }
      .metric-value {
        font-size: 1.2rem;
        font-weight: 800;
      }
      .bridge-actions {
        display: flex;
        gap: 8px;
      }
      .button-small {
        flex: 1;
        padding: 8px 12px !important;
        font-size: 0.9rem;
        min-height: 36px;
      }
      .panel-bridge {
        margin-bottom: 14px;
      }
      .panel-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 14px;
        padding-bottom: 14px;
        border-bottom: 1px solid var(--line);
      }
      .panel-header h2 {
        margin: 0;
      }
      .endpoint-path {
        background: rgba(28, 36, 53, 0.08);
        padding: 4px 8px;
        border-radius: 6px;
        font-family: ui-monospace, monospace;
        font-size: 0.85rem;
        color: var(--muted);
      }
      .bridge-section h3 {
        font-size: 0.95rem;
        margin: 14px 0 8px 0;
      }
    </style>
  `;
}

app.get("/healthz", (req, res) => {
  if (shouldRenderBrowserUi(req)) {
    // Show multi-bridge overview
    const bridgeSnapshots = Array.from(bridges.entries()).map(([bridgeId, entry]) => ({
      bridgeId,
      ...entry.manager.getStatusSnapshot(),
    }));

    const multiHtml = renderMultiBridgeHealth(bridgeSnapshots);
    res.status(200).send(multiHtml);
    return;
  }

  // JSON API: return all bridges
  const bridgeSnapshots = Array.from(bridges.entries()).map(([bridgeId, entry]) => ({
    bridgeId,
    ...entry.manager.getStatusSnapshot(),
  }));

  res.json({
    ok: true,
    bridges: bridgeSnapshots,
  });
});

app.get("/admin/status", (req, res) => {
  if (shouldRenderBrowserUi(req)) {
    const bridgeSnapshots = Array.from(bridges.entries()).map(([bridgeId, entry]) => ({
      bridgeId,
      ...entry.manager.getStatusSnapshot(),
    }));

    const multiHtml = renderMultiBridgeStatus(bridgeSnapshots);
    res.status(200).send(multiHtml);
    return;
  }

  const bridgeSnapshots = Array.from(bridges.entries()).map(([bridgeId, entry]) => ({
    bridgeId,
    ...entry.manager.getStatusSnapshot(),
  }));

  res.json(bridgeSnapshots);
});

// Legacy endpoints - redirect to first bridge or dashboard
app.get("/admin/login", async (_req, res) => {
  const firstBridge = getActiveBridgeIds()[0];
  if (firstBridge) {
    res.redirect(`/admin/bridges/${firstBridge}/login`);
  } else {
    res.status(503).send(
      renderHtml("No Bridges", "<p>No bridges are configured. Use the API to add one.</p>"),
    );
  }
});

app.get("/admin/oauth/callback", async (req, res) => {
  res.status(400).send(
    renderHtml(
      "OAuth Callback Error",
      "<p>This callback URL is deprecated. Callbacks are now per-bridge at <code>/admin/bridges/{bridgeId}/oauth/callback</code>.</p>",
    ),
  );
});

app.post("/admin/sync-tools", async (_req, res) => {
  const firstBridge = getActiveBridgeIds()[0];
  if (!firstBridge) {
    res.status(503).json({
      ok: false,
      error: "No bridges are configured",
    });
    return;
  }

  const entry = getBridge(firstBridge);
  if (!entry) {
    res.status(404).json({
      ok: false,
      error: "Bridge not found",
    });
    return;
  }

  try {
    await entry.manager.syncTools(true);
    res.json({
      ok: true,
      status: entry.manager.getStatusSnapshot(),
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: String(error instanceof Error ? error.message : error),
    });
  }
});

// ====== BRIDGE MANAGEMENT API ======

// List all bridges
app.get("/admin/bridges", (req, res) => {
  const bridgeSnapshots = Array.from(bridges.entries()).map(([bridgeId, entry]) => ({
    bridgeId,
    ...entry.manager.getStatusSnapshot(),
  }));

  if (shouldRenderBrowserUi(req)) {
    res.status(200).send(renderBridgesManagementPage(bridgeSnapshots));
    return;
  }

  res.json({
    ok: true,
    bridges: bridgeSnapshots,
    total: bridgeSnapshots.length,
  });
});

// Add a new bridge
app.post("/admin/bridges", async (req, res) => {
  try {
    const { bridgeId, bridgeName, providerName, oauthScope, endpoints } = req.body;

    // Validate input
    if (!bridgeId || !bridgeName || !providerName || !endpoints) {
      res.status(400).json({
        ok: false,
        error: "Missing required fields: bridgeId, bridgeName, providerName, endpoints",
      });
      return;
    }

    // Add to registry
    const result = bridgesRegistry.addBridge({
      bridgeId,
      bridgeName,
      providerName,
      oauthScope,
      endpoints,
    });

    if (!result.success) {
      res.status(400).json({ ok: false, error: result.error });
      return;
    }

    // Initialize the new bridge
    try {
      const bridgeConfig = createBridgeConfig(result.bridge!);
      const manager = new OAuthMcpBridgeManager(bridgeConfig);
      bridges.set(bridgeId, {
        manager,
        sessions: new Map<string, SessionEntry>(),
      });

      res.status(201).json({
        ok: true,
        bridge: result.bridge,
        message: `Bridge "${bridgeId}" added successfully. Navigate to /admin/bridges/${bridgeId}/login to authorize.`,
      });
    } catch (initError) {
      // Rollback registry addition
      bridgesRegistry.deleteBridge(bridgeId);
      res.status(500).json({
        ok: false,
        error: `Failed to initialize bridge: ${formatErrorMessage(initError)}`,
      });
    }
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: formatErrorMessage(error),
    });
  }
});

function renderBridgeDetailPage(snapshot: any, bridgeId: string): string {
  const isAuthorized = snapshot.authorized;
  const authStatus = isAuthorized ? "Connected" : "Login needed";
  const authTone = isAuthorized ? "good" : "warn";

  const metrics = renderMetricCards([
    {
      label: "Authorization",
      value: authStatus,
      tone: authTone as any,
    },
    {
      label: "Tool Count",
      value: `${snapshot.toolCount ?? 0}`,
      tone: (snapshot.toolCount ?? 0) > 0 ? "good" : "neutral",
    },
    {
      label: "Last Synced",
      value: snapshot.lastSyncAt ? new Date(snapshot.lastSyncAt).toLocaleTimeString() : "Never",
      tone: "neutral",
    },
    {
      label: "Token Expires",
      value: snapshot.tokenExpiresAt ? new Date(snapshot.tokenExpiresAt).toLocaleDateString() : "N/A",
      tone: "neutral",
    },
  ]);

  const endpointsList = (snapshot.endpoints || [])
    .map((ep: any) => `<li><strong>${escapeHtml(ep.name)}</strong><br><span class="mono">${escapeHtml(ep.url)}</span></li>`)
    .join("");

  const toolsTable = (snapshot.proxiedTools || [])
    .map((tool: any) => `
    <tr>
      <td><strong>${escapeHtml(tool.name)}</strong></td>
      <td>${escapeHtml(tool.endpoint || "")}</td>
      <td><span class="mono">${escapeHtml(tool.url || "")}</span></td>
    </tr>
  `)
    .join("");

  const endpointPath = `/mcp/${escapeHtml(bridgeId)}`;

  return renderShell(`${snapshot.bridgeName || bridgeId} Details`, {
    kicker: "Bridge Details",
    summary: `Provider: ${escapeHtml(snapshot.providerName || "Unknown")}`,
    badge: isAuthorized ? "Authorized" : "Login needed",
    actions: [
      { href: "/admin/bridges", label: "Back to Bridges" },
      { href: `/admin/bridges/${escapeHtml(bridgeId)}/login`, label: "Authorize", variant: isAuthorized ? "secondary" : "primary" },
    ],
    body: `
      <section class="panel">
        <h2>Status Overview</h2>
        ${metrics}
        <div style="margin-top: 16px; padding: 12px; background: rgba(28, 36, 53, 0.08); border-radius: 8px;">
          <strong>Endpoint Path:</strong> <code style="background: transparent; padding: 0;">${escapeHtml(endpointPath)}</code>
        </div>
      </section>

      <section class="panel">
        <h2>Configuration</h2>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 14px;">
          <div>
            <strong style="display: block; margin-bottom: 8px;">OAuth Token Store</strong>
            <code style="background: rgba(28, 36, 53, 0.08); padding: 8px; border-radius: 6px; display: block; word-break: break-all;">${escapeHtml(snapshot.tokenStorePath)}</code>
          </div>
          <div>
            <strong style="display: block; margin-bottom: 8px;">Provider Name</strong>
            <p style="margin: 0;">${escapeHtml(snapshot.providerName)}</p>
          </div>
        </div>
      </section>

      <section class="panel">
        <h2>Upstream Endpoints (${snapshot.endpoints?.length || 0})</h2>
        ${endpointsList ? `<ul class="detail-list">${endpointsList}</ul>` : '<p class="muted">No endpoints configured</p>'}
      </section>

<section class="panel">
  <h2>Proxied Tools (${snapshot.toolCount ?? 0} total)</h2>
  ${toolsTable ? `
    <table style="width:100%;border-collapse:collapse;">
      <thead>
        <tr>
          <th style="text-align:left;padding:10px;border-bottom:1px solid var(--line);">Tool</th>
          <th style="text-align:left;padding:10px;border-bottom:1px solid var(--line);">Endpoint</th>
          <th style="text-align:left;padding:10px;border-bottom:1px solid var(--line);">URL</th>
        </tr>
      </thead>
      <tbody>${toolsTable}</tbody>
    </table>
  ` : '<p class="muted">No tools synced yet</p>'}
</section>

      <script>
        function syncTools(event, bridgeId) {
          event.preventDefault();
          if (!confirm('Sync tools for this bridge?')) return;
          fetch(\`/admin/bridges/\${bridgeId}/sync-tools\`, { method: 'POST' })
            .then(r => r.json())
            .then(d => {
              if (d.ok) {
                alert('Tools synced successfully');
                location.reload();
              } else {
                alert('Sync failed: ' + d.error);
              }
            })
            .catch(e => alert('Error: ' + e.message));
        }

        function deleteBridge(bridgeId) {
          if (!confirm('Are you sure you want to delete this bridge? This cannot be undone.')) return;
          fetch(\`/admin/bridges/\${bridgeId}\`, { method: 'DELETE' })
            .then(r => r.json())
            .then(d => {
              if (d.ok) {
                alert('Bridge deleted');
                location.href = '/admin/bridges';
              } else {
                alert('Delete failed: ' + d.error);
              }
            })
            .catch(e => alert('Error: ' + e.message));
        }
      </script>
    `,
  });
}

// Get bridge details
app.get("/admin/bridges/:bridgeId", (req, res) => {
  const { bridgeId } = req.params;
  const entry = getBridge(bridgeId);

  if (!entry) {
    const errorMessage = `Bridge "${bridgeId}" not found`;

    if (req.query.format === "json" || req.query.raw === "1") {
      res.status(404).json({
        ok: false,
        error: errorMessage,
      });
      return;
    }

    res.status(404).type("html").send(
      renderHtml(
        "Bridge Not Found",
        `<p>${escapeHtml(errorMessage)}</p><p><a href="/admin/bridges">Back to bridges</a></p>`,
      ),
    );
    return;
  }

  const snapshot = {
    bridgeId,
    ...entry.manager.getStatusSnapshot(),
  };

  // JSON only when explicitly requested.
  if (req.query.format === "json" || req.query.raw === "1") {
    res.json({
      ok: true,
      bridge: snapshot,
    });
    return;
  }

  // Browser/admin UI by default.
  res
    .status(200)
    .setHeader("X-Admin-Bridge-UI", "1")
    .type("html")
    .send(renderBridgeDetailPage(snapshot, bridgeId));
});

// Delete a bridge
app.delete("/admin/bridges/:bridgeId", (req, res) => {
  const { bridgeId } = req.params;
  const entry = getBridge(bridgeId);

  if (!entry) {
    res.status(404).json({
      ok: false,
      error: `Bridge "${bridgeId}" not found`,
    });
    return;
  }

  // Close all sessions for this bridge
  for (const [sessionId, session] of entry.sessions) {
    try {
      session.transport.close().catch(() => { });
    } catch {
      // Ignore errors during cleanup
    }
    entry.manager.detachServer(session.server);
    entry.sessions.delete(sessionId);
  }

  // Remove from registry and map
  bridges.delete(bridgeId);
  bridgesRegistry.deleteBridge(bridgeId);

  res.json({
    ok: true,
    message: `Bridge "${bridgeId}" deleted successfully.`,
  });
});

// Login to a specific bridge
app.get("/admin/bridges/:bridgeId/login", async (req, res) => {
  const { bridgeId } = req.params;
  const entry = getBridge(bridgeId);

  if (!entry) {
    res.status(404).send(
      renderHtml(
        "Bridge Not Found",
        `<p>Bridge "${escapeHtml(bridgeId)}" does not exist.</p>`,
      ),
    );
    return;
  }

  try {
    const login = await entry.manager.beginLogin();
    if (login.alreadyAuthorized) {
      res.status(200).send(
        renderHtml(
          "Bridge Authorized",
          `<p>${entry.manager.config.providerName} OAuth is already valid for this bridge.</p><p>The proxied tool catalog has been refreshed. Reconnect your MCP client if it was already open.</p><p><a href="/admin/status">Back to dashboard</a></p>`,
        ),
      );
      return;
    }

    res.redirect(login.authorizationUrl!);
  } catch (error) {
    res.status(500).send(
      renderHtml(
        "Login Failed",
        `<p>${escapeHtml(formatErrorMessage(error))}</p><p><a href="/admin/status">Back to dashboard</a></p>`,
      ),
    );
  }
});

// OAuth callback for a specific bridge
app.get("/admin/bridges/:bridgeId/oauth/callback", async (req, res) => {
  const { bridgeId } = req.params;
  const entry = getBridge(bridgeId);

  if (!entry) {
    res.status(404).send(
      renderHtml(
        "Bridge Not Found",
        `<p>Bridge "${escapeHtml(bridgeId)}" does not exist.</p>`,
      ),
    );
    return;
  }

  const code = typeof req.query.code === "string" ? req.query.code : undefined;
  const error = typeof req.query.error === "string" ? req.query.error : undefined;

  if (error) {
    res.status(400).send(
      renderHtml(
        "OAuth Failed",
        `<p>Upstream ${entry.manager.config.providerName} OAuth returned an error: <code>${error}</code></p><p><a href="/admin/status">Back to dashboard</a></p>`,
      ),
    );
    return;
  }

  if (!code) {
    res.status(400).send(
      renderHtml(
        "OAuth Failed",
        `<p>No authorization code was provided by the upstream server.</p><p><a href="/admin/status">Back to dashboard</a></p>`,
      ),
    );
    return;
  }

  try {
    await entry.manager.completeLogin(code);
    res.status(200).send(
      renderHtml(
        "Bridge Ready",
        `<p>${entry.manager.config.providerName} OAuth completed successfully and the tool catalog was refreshed.</p><p>Your internal MCP clients can now connect to <code>/mcp/${escapeHtml(bridgeId)}</code>. Existing clients should reconnect to pick up the latest tools.</p><p><a href="/admin/status">Back to dashboard</a></p>`,
      ),
    );
  } catch (callbackError) {
    res.status(500).send(
      renderHtml(
        "OAuth Failed",
        `<p>${escapeHtml(formatErrorMessage(callbackError))}</p><p><a href="/admin/status">Back to dashboard</a></p>`,
      ),
    );
  }
});

// Sync tools for a specific bridge
app.post("/admin/bridges/:bridgeId/sync-tools", async (req, res) => {
  const { bridgeId } = req.params;
  const entry = getBridge(bridgeId);

  if (!entry) {
    res.status(404).json({
      ok: false,
      error: `Bridge "${bridgeId}" not found`,
    });
    return;
  }

  try {
    await entry.manager.syncTools(true);
    res.json({
      ok: true,
      status: entry.manager.getStatusSnapshot(),
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: String(error instanceof Error ? error.message : error),
    });
  }
});

async function handleMcpRequest(req: Request, res: Response, bridgeId: string): Promise<void> {
  const bridgeEntry = getBridge(bridgeId);
  if (!bridgeEntry) {
    res.status(404).json({
      jsonrpc: "2.0",
      error: {
        code: -32001,
        message: `Bridge "${bridgeId}" not found.`,
      },
      id: null,
    });
    return;
  }

  const { manager, sessions } = bridgeEntry;
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  try {
    let entry = sessionId ? sessions.get(sessionId) : undefined;

    if (!entry && !sessionId && isInitializeRequest(req.body)) {
      const server = new McpServer(
        {
          name: `${manager.config.bridgeId}`,
          version: "0.1.0",
        },
        {
          capabilities: {
            logging: {},
          },
        },
      );

      manager.attachServer(server);

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
        manager.detachServer(server);
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

// Legacy single-bridge endpoint - routes to first active bridge
app.post("/mcp", requireInternalBearerToken, async (req, res) => {
  const bridgeId = getActiveBridgeIds()[0];
  if (!bridgeId) {
    res.status(503).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "No bridges are configured" },
      id: null,
    });
    return;
  }
  await handleMcpRequest(req, res, bridgeId);
});

// Per-bridge MCP endpoint
app.post("/mcp/:bridgeName", requireInternalBearerToken, async (req, res) => {
  await handleMcpRequest(req, res, String(req.params.bridgeName));
});

// Legacy single-bridge GET endpoint
app.get("/mcp", requireInternalBearerToken, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId) {
    res.status(400).send(
      renderHtml(
        "MCP Client Endpoint",
        "<p><code>/mcp</code> is the Streamable HTTP MCP endpoint for MCP clients, not a normal browser page.</p><p>If you are testing in a browser, use <code>/healthz</code>, <code>/admin/status</code>, or <code>/admin/login</code> instead.</p><p>To connect to a specific bridge, use <code>/mcp/{bridgeName}</code> instead.</p>",
      ),
    );
    return;
  }

  // Find which bridge this session belongs to
  for (const [bridgeId, entry] of bridges) {
    const session = entry.sessions.get(sessionId);
    if (session) {
      await session.transport.handleRequest(req, res);
      return;
    }
  }

  res.status(404).send("Session not found.");
});

// Per-bridge GET endpoint
app.get("/mcp/:bridgeName", requireInternalBearerToken, async (req, res) => {
  const bridgeName = String(req.params.bridgeName);
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (!sessionId) {
    res.status(400).send(
      renderHtml(
        "MCP Bridge Endpoint",
        `<p><code>/mcp/${escapeHtml(bridgeName)}</code> is the Streamable HTTP MCP endpoint for MCP clients, not a normal browser page.</p><p>If you are testing in a browser, use <code>/healthz</code>, <code>/admin/status</code>, or <code>/admin/login</code> instead.</p>`,
      ),
    );
    return;
  }

  const entry = getBridge(bridgeName);
  if (!entry) {
    res.status(404).send("Bridge not found.");
    return;
  }

  const session = entry.sessions.get(sessionId);
  if (!session) {
    res.status(404).send("Session not found.");
    return;
  }

  await session.transport.handleRequest(req, res);
});

// Legacy single-bridge DELETE endpoint
app.delete("/mcp", requireInternalBearerToken, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId) {
    res.status(400).send("Missing MCP session ID.");
    return;
  }

  // Find which bridge this session belongs to
  for (const [bridgeId, entry] of bridges) {
    const session = entry.sessions.get(sessionId);
    if (session) {
      await session.transport.handleRequest(req, res);
      return;
    }
  }

  res.status(404).send("Session not found.");
});

// Per-bridge DELETE endpoint
app.delete("/mcp/:bridgeName", requireInternalBearerToken, async (req, res) => {
  const bridgeName = String(req.params.bridgeName);
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (!sessionId) {
    res.status(400).send("Missing MCP session ID.");
    return;
  }

  const entry = getBridge(bridgeName);
  if (!entry) {
    res.status(404).send("Bridge not found.");
    return;
  }

  const session = entry.sessions.get(sessionId);
  if (!session) {
    res.status(404).send("Session not found.");
    return;
  }

  await session.transport.handleRequest(req, res);
});

const server = app.listen(config.port, config.host, () => {
  initializeBridges();

  const bridgeCount = bridges.size;
  const bridgeNames = getActiveBridgeIds().join(", ") || "none";
  console.log(
    `\nMCP OAuth Server listening on ${config.publicBaseUrl}`,
  );
  console.log(`Active bridges: ${bridgeNames}`);
  console.log(`Admin dashboard: ${config.publicBaseUrl}/admin/status`);
  console.log(`Bridge management API: POST ${config.publicBaseUrl}/admin/bridges`);

  // Attempt to sync tools for all bridges
  for (const [bridgeId, entry] of bridges) {
    if (entry.manager.isAuthorized()) {
      entry.manager.syncTools().catch((error) => {
        console.warn(
          `Initial tool sync for ${bridgeId} skipped: ${formatErrorMessage(error)}`,
        );
      });
    }
  }
});

process.on("SIGINT", async () => {
  console.log("\nShutting down gracefully...");

  // Close all bridge sessions and managers
  for (const [bridgeId, entry] of bridges) {
    for (const [sessionId, session] of entry.sessions) {
      try {
        await session.transport.close();
      } catch {
        // Best-effort shutdown.
      }
      entry.manager.detachServer(session.server);
      entry.sessions.delete(sessionId);
    }
  }

  server.close(() => {
    console.log("Server closed");
    process.exit(0);
  });
});
