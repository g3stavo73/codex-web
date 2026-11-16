"use strict";

/*
 * Codex Web — temporary Node.js backend
 *
 * No npm dependencies. Serves the existing frontend and exposes the HTTP
 * routes already used by script.js. It starts `codex app-server` locally and
 * speaks the official newline-delimited JSON-RPC protocol over stdio.
 *
 * SECURITY: this server deliberately binds to 127.0.0.1 only. Do not expose
 * this development backend to the public internet or deploy it as a hosted
 * service. The local Codex CLI owns authentication and its credentials.
 */

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const readline = require("node:readline");
const { EventEmitter } = require("node:events");

const ROOT_DIR = __dirname;
const WORKSPACE_ROOT = path.resolve(process.env.CODEX_WORKSPACE || ROOT_DIR);
const HOST = "127.0.0.1";
const PORT = Number.parseInt(process.env.CODEX_WEB_PORT || "3210", 10);
const CODEX_BIN = process.env.CODEX_BIN || "codex";
const RPC_TIMEOUT_MS = 45_000;
const MAX_BODY_BYTES = 512 * 1024;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

class AppServerError extends Error {
  constructor(message, code = -32000, data = null) {
    super(message);
    this.name = "AppServerError";
    this.code = code;
    this.data = data;
  }
}

class CodexAppServer extends EventEmitter {
  constructor() {
    super();
    this.child = null;
    this.readline = null;
    this.nextId = 1;
    this.pending = new Map();
    this.starting = null;
    this.ready = false;
  }

  async ensureStarted() {
    if (this.ready && this.child && !this.child.killed) return;
    if (this.starting) return this.starting;

    this.starting = (async () => {
      const child = spawn(CODEX_BIN, ["app-server"], {
        cwd: WORKSPACE_ROOT,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"]
      });
      this.child = child;

      child.stderr.on("data", (chunk) => {
        // Keep diagnostics local; never log prompts, tokens, or RPC payloads.
        const message = String(chunk).trim();
        if (message) process.stderr.write(`[codex app-server] ${message}\n`);
      });

      child.on("error", (error) => this.fail(error));
      child.on("exit", (code, signal) => {
        this.fail(new Error(
          `Codex App Server encerrou (code=${code ?? "null"}, signal=${signal ?? "null"}).`
        ));
      });

      this.readline = readline.createInterface({ input: child.stdout });
      this.readline.on("line", (line) => this.receiveLine(line));

      await new Promise((resolve, reject) => {
        const onSpawn = () => {
          cleanup();
          resolve();
        };
        const onError = (error) => {
          cleanup();
          reject(error);
        };
        const cleanup = () => {
          child.off("spawn", onSpawn);
          child.off("error", onError);
        };
        child.once("spawn", onSpawn);
        child.once("error", onError);
      });

      await this.call("initialize", {
        clientInfo: {
          name: "codex_web",
          title: "Codex Web",
          version: "0.1.0"
        }
      });
      this.notify("initialized", {});
      this.ready = true;
    })();

    try {
      await this.starting;
    } catch (error) {
      this.fail(error);
      throw this.explainStartupError(error);
    } finally {
      this.starting = null;
    }
  }

  explainStartupError(error) {
    if (error && error.code === "ENOENT") {
      return new Error(
        `Não encontrei o comando '${CODEX_BIN}'. Instale/configure o Codex CLI ou defina CODEX_BIN com o caminho do executável.`
      );
    }
    return error;
  }

  receiveLine(line) {
    if (!line.trim()) return;

    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.emit("protocolError", new Error("Codex App Server enviou uma linha JSON inválida."));
      return;
    }

