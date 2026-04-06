import "dotenv/config";

import { randomUUID } from "node:crypto";

import cors from "cors";
import type { NextFunction, Request, Response } from "express";

import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import { loadConfig } from "./config.js";
import { SwiggyBridgeManager } from "./lib/swiggyBridgeManager.js";

const config = loadConfig();
const bridgeManager = new SwiggyBridgeManager(config);

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

function renderHtml(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <style>
      body {
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #f7f5ef;
        color: #1f2937;
        margin: 0;
        padding: 32px;
      }
      main {
        max-width: 720px;
        margin: 0 auto;
        background: #ffffff;
        border-radius: 16px;
        padding: 32px;
        box-shadow: 0 18px 45px rgba(15, 23, 42, 0.08);
      }
      h1 {
        margin-top: 0;
        font-size: 1.6rem;
      }
      code {
        background: #f3f4f6;
        padding: 2px 6px;
        border-radius: 6px;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>${title}</h1>
      ${body}
    </main>
  </body>
</html>`;
}

app.get("/healthz", (_req, res) => {
  res.json({
    ok: true,
    service: "swiggy-mcp-oauth-bridge",
    status: bridgeManager.getStatusSnapshot(),
  });
});

app.get("/admin/status", (_req, res) => {
  res.json(bridgeManager.getStatusSnapshot());
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
            "<p>Swiggy OAuth is already valid for this bridge.</p><p>The proxied tool catalog has been refreshed. Reconnect your MCP client if it was already open.</p>",
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
        `<p>Upstream Swiggy OAuth returned an error: <code>${error}</code></p>`,
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
        "<p>Swiggy OAuth completed successfully and the tool catalog was refreshed.</p><p>Your internal MCP clients can now connect to <code>/mcp</code>. Existing clients should reconnect to pick up the latest tools.</p>",
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
          name: "swiggy-mcp-oauth-bridge",
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
    `Swiggy MCP OAuth bridge listening on ${config.publicBaseUrl} with MCP endpoint ${config.publicBaseUrl}/mcp`,
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