    // Response to a request initiated by this backend.
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);

      if (message.error) {
        pending.reject(new AppServerError(
          message.error.message || "Erro JSON-RPC do Codex App Server.",
          message.error.code,
          message.error.data
        ));
      } else {
        pending.resolve(message.result || {});
      }
      return;
    }

    // The app-server can send requests back to its host. This small backend
    // does not implement interactive approval/elicitation UI, so it rejects
    // unsupported host requests rather than leaving Codex waiting forever.
    if (message.method && message.id !== undefined) {
      this.write({
        id: message.id,
        error: {
          code: -32601,
          message: "Este backend mínimo ainda não implementa solicitações interativas do host."
        }
      });
      return;
    }

    if (typeof message.method === "string") {
      this.emit("notification", message);
    }
  }

  write(message) {
    if (!this.child || !this.child.stdin || !this.child.stdin.writable) {
      throw new Error("A conexão com o Codex App Server não está disponível.");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  call(method, params = {}, timeoutMs = RPC_TIMEOUT_MS) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Tempo limite excedido em ${method}.`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params = {}) {
    this.write({ method, params });
  }

  fail(error) {
    this.ready = false;
    const child = this.child;
    this.child = null;
    this.readline?.close();
    this.readline = null;

    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error instanceof Error ? error : new Error(String(error)));
      this.pending.delete(id);
    }

    if (child && child.exitCode === null && !child.killed && error?.code !== "ENOENT") {
      // A process that exits naturally is already gone; this only handles a
      // still-running process after an internal transport failure.
      try { child.kill("SIGTERM"); } catch { /* ignore shutdown race */ }
    }
  }

  async stop() {
    const child = this.child;
    this.ready = false;
    this.child = null;
    this.readline?.close();
    this.readline = null;
    if (child && !child.killed) child.kill("SIGTERM");
  }
}

const runtime = new CodexAppServer();
const authLogins = new Map();
const mcpLogins = new Map();

runtime.on("notification", (message) => {
  const params = message.params || {};

  if (message.method === "account/login/completed" && params.loginId) {
    const previous = authLogins.get(params.loginId) || {};
    authLogins.set(params.loginId, {
      ...previous,
      status: params.success === true ? "completed" : "failed",
      error: params.success === true ? null : (params.error || "O login do ChatGPT não foi concluído.")
    });
  }

  if (message.method === "mcpServer/oauthLogin/completed") {
    const name = String(params.name || "");
    let loginId = params.loginId;

    // Older App Server versions may omit loginId. Match the pending login
    // for that MCP server when that happens.
    if (!loginId) {
      for (const [key, record] of mcpLogins) {
        if (record.name === name && record.status === "pending") {
          loginId = record.loginId;
          break;
        }
      }
    }

    if (loginId) {
      const key = `${name}:${loginId}`;
      const previous = mcpLogins.get(key) || { name, loginId };
      mcpLogins.set(key, {
        ...previous,
        status: params.success === true ? "completed" : "failed",
        error: params.success === true ? null : (params.error || "A autorização do servidor MCP falhou.")
      });
    }
  }
});

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(body);
}

function sendError(res, error, statusCode = 500) {
  sendJson(res, statusCode, {
    error: "backend_error",
    message: error instanceof Error ? error.message : String(error)
  });
}

async function readJson(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw Object.assign(new Error("Corpo da requisição muito grande."), { statusCode: 413 });
    chunks.push(chunk);
  }
  if (total === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("JSON inválido no corpo da requisição."), { statusCode: 400 });
  }
}

function safeDecode(value) {
  try { return decodeURIComponent(value); }
  catch { throw Object.assign(new Error("Parâmetro de URL inválido."), { statusCode: 400 }); }
}

function isLoopbackAddress(address = "") {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function validateLocalRequest(req) {
  if (!isLoopbackAddress(req.socket.remoteAddress || "")) return false;

  const allowedHosts = new Set([
    `127.0.0.1:${PORT}`,
    `localhost:${PORT}`
  ]);
  const host = String(req.headers.host || "").toLowerCase();
  if (!allowedHosts.has(host)) return false;

  const origin = req.headers.origin;
  if (origin) {
    let parsed;
    try { parsed = new URL(origin); } catch { return false; }
    if (parsed.protocol !== "http:" || !allowedHosts.has(parsed.host.toLowerCase())) return false;
  }
  return true;
}

async function getRuntime() {
  await runtime.ensureStarted();
  return runtime;
}

function mapModel(model) {
  return {
    id: model.id,
    displayName: model.displayName || model.id,
    isDefault: model.isDefault === true,
    defaultReasoningEffort: model.defaultReasoningEffort || null,
    supportedReasoningEfforts: Array.isArray(model.supportedReasoningEfforts)
      ? model.supportedReasoningEfforts.map((item) =>
          typeof item === "string" ? item : item?.reasoningEffort
        ).filter(Boolean)
      : []
  };
}

async function getStatusPayload() {
  const client = await getRuntime();
  const accountResult = await client.call("account/read", { refreshToken: false });
  const account = accountResult?.account || null;
  const accountType = account?.type || null;

  const authMode = accountType === "apiKey" ? "apikey" : accountType;
  const authenticated = ["chatgpt", "apiKey", "chatgptAuthTokens"].includes(accountType);

  let models = [];
  if (authenticated) {
    try {
      const modelResult = await client.call("model/list", { limit: 100, includeHidden: false });
      models = Array.isArray(modelResult?.data) ? modelResult.data.map(mapModel) : [];
    } catch (error) {
      console.warn(`[codex-web] model/list: ${error.message}`);
    }
  }

  return {
    ready: authenticated,
    codex: {
      available: true,
      authenticated,
      authMode,
      account: account ? {
        email: account.email || null,
        name: account.name || null,
        planType: account.planType || null
      } : null
    },
    capabilities: {
      chat: authenticated,
      interrupt: authenticated
    },
    models
  };
}

function writeSse(res, eventName, data) {
  if (res.writableEnded || res.destroyed) return;
  const safeName = String(eventName).replace(/[\r\n]/g, "");
  res.write(`event: ${safeName}\n`);
  res.write(`data: ${JSON.stringify(data ?? {})}\n\n`);
}

function belongsToThread(message, threadId, turnId) {
  const params = message.params || {};
  const messageThreadId = params.threadId || params.thread?.id || params.turn?.threadId;
  const messageTurnId = params.turnId || params.turn?.id;

  if (messageThreadId) return messageThreadId === threadId;
  if (messageTurnId && turnId) return messageTurnId === turnId;
  // Some older event versions omit IDs on generic error notifications.
  return message.method === "error" || message.method === "warning";
}

async function handleTurnStream(req, res, body) {
  const input = Array.isArray(body.input) ? body.input : [];
  const textInput = input.filter((item) => item && item.type === "text" && typeof item.text === "string");
  if (!textInput.length || !textInput.some((item) => item.text.trim())) {
    return sendJson(res, 400, { error: "invalid_input", message: "Envie ao menos uma mensagem de texto." });
  }

  const client = await getRuntime();
  const accountResult = await client.call("account/read", { refreshToken: false });
  if (!accountResult?.account) {
    return sendJson(res, 401, { error: "not_authenticated", message: "Faça login no Codex antes de enviar uma tarefa." });
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
    "X-Content-Type-Options": "nosniff"
  });
  res.write(": Codex Web stream connected\n\n");

  let threadId = typeof body.threadId === "string" && body.threadId ? body.threadId : null;
  let turnId = null;
  let turnStartedSent = false;
  let ended = false;
  let completed = false;
  const buffered = [];

  const sendNotification = (message) => {
    if (!threadId) {
      buffered.push(message);
      return;
    }
    if (!belongsToThread(message, threadId, turnId)) return;

    if (message.method === "turn/started") {
      turnId = message.params?.turn?.id || message.params?.turnId || turnId;
      if (!turnStartedSent) {
        writeSse(res, message.method, message.params || {});
        turnStartedSent = true;
      }
      return;
    }
    writeSse(res, message.method, message.params || {});
    if (message.method === "turn/completed") {
      completed = true;
      finish();
    }
  };

  const finish = () => {
    if (ended) return;
    ended = true;
    client.off("notification", sendNotification);
    if (!res.writableEnded) res.end();
  };

  const onClose = () => {
    if (!res.writableEnded) {
      ended = true;
      client.off("notification", sendNotification);
    }
  };
  res.on("close", onClose);
  client.on("notification", sendNotification);

  try {
    if (threadId) {
      await client.call("thread/resume", { threadId, excludeTurns: true });
    } else {
      const threadParams = { cwd: WORKSPACE_ROOT, approvalPolicy: "never", sandbox: "workspace-write" };
      if (typeof body.model === "string" && body.model) threadParams.model = body.model;
      const threadResult = await client.call("thread/start", threadParams);
      threadId = threadResult?.thread?.id;
      if (!threadId) throw new Error("O Codex não retornou um identificador de thread.");

      // The notification may have arrived while thread/start was awaiting its
      // response. Send one normalized event now, then flush the other buffered
      // notifications without replaying that same thread/started event.
      writeSse(res, "thread/started", { thread: threadResult.thread });

      for (const message of buffered.splice(0)) {
        if (message.method !== "thread/started") sendNotification(message);
      }
    }

    if (ended) return;

    const turnParams = {
      threadId,
      input: textInput,
      cwd: WORKSPACE_ROOT,
      approvalPolicy: "never",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [WORKSPACE_ROOT],
        networkAccess: false
      }
    };
    if (typeof body.model === "string" && body.model) turnParams.model = body.model;
    if (typeof body.effort === "string" && body.effort) turnParams.effort = body.effort;

    const turnResult = await client.call("turn/start", turnParams);
    turnId = turnResult?.turn?.id || turnId;
    if (!turnStartedSent && !completed && !ended && turnId) {
      // A notification normally arrives as part of turn/start. This fallback
      // keeps the existing frontend informed if this Codex version omits it.
      writeSse(res, "turn/started", { threadId, turn: { id: turnId, status: turnResult?.turn?.status || "inProgress" } });
      turnStartedSent = true;
    }

    // The turn can finish after turn/start's response. The notification
    // listener remains attached until turn/completed or browser disconnect.
  } catch (error) {
    if (!res.headersSent) {
      sendError(res, error, error.code === -32600 ? 400 : 500);
    } else {
      writeSse(res, "error", { message: error.message || "Falha ao iniciar o turn." });
      finish();
    }
  }
}

async function routeApi(req, res, pathname) {
  if (req.method === "GET" && pathname === "/api/health") {
    return sendJson(res, 200, { ok: true, service: "codex-web-node-backend" });
  }

  if (req.method === "GET" && pathname === "/api/codex/status") {
    try { return sendJson(res, 200, await getStatusPayload()); }
    catch (error) { return sendError(res, error, 503); }
  }

  if (req.method === "POST" && pathname === "/api/codex/auth/login") {
    try {
      const body = await readJson(req);
      if (body.type !== "chatgptDeviceCode") {
        return sendJson(res, 400, { error: "unsupported_login", message: "Este backend aceita o fluxo chatgptDeviceCode." });
      }
      const client = await getRuntime();
      const result = await client.call("account/login/start", { type: "chatgptDeviceCode" });
      if (!result?.loginId || !result?.verificationUrl || !result?.userCode) {
        throw new Error("Codex App Server não retornou os dados esperados do login por dispositivo.");
      }
      authLogins.set(result.loginId, { status: "pending", error: null });
      return sendJson(res, 200, {
        loginId: result.loginId,
        verificationUrl: result.verificationUrl,
        userCode: result.userCode
      });
    } catch (error) { return sendError(res, error, 502); }
  }

  let match = pathname.match(/^\/api\/codex\/auth\/login\/([^/]+)$/);
  if (req.method === "GET" && match) {
    const loginId = safeDecode(match[1]);
    const login = authLogins.get(loginId);
    if (!login) return sendJson(res, 404, { status: "not_found", error: "Login não encontrado neste processo do backend." });
    return sendJson(res, 200, login);
  }

  match = pathname.match(/^\/api\/codex\/auth\/login\/([^/]+)\/cancel$/);
  if (req.method === "POST" && match) {
    const loginId = safeDecode(match[1]);
    try {
      const client = await getRuntime();
      await client.call("account/login/cancel", { loginId });
      authLogins.set(loginId, { status: "cancelled", error: null });
      return sendJson(res, 200, { ok: true });
    } catch (error) { return sendError(res, error, 502); }
  }

  if (req.method === "POST" && pathname === "/api/codex/auth/logout") {
    try {
      const client = await getRuntime();
      await client.call("account/logout", {});
      return sendJson(res, 200, { ok: true });
    } catch (error) { return sendError(res, error, 502); }
  }

  if (req.method === "POST" && pathname === "/api/codex/turns") {
    try {
      const body = await readJson(req);
      return await handleTurnStream(req, res, body);
    } catch (error) { return sendError(res, error, error.statusCode || 502); }
  }

  match = pathname.match(/^\/api\/codex\/threads\/([^/]+)\/turns\/([^/]+)\/interrupt$/);
  if (req.method === "POST" && match) {
    const threadId = safeDecode(match[1]);
    const turnId = safeDecode(match[2]);
    try {
      const client = await getRuntime();
      await client.call("turn/interrupt", { threadId, turnId });
      return sendJson(res, 200, { ok: true });
    } catch (error) { return sendError(res, error, 502); }
  }

  if (req.method === "GET" && pathname === "/api/codex/mcp/servers") {
    try {
      const client = await getRuntime();
      const result = await client.call("mcpServerStatus/list", { detail: "toolsAndAuthOnly", limit: 100 });
      const servers = Array.isArray(result?.data) ? result.data : [];
      return sendJson(res, 200, {
        servers: servers.map((server) => ({ ...server, configured: true }))
      });
    } catch (error) { return sendError(res, error, 502); }
  }

  match = pathname.match(/^\/api\/codex\/mcp\/servers\/([^/]+)\/oauth$/);
  if (req.method === "POST" && match) {
    const serverName = safeDecode(match[1]);
    try {
      const body = await readJson(req);
      const client = await getRuntime();
      const params = { name: serverName };
      if (typeof body.threadId === "string" && body.threadId) params.threadId = body.threadId;
      const result = await client.call("mcpServer/oauth/login", params);
      if (!result?.loginId || !result?.authorizationUrl) {
        throw new Error("Codex App Server não retornou loginId e authorizationUrl para o OAuth.");
      }
      mcpLogins.set(`${serverName}:${result.loginId}`, {
        name: serverName,
        loginId: result.loginId,
        status: "pending",
        error: null
      });
      return sendJson(res, 200, {
        loginId: result.loginId,
        authorizationUrl: result.authorizationUrl
      });
    } catch (error) { return sendError(res, error, 502); }
  }

  match = pathname.match(/^\/api\/codex\/mcp\/servers\/([^/]+)\/oauth\/([^/]+)$/);
  if (req.method === "GET" && match) {
    const serverName = safeDecode(match[1]);
    const loginId = safeDecode(match[2]);
    const result = mcpLogins.get(`${serverName}:${loginId}`);
    if (!result) return sendJson(res, 404, { status: "not_found", error: "Login OAuth não encontrado neste processo do backend." });
    return sendJson(res, 200, result);
  }

  return sendJson(res, 404, { error: "not_found", message: "Rota da API não encontrada." });
}

function serveStatic(req, res, pathname) {
  const allowedFiles = new Set(["/", "/index.html", "/style.css", "/script.js"]);
  if (!allowedFiles.has(pathname)) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Not found");
  }

  const filePath = pathname === "/" ? path.join(ROOT_DIR, "index.html") : path.join(ROOT_DIR, pathname.slice(1));
  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end(`Não foi possível ler ${path.basename(filePath)}. Verifique se server.cjs está na raiz do projeto.`);
    }
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[path.extname(filePath)] || "application/octet-stream",
      "Content-Length": content.length,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer"
    });
    if (req.method === "HEAD") return res.end();
    res.end(content);
  });
}

const server = http.createServer(async (req, res) => {
  if (!validateLocalRequest(req)) {
    return sendJson(res, 403, { error: "forbidden", message: "Este backend aceita apenas conexões locais da própria origem." });
  }

  let url;
  try { url = new URL(req.url, `http://${req.headers.host}`); }
  catch { return sendJson(res, 400, { error: "invalid_url", message: "URL inválida." }); }

  if (url.pathname.startsWith("/api/")) {
    return routeApi(req, res, url.pathname).catch((error) => {
      if (!res.headersSent) sendError(res, error, error.statusCode || 500);
      else if (!res.writableEnded) res.end();
    });
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    return sendJson(res, 405, { error: "method_not_allowed", message: "Método HTTP não permitido." });
  }
  return serveStatic(req, res, url.pathname);
});

server.listen(PORT, HOST, () => {
  console.log("\nCodex Web — Node.js backend");
  console.log(`Frontend/API: http://${HOST}:${PORT}`);
  console.log(`Workspace do Codex: ${WORKSPACE_ROOT}`);
  console.log(`Executável: ${CODEX_BIN} app-server`);
  console.log("Apenas localhost; não exponha esta porta na internet.\n");
});

function shutdown() {
  server.close();
  runtime.stop().finally(() => process.exit(0));
  setTimeout(() => process.exit(1), 3000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
