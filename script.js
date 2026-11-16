
"use strict";

/*
 * CODEX WEB — frontend controller
 *
 * This file intentionally replaces the two concatenated controllers that
 * previously existed in script.js. It is compatible with the current
 * index.html and does not require HTML or CSS changes.
 *
 * IMPORTANT ARCHITECTURE
 * ----------------------
 * The browser never starts codex app-server, never reads its stdio, and never
 * stores ChatGPT/GitHub credentials. The Node.js backend owns the
 * Codex JSON-RPC connection, OAuth callbacks, MCP configuration and secrets.
 *
 * Node.js serves the frontend and API from the same local origin.
 * This browser client intentionally does not target a remote backend: the
 * local server rejects non-local requests.
 *
 * BACKEND HTTP CONTRACT USED BY THIS FILE
 * ---------------------------------------
 * GET  /api/codex/status
 *   {
 *     "ready": true,
 *     "codex": {
 *       "available": true,
 *       "authenticated": true,
 *       "authMode": "chatgpt",
 *       "account": { "email": "...", "planType": "..." },
 *       "version": "..."
 *     },
 *     "capabilities": { "chat": true, "interrupt": true },
 *     "models": [
 *       {
 *         "id": "...", "displayName": "...", "isDefault": true,
 *         "defaultReasoningEffort": "medium",
 *         "supportedReasoningEfforts": ["low", "medium", "high"]
 *       }
 *     ]
 *   }
 *
 * POST /api/codex/auth/login
 *   Request:  { "type": "chatgptDeviceCode" }
 *   Response: {
 *     "loginId": "...",
 *     "verificationUrl": "https://auth.openai.com/codex/device",
 *     "userCode": "ABCD-1234"
 *   }
 *   Backend RPC: account/login/start { type: "chatgptDeviceCode" }
 *
 * GET  /api/codex/auth/login/{loginId}
 *   Response: { "status": "pending|completed|failed|cancelled", "error": null }
 *   Backend translates account/login/completed notifications into this status.
 *
 * POST /api/codex/auth/login/{loginId}/cancel
 * POST /api/codex/auth/logout
 *   Backend RPCs: account/login/cancel and account/logout.
 *
 * POST /api/codex/turns
 *   Request: {
 *     "threadId": null | "thr_...",
 *     "input": [{ "type": "text", "text": "..." }],
 *     "model": "...", "effort": "..."
 *   }
 *   Response: text/event-stream. Event names are Codex App Server notification
 *   methods; event data is the notification params object (or full JSON-RPC
 *   notification). Backend creates thread/start when threadId is null, then
 *   calls turn/start, and forwards thread/started, turn/started,
 *   item/agentMessage/delta, item/completed, turn/completed and error events.
 *
 * POST /api/codex/threads/{threadId}/turns/{turnId}/interrupt
 *   Backend RPC: turn/interrupt.
 *
 * GET  /api/codex/mcp/servers
 *   Response: {
 *     "servers": [
 *       {
 *         "name": "github", "configured": true, "connected": true,
 *         "authStatus": "connected", "tools": [{"name":"..."}]
 *       }
 *     ]
 *   }
 *   Backend RPC: mcpServerStatus/list with detail "toolsAndAuthOnly".
 *
 * POST /api/codex/mcp/servers/{serverName}/oauth
 *   Request: { "threadId": null | "thr_..." }
 *   Response: { "loginId": "...", "authorizationUrl": "https://..." }
 *   Backend RPC: mcpServer/oauth/login { name, threadId? }.
 *
 * GET  /api/codex/mcp/servers/{serverName}/oauth/{loginId}
 *   Response: { "status": "pending|completed|failed|cancelled", "error": null }
 *   Backend translates mcpServer/oauthLogin/completed notifications.
 *
 * These HTTP routes are the Codex Web adapter contract, not OpenAI endpoints.
 * They are implemented by server.cjs. The JavaScript never simulates
 * successful authentication, tool access, or a Codex response.
 */

(() => {
  // The Node.js server serves both the frontend and /api on the same origin.
  // Keep the browser on localhost; server.cjs intentionally rejects remote origins.
  const GITHUB_MCP_SERVER_NAME = "github";
  const STATUS_TIMEOUT_MS = 8000;
  const LOGIN_POLL_INTERVAL_MS = 2500;
  const LOGIN_MAX_WAIT_MS = 8 * 60 * 1000;
  const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost"]);
  const IS_LOCAL_NODE_ORIGIN =
    window.location.protocol === "http:" &&
    LOCAL_HOSTS.has(window.location.hostname);
  const BACKEND_CONFIGURED = IS_LOCAL_NODE_ORIGIN;

  const API = Object.freeze({
    health: "/api/health",
    status: "/api/codex/status",
    login: "/api/codex/auth/login",
    loginStatus: (loginId) => `/api/codex/auth/login/${encodeURIComponent(loginId)}`,
    loginCancel: (loginId) => `/api/codex/auth/login/${encodeURIComponent(loginId)}/cancel`,
    logout: "/api/codex/auth/logout",
    turns: "/api/codex/turns",
    interrupt: (threadId, turnId) =>
      `/api/codex/threads/${encodeURIComponent(threadId)}/turns/${encodeURIComponent(turnId)}/interrupt`,
    mcpServers: "/api/codex/mcp/servers",
    mcpOAuth: (serverName) =>
      `/api/codex/mcp/servers/${encodeURIComponent(serverName)}/oauth`,
    mcpOAuthStatus: (serverName, loginId) =>
      `/api/codex/mcp/servers/${encodeURIComponent(serverName)}/oauth/${encodeURIComponent(loginId)}`
  });

  const state = {
    page: "new-thread",
    backendReachable: false,
    backendReady: false,
    authenticated: false,
    capabilities: { chat: false, interrupt: false },
    account: null,
    models: [],
    model: null,
    effort: null,
    threadId: null,
    turnId: null,
    threadTitle: "New conversation",
    busy: false,
    stopRequested: false,
    currentRequest: null,
    currentAssistantMessage: null,
    login: null,
    loginPollTimer: null,
    loginStartedAt: 0,
    githubServer: null,
    githubLogin: null,
    githubPollTimer: null
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  const elements = {
    sidebar: $("#sidebar"),
    workspace: $("#new-thread"),
    workspaceCenter: $(".workspace-center"),
    welcome: $(".welcome-section"),
    welcomeDescription: $(".welcome-description"),
    suggestions: $(".suggestions-section"),
    composer: $("#composer"),
    prompt: $("#prompt-input"),
    send: $("#send-button"),
    stop: $("#stop-button"),
    conversation: $("#conversation-view"),
    messages: $("#conversation-messages"),
    conversationComposer: $("#conversation-composer"),
    secondary: $("#secondary-view"),
    secondaryTitle: $("#secondary-view-title"),
    secondaryDescription: $("#secondary-view-description"),
    secondaryContent: $("#secondary-view-content"),
    breadcrumb: $(".breadcrumb-section"),
    runtime: $(".runtime-status"),
    threadList: $("#thread-list"),
    emptyThreads: $("#empty-threads"),
    accountMenu: $("#account-menu"),
    modelSelector: $("#model-selector"),
    reasoningSelector: $("#reasoning-selector")
  };

  function createElement(tag, className = "", text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = String(text);
    return element;
  }

  function showToast(message, kind = "info") {
    let region = $(".codex-toast-region");
    if (!region) {
      region = createElement("div", "codex-toast-region");
      region.setAttribute("aria-live", "polite");
      region.setAttribute("aria-atomic", "false");
      document.body.appendChild(region);
    }
    const toast = createElement(
      "div",
      `codex-toast${kind === "error" ? " error" : ""}`,
      message
    );
    toast.setAttribute("role", "status");
    region.appendChild(toast);
    window.setTimeout(() => toast.remove(), 5000);
  }

  function setRuntimeStatus(message, status = "offline") {
    let banner = elements.runtime;
    if (!banner) {
      banner = createElement("div", "runtime-status");
      banner.setAttribute("role", "status");
      banner.setAttribute("aria-live", "polite");
      const anchor = elements.welcomeDescription?.parentElement;
      if (anchor) anchor.appendChild(banner);
      elements.runtime = banner;
    }
    banner.dataset.state = status;
    banner.replaceChildren(createElement("span", "runtime-status-text", message));
  }

  function apiUrl(path) {
    return new URL(path.replace(/^\//, ""), window.location.origin).toString();
  }

  async function readResponseError(response) {
    const contentType = response.headers.get("content-type") || "";
    try {
      if (contentType.includes("application/json")) {
        const body = await response.json();
        return body.message || body.error?.message || body.title || `HTTP ${response.status}`;
      }
      const text = (await response.text()).trim();
      return text.slice(0, 600) || `HTTP ${response.status}`;
    } catch {
      return `HTTP ${response.status}`;
    }
  }

  async function apiRequest(path, options = {}) {
    if (!BACKEND_CONFIGURED) {
      throw new Error(
        "Abra o Codex Web pelo servidor Node.js em http://127.0.0.1:3210. Não use o GitHub Pages nem abra index.html diretamente."
      );
    }

    const headers = new Headers(options.headers || {});
    if (options.json !== undefined) headers.set("Content-Type", "application/json");
    if (!headers.has("Accept")) headers.set("Accept", "application/json");

    const request = { ...options, headers };
    delete request.json;
    if (options.json !== undefined) request.body = JSON.stringify(options.json);

    const response = await fetch(apiUrl(path), {
      ...request,
      credentials: "same-origin",
      cache: "no-store",
      headers
    });

    if (!response.ok) {
      throw new Error(await readResponseError(response));
    }
    return response;
  }

  async function apiJson(path, options = {}) {
    const response = await apiRequest(path, options);
    if (response.status === 204) return null;
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      throw new Error(`A API respondeu com um formato inesperado (${contentType || "sem Content-Type"}).`);
    }
    return response.json();
  }

  function setButtonAvailable(button, available, titleWhenDisabled) {
    if (!button) return;
    button.disabled = !available;
    if (available) {
      button.removeAttribute("title");
      button.classList.remove("is-coming-soon");
    } else {
      if (titleWhenDisabled) button.title = titleWhenDisabled;
      button.classList.add("is-coming-soon");
    }
  }

  function setSendAvailability() {
    const available = state.backendReady && !state.busy;
    setButtonAvailable(
      elements.send,
      available,
      state.busy ? "Codex está trabalhando" : "Inicie o servidor Node.js e conecte sua conta ChatGPT"
    );
    if (elements.send) {
      elements.send.setAttribute("aria-label", available ? "Enviar mensagem para Codex" : "Codex indisponível");
    }
    if (elements.prompt) {
      elements.prompt.placeholder = state.backendReady
        ? "Ask Codex to work on your project..."
        : "Digite uma tarefa — inicie o servidor Node.js para enviar ao Codex";
    }
    // Suggested cards remain clickable offline: they fill the prompt.
  }

  function normalizeModels(rawModels) {
    if (!Array.isArray(rawModels)) return [];
    return rawModels
      .filter((model) => model && typeof model.id === "string" && model.id.trim())
      .map((model) => ({
        id: model.id,
        label: typeof model.displayName === "string" && model.displayName.trim()
          ? model.displayName
          : model.id,
        isDefault: model.isDefault === true,
        defaultEffort: typeof model.defaultReasoningEffort === "string"
          ? model.defaultReasoningEffort
          : null,
        efforts: Array.isArray(model.supportedReasoningEfforts)
          ? model.supportedReasoningEfforts
              .map((item) => typeof item === "string" ? item : item?.reasoningEffort)
              .filter((item) => typeof item === "string" && item.length > 0)
          : []
      }));
  }

  function currentModel() {
    return state.models.find((model) => model.id === state.model) || null;
  }

  function updateSelectorLabel(button, label) {
    const span = button ? $("span", button) : null;
    if (span) span.textContent = label;
  }

  function closePopover() {
    const popover = $(".codex-popover");
    popover?.remove();
  }

  function openPopover(anchor, title, options) {
    closePopover();
    if (!anchor || !Array.isArray(options) || options.length === 0) return;

    const menu = createElement("div", "codex-popover");
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", title);
        menu.appendChild(createElement("div", "codex-popover-label", title));

    for (const option of options) {
      const button = createElement("button", "", option.label);
      button.type = "button";
      button.disabled = Boolean(option.disabled);
      button.setAttribute("role", "menuitem");
      button.addEventListener("click", () => {
        closePopover();
        option.onChoose?.();
      });
      menu.appendChild(button);
    }

    document.body.appendChild(menu);
    const rect = anchor.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - menuRect.width - 8));
    const top = rect.bottom + menuRect.height + 8 > window.innerHeight
      ? Math.max(8, rect.top - menuRect.height - 6)
      : rect.bottom + 6;
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }

  function configureModelSelectors(rawModels) {
    state.models = normalizeModels(rawModels);
    if (!state.models.length) {
      setButtonAvailable(elements.modelSelector, false, "O Codex App Server não forneceu modelos.");
      setButtonAvailable(elements.reasoningSelector, false, "O Codex App Server não forneceu níveis de raciocínio.");
      return;
    }

    const fallback = state.models.find((item) => item.isDefault) || state.models[0];
    if (!state.model || !state.models.some((item) => item.id === state.model)) {
      state.model = fallback.id;
    }
    const model = currentModel();
    if (!model.efforts.includes(state.effort)) {
      state.effort = model.efforts.includes(model.defaultEffort)
        ? model.defaultEffort
        : (model.efforts[0] || null);
    }

    updateSelectorLabel(elements.modelSelector, model.label);
    updateSelectorLabel(elements.reasoningSelector, state.effort || "Default");
    setButtonAvailable(elements.modelSelector, true);
    setButtonAvailable(elements.reasoningSelector, model.efforts.length > 0,
      "Este modelo não oferece opções de raciocínio.");
  }

  function openModelMenu() {
    if (!state.backendReady || !state.models.length) return;
    openPopover(elements.modelSelector, "Model", state.models.map((model) => ({
      label: model.label,
      onChoose: () => {
        state.model = model.id;
        state.effort = null;
        configureModelSelectors(state.models.map((item) => ({
          id: item.id,
          displayName: item.label,
          isDefault: item.isDefault,
          defaultReasoningEffort: item.defaultEffort,
          supportedReasoningEfforts: item.efforts
        })));
      }
    })));
  }

  function openReasoningMenu() {
    const model = currentModel();
    if (!state.backendReady || !model?.efforts.length) return;
    openPopover(elements.reasoningSelector, "Reasoning effort", model.efforts.map((effort) => ({
      label: effort,
      onChoose: () => {
        state.effort = effort;
        updateSelectorLabel(elements.reasoningSelector, effort);
      }
    })));
  }

  function updateAccount(payload) {
    const codex = payload?.codex || {};
    state.account = codex.account || null;
    state.authenticated = codex.authenticated === true ||
      ["chatgpt", "apikey", "chatgptAuthTokens"].includes(codex.authMode);

    if (!elements.accountMenu) return;
    const name = $(".account-info strong", elements.accountMenu);
    const detail = $(".account-info small", elements.accountMenu);
    if (name) {
      name.textContent = state.authenticated
        ? (state.account?.email || state.account?.name || "Connected")
        : "Sign in to Codex";
    }
    if (detail) {
      detail.textContent = state.authenticated
        ? (state.account?.planType || "Codex account")
        : "Not connected";
    }
    document.body.dataset.authenticated = String(state.authenticated);
  }

  function isCodexReady(payload) {
    return Boolean(
      payload?.ready === true &&
      payload?.codex?.available === true &&
      (payload?.codex?.authenticated === true ||
        ["chatgpt", "apikey", "chatgptAuthTokens"].includes(payload?.codex?.authMode)) &&
      payload?.capabilities?.chat === true
    );
  }

  async function refreshBackendStatus({ silent = false } = {}) {
    if (!BACKEND_CONFIGURED) {
      state.backendReachable = false;
      state.backendReady = false;
      state.capabilities = { chat: false, interrupt: false };
      setRuntimeStatus(
        "Node.js não detectado nesta origem. Execute `node server.cjs` e abra http://127.0.0.1:3210. O GitHub Pages hospeda apenas a interface estática.",
        "offline"
      );
      updateAccount({ codex: { authenticated: false, account: null } });
      configureModelSelectors([]);
      setSendAvailability();
      return null;
    }

    setRuntimeStatus("Verificando o servidor Node.js do Codex Web...", "checking");
    setSendAvailability();
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), STATUS_TIMEOUT_MS);

    try {
      // First confirm that this exact Node.js service is serving the page.
      const health = await apiJson(API.health, { signal: controller.signal });
      if (health?.ok !== true || health?.service !== "codex-web-node-backend") {
        throw new Error("A origem respondeu, mas não é o servidor Node.js esperado do Codex Web.");
      }

      state.backendReachable = true;

      // The HTTP server can be healthy even when Codex CLI/App Server is not
      // installed, not logged in, or failed to initialize. Keep those states
      // separate so the UI does not incorrectly report Node.js as offline.
      let payload;
      try {
        payload = await apiJson(API.status, { signal: controller.signal });
      } catch (error) {
        state.backendReady = false;
        state.capabilities = { chat: false, interrupt: false };
        updateAccount({ codex: { authenticated: false, account: null } });
        configureModelSelectors([]);
        const message = error.name === "AbortError"
          ? "O Node.js está ativo, mas a consulta ao Codex App Server expirou."
          : `Node.js está ativo, mas não conseguiu consultar o Codex App Server: ${error.message}`;
        setRuntimeStatus(message, "warning");
        setSendAvailability();
        if (!silent) showToast(message, "error");
        return null;
      }

      if (!payload || typeof payload !== "object") {
        throw new Error("O Node.js retornou um status do Codex inválido.");
      }

      state.backendReady = isCodexReady(payload);
      state.capabilities = {
        chat: payload.capabilities?.chat === true,
        interrupt: payload.capabilities?.interrupt === true
      };
      updateAccount(payload);

      if (state.backendReady) {
        configureModelSelectors(payload.models);
        setRuntimeStatus("Node.js conectado · Codex pronto para receber tarefas.", "ready");
      } else {
        configureModelSelectors([]);
        const codex = payload.codex || {};
        if (codex.available === true && !state.authenticated) {
          setRuntimeStatus("Node.js ativo. Faça login na sua conta ChatGPT para habilitar o Codex.", "warning");
        } else if (payload.ready === true && payload.capabilities?.chat !== true) {
          setRuntimeStatus("Node.js ativo, mas o Codex App Server não disponibilizou a capacidade de chat.", "warning");
        } else {
          setRuntimeStatus("Node.js ativo; aguardando o Codex App Server ficar pronto.", "warning");
        }
      }

      setSendAvailability();
      return payload;
    } catch (error) {
      state.backendReachable = false;
      state.backendReady = false;
      state.capabilities = { chat: false, interrupt: false };
      const message = error.name === "AbortError"
        ? "A verificação do servidor Node.js expirou."
        : `Servidor Node.js indisponível: ${error.message}`;
      setRuntimeStatus(message, "offline");
      updateAccount({ codex: { authenticated: false, account: null } });
      configureModelSelectors([]);
      setSendAvailability();
      if (!silent) showToast(message, "error");
      return null;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function resizePrompt() {
    if (!elements.prompt) return;
    elements.prompt.style.height = "auto";
    elements.prompt.style.height = `${Math.min(elements.prompt.scrollHeight, 220)}px`;
  }

  function updateNavigation(page) {
    $$('[data-page]').forEach((item) => {
      const active = item.dataset.page === page;
      item.classList.toggle("active", active);
      if (active) item.setAttribute("aria-current", "page");
      else item.removeAttribute("aria-current");
    });
  }

  const pageInfo = {
    tasks: ["Tasks", "Task management is optional and will be connected later."],
    history: ["History", "Conversation history will be added after the core chat works."],
    projects: ["Projects", "Project management is optional in this stage."],
    files: ["Files", "File browsing will be added after the core chat works."],
    terminal: ["Terminal", "Terminal sessions are optional in this stage."],
    git: ["Git", "Git controls will be added after the GitHub MCP connection works."],
    agents: ["Agents", "Agent management is optional in this stage."],
    automations: ["Automations", "Automations are optional in this stage."],
    skills: ["Skills", "Skills management is optional in this stage."],
    plugins: ["Plugins", "Connect the GitHub MCP server used by Codex."],
    settings: ["Settings", "Workspace settings are optional in this stage."]
  };

  function renderUnavailablePage(page) {
    const info = pageInfo[page];
    if (!info || !elements.secondaryContent) return;
    const panel = createElement("div", "view-empty");
    panel.append(
      createElement("div", "view-empty-icon", "◈"),
      createElement("strong", "", info[0]),
      createElement("p", "", info[1])
    );
    elements.secondaryContent.replaceChildren(panel);
  }

  function navigate(page) {
    if (page === "new-thread") {
      showNewThread();
      return;
    }
    if (!pageInfo[page]) return;
    if (state.busy) {
      showToast("Interrompa ou aguarde a tarefa atual antes de trocar de seção.");
      return;
    }

    closePopover();
    state.page = page;
    if (elements.workspace) elements.workspace.hidden = true;
    if (elements.conversation) elements.conversation.hidden = true;
    if (elements.secondary) elements.secondary.hidden = false;
    if (elements.secondaryTitle) elements.secondaryTitle.textContent = pageInfo[page][0];
    if (elements.secondaryDescription) elements.secondaryDescription.textContent = pageInfo[page][1];
    if (elements.breadcrumb) elements.breadcrumb.textContent = pageInfo[page][0];
    updateNavigation(page);

    if (page === "plugins") {
      renderGitHubPluginPage();
    } else {
      renderUnavailablePage(page);
    }
    elements.sidebar?.classList.remove("open");
  }

  function restoreComposerToWorkspace() {
    if (!elements.composer || !elements.workspaceCenter) return;
    if (elements.composer.parentElement === elements.workspaceCenter) return;
    const disclaimer = $(".workspace-disclaimer");
    if (disclaimer) elements.workspaceCenter.insertBefore(elements.composer, disclaimer);
    else elements.workspaceCenter.appendChild(elements.composer);
  }

  function showNewThread() {
    if (state.busy) {
      showToast("A tarefa atual ainda está em execução.");
      return;
    }
    closePopover();
    state.page = "new-thread";
    state.threadId = null;
    state.turnId = null;
    state.currentAssistantMessage = null;
    restoreComposerToWorkspace();
    if (elements.workspace) elements.workspace.hidden = false;
    if (elements.conversation) elements.conversation.hidden = true;
    if (elements.secondary) elements.secondary.hidden = true;
    if (elements.welcome) elements.welcome.hidden = false;
    if (elements.suggestions) elements.suggestions.hidden = false;
    elements.messages?.replaceChildren();
    if (elements.prompt) {
      elements.prompt.value = "";
      resizePrompt();
      elements.prompt.focus();
    }
    if (elements.breadcrumb) elements.breadcrumb.textContent = "New thread";
    updateNavigation("new-thread");
    elements.sidebar?.classList.remove("open");
    updateThreadList(null);
  }

  function startConversation() {
    if (elements.workspace) elements.workspace.hidden = true;
    if (elements.conversation) elements.conversation.hidden = false;
    if (elements.secondary) elements.secondary.hidden = true;
    if (elements.welcome) elements.welcome.hidden = true;
    if (elements.suggestions) elements.suggestions.hidden = true;
    if (elements.composer && elements.conversationComposer &&
        elements.composer.parentElement !== elements.conversationComposer) {
      elements.conversationComposer.appendChild(elements.composer);
    }
    if (elements.breadcrumb) elements.breadcrumb.textContent = state.threadTitle;
    updateNavigation("new-thread");
  }

  function updateThreadList(title) {
    if (!elements.threadList) return;
    if (!title) {
      elements.threadList.replaceChildren();
      if (elements.emptyThreads) elements.emptyThreads.hidden = false;
      return;
    }
    const row = createElement("div", "thread-item selected");
    row.setAttribute("aria-current", "page");
    row.append(
      createElement("span", "thread-status"),
      createElement("span", "thread-name", title)
    );
    elements.threadList.replaceChildren(row);
    if (elements.emptyThreads) elements.emptyThreads.hidden = true;
  }

  function createMessage(role, text = "") {
    if (!elements.messages) return null;
    const article = createElement("article", `message message-${role}`);
    article.dataset.role = role;
    const content = createElement("div", "message-content");
        const textNode = createElement("div", "message-text", text);
    content.appendChild(textNode);
    article.appendChild(content);
    elements.messages.appendChild(article);
    article.scrollIntoView({ behavior: "smooth", block: "end" });
    return { article, content, textNode };
  }

  function setMessageStatus(message, text, isError = false) {
    if (!message?.content) return;
    let status = $(".message-status", message.content);
    if (!status) {
      status = createElement("div", "message-status");
      message.content.prepend(status);
    }
    status.textContent = text;
    status.classList.toggle("error", isError);
  }

  function clearMessageStatus(message) {
    $(".message-status", message?.content || document.createElement("div"))?.remove();
  }

  function appendDiff(message, diff) {
    if (!message?.content || typeof diff !== "string" || !diff.trim()) return;
    const details = createElement("details", "message-diff");
    details.appendChild(createElement("summary", "", "File changes (diff)"));
    const pre = createElement("pre", "", diff);
    details.appendChild(pre);
    message.content.appendChild(details);
  }

  function normalizeEventParams(eventData) {
    if (!eventData || typeof eventData !== "object") return {};
    if (eventData.params && typeof eventData.params === "object") return eventData.params;
    return eventData;
  }

  function applyCodexEvent(event, outcome) {
    const params = normalizeEventParams(event.data);
    const message = state.currentAssistantMessage;

    switch (event.name) {
      case "thread/started": {
        const id = params.thread?.id || params.threadId;
        if (typeof id === "string" && id) {
          state.threadId = id;
          updateThreadList(state.threadTitle);
        }
        break;
      }
      case "turn/started": {
        const id = params.turn?.id || params.turnId;
        if (typeof id === "string" && id) state.turnId = id;
        setMessageStatus(message, "Codex is working...");
        updateStopButton();
        break;
      }
      case "turn/plan/updated":
        setMessageStatus(message, "Codex is planning the task...");
        break;
      case "item/started": {
        const type = params.item?.type;
        if (type === "commandExecution") setMessageStatus(message, "Codex is running a command...");
        else if (type === "fileChange") setMessageStatus(message, "Codex is changing project files...");
        else if (type === "mcpToolCall") setMessageStatus(message, "Codex is using a connected tool...");
        break;
      }
      case "item/agentMessage/delta": {
        const delta = params.delta;
        if (typeof delta === "string" && delta) {
          if (message?.textNode) {
            clearMessageStatus(message);
            message.textNode.textContent += delta;
            message.article.scrollIntoView({ behavior: "auto", block: "end" });
          }
        }
        break;
      }
      case "item/completed": {
        const item = params.item || {};
        if (item.type === "agentMessage" && typeof item.text === "string" && message?.textNode && !message.textNode.textContent) {
          message.textNode.textContent = item.text;
        }
        break;
      }
      case "turn/diff/updated":
        appendDiff(message, params.diff);
        break;
      case "turn/completed": {
        const turn = params.turn || params;
        const status = turn.status;
        outcome.turnCompleted = true;
        outcome.turnStatus = status;
        if (status === "failed") {
          outcome.failure = turn.error?.message || turn.error?.additionalDetails || "Codex informou que a tarefa falhou.";
          setMessageStatus(message, outcome.failure, true);
        } else if (status === "interrupted") {
          setMessageStatus(message, "Turn interrupted.");
        } else if (status === "completed") {
          if (message?.textNode?.textContent) clearMessageStatus(message);
          else setMessageStatus(message, "Codex concluiu a execução sem uma mensagem de texto.");
        } else {
          outcome.failure = `Estado final de turn desconhecido: ${String(status)}`;
          setMessageStatus(message, outcome.failure, true);
        }
        break;
      }
      case "error": {
        const error = params.message || params.error?.message || "O servidor Node.js informou um erro do Codex.";
        outcome.failure = error;
        setMessageStatus(message, error, true);
        break;
      }
      case "warning":
      case "configWarning": {
        const warning = params.message || params.summary;
        if (warning) setMessageStatus(message, warning);
        break;
      }
      default:
        break;
    }
  }

  function parseSseBlock(block) {
    const lines = block.split(/\r?\n/);
    let name = "message";
    const data = [];
    for (const line of lines) {
      if (!line || line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") name = value || "message";
      else if (field === "data") data.push(value);
    }
    if (!data.length) return null;
    const raw = data.join("\n");
    if (raw === "[DONE]") return { name: "turn/completed", data: { status: "completed" } };
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Evento SSE '${name}' contém JSON inválido.`);
    }
    if (parsed?.method && parsed?.params && name === "message") {
      return { name: parsed.method, data: parsed.params };
    }
    return { name, data: parsed };
  }

  async function consumeEventStream(response) {
    if (!response.body) throw new Error("O servidor Node.js retornou um stream vazio.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const outcome = { turnCompleted: false, turnStatus: null, failure: null };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split(/\r?\n\r?\n/);
        buffer = blocks.pop() || "";
        for (const block of blocks) {
          const event = parseSseBlock(block);
          if (!event) continue;
          applyCodexEvent(event, outcome);
          if (outcome.turnCompleted) break;
        }
        if (outcome.turnCompleted) {
          await reader.cancel();
          break;
        }
      }
      buffer += decoder.decode();
      if (!outcome.turnCompleted && buffer.trim()) {
        const event = parseSseBlock(buffer);
        if (event) applyCodexEvent(event, outcome);
      }
    } finally {
      reader.releaseLock();
    }

    if (!outcome.turnCompleted) {
      throw new Error(outcome.failure || "O stream terminou antes do evento turn/completed; o estado final é desconhecido.");
    }
    if (outcome.failure) throw new Error(outcome.failure);
    return outcome;
  }

  function updateStopButton() {
    if (!elements.stop) return;
    elements.stop.hidden = !state.busy;
    elements.stop.disabled = !state.busy || state.stopRequested || !state.capabilities.interrupt || !state.threadId || !state.turnId;
  }

  function setBusy(busy) {
    state.busy = busy;
    if (elements.prompt) elements.prompt.disabled = busy;
    if (elements.composer) elements.composer.setAttribute("aria-busy", String(busy));
    setSendAvailability();
    updateStopButton();
  }

  async function submitChat(event) {
    event.preventDefault();
    if (state.busy) return;
    if (!state.backendReady) {
      showToast("O Codex não está conectado. Inicie o servidor Node.js e autentique sua conta antes de enviar.", "error");
      return;
    }

    const text = elements.prompt?.value.trim() || "";
    if (!text) {
      elements.prompt?.focus();
      return;
    }

    state.threadTitle = text.replace(/\s+/g, " ").slice(0, 52) || "New conversation";
    state.turnId = null;
    state.currentAssistantMessage = null;
    const userMessage = createMessage("user", text);
    if (!userMessage) {
      showToast("A área de conversa não está disponível.", "error");
      return;
    }
    state.currentAssistantMessage = createMessage("assistant");
    setMessageStatus(state.currentAssistantMessage, "Connecting to Codex App Server...");
    startConversation();

    if (elements.prompt) {
      elements.prompt.value = "";
      resizePrompt();
    }

    const payload = {
      threadId: state.threadId,
      input: [{ type: "text", text }]
    };
    if (state.model) payload.model = state.model;
    if (state.effort) payload.effort = state.effort;

    const controller = new AbortController();
    state.currentRequest = controller;
    setBusy(true);

    try {
      const response = await apiRequest(API.turns, {
        method: "POST",
        headers: { Accept: "text/event-stream" },
        json: payload,
        signal: controller.signal
      });
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.toLowerCase().includes("text/event-stream")) {
        throw new Error(`Esperado text/event-stream, recebido ${contentType || "sem Content-Type"}.`);
      }
      await consumeEventStream(response);
    } catch (error) {
      const message = error.name === "AbortError"
        ? "A conexão do navegador foi interrompida. O turn pode ainda estar em execução no backend."
        : (error.message || "Ocorreu um erro inesperado.");
      setMessageStatus(state.currentAssistantMessage, message, true);
      showToast(message, "error");
    } finally {
      state.currentRequest = null;
      state.turnId = null;
      state.stopRequested = false;
      setBusy(false);
      elements.prompt?.focus();
    }
  }

  async function stopCurrentTurn() {
    if (!state.busy || state.stopRequested) return;
    if (!state.capabilities.interrupt || !state.threadId || !state.turnId) {
      showToast("O Codex ainda não forneceu os identificadores necessários para interromper.", "error");
      return;
    }

    state.stopRequested = true;
    updateStopButton();
    setMessageStatus(state.currentAssistantMessage, "Sending interruption request to Codex...");
    try {
      await apiRequest(API.interrupt(state.threadId, state.turnId), { method: "POST" });
      setMessageStatus(state.currentAssistantMessage, "Interruption requested; waiting for Codex...");
    } catch (error) {
      state.stopRequested = false;
      updateStopButton();
      setMessageStatus(state.currentAssistantMessage, `Não foi possível interromper: ${error.message}`, true);
      showToast(error.message, "error");
    }
  }

  function makeDialog(title, description) {
    const overlay = createElement("div", "codex-dialog-overlay");
    Object.assign(overlay.style, {
      position: "fixed", inset: "0", zIndex: "1200", display: "grid",
      placeItems: "center", padding: "20px", background: "rgba(0,0,0,.68)"
    });
    const dialog = createElement("section", "codex-dialog");
    Object.assign(dialog.style, {
      width: "min(440px, 100%)", padding: "22px", color: "#f3f3f3",
      background: "#202020", border: "1px solid #444", borderRadius: "14px",
      boxShadow: "0 20px 70px rgba(0,0,0,.45)"
    });
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    const heading = createElement("h2", "", title);
    Object.assign(heading.style, { margin: "0 0 8px", fontSize: "18px" });
    const body = createElement("p", "", description);
    Object.assign(body.style, { margin: "0 0 16px", color: "#b8b8b8", fontSize: "13px", lineHeight: "1.6" });
    dialog.append(heading, body);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    return { overlay, dialog, body };
  }

  function makeDialogButton(label, onClick, primary = false) {
    const button = createElement("button", "", label);
    button.type = "button";
    Object.assign(button.style, {
      minHeight: "36px", padding: "8px 12px", borderRadius: "8px",
      border: primary ? "1px solid #777" : "1px solid #454545",
      background: primary ? "#eee" : "#292929",
      color: primary ? "#111" : "#eee", cursor: "pointer", fontSize: "12px"
    });
    button.addEventListener("click", onClick);
    return button;
  }

  function stopLoginPolling() {
    if (state.loginPollTimer) window.clearTimeout(state.loginPollTimer);
    state.loginPollTimer = null;
  }

  async function cancelCodexLogin(loginId) {
    if (!loginId) return;
    try {
      await apiRequest(API.loginCancel(loginId), { method: "POST" });
    } catch (error) {
      // The login may already have completed or expired. The status refresh
      // below remains the source of truth; don't hide the original result.
      console.warn("Could not cancel Codex login:", error.message);
    }
          }
    async function pollCodexLogin(dialogState, loginId) {
    if (!state.login || state.login.loginId !== loginId) return;
    if (Date.now() - state.loginStartedAt > LOGIN_MAX_WAIT_MS) {
      dialogState.status.textContent = "O tempo de espera expirou. Feche esta janela e tente novamente.";
      state.login = null;
      stopLoginPolling();
      return;
    }

    try {
      const result = await apiJson(API.loginStatus(loginId));
      const status = String(result?.status || "pending").toLowerCase();
      if (status === "completed" || result?.authenticated === true) {
        state.login = null;
        stopLoginPolling();
        dialogState.status.textContent = "Login concluído. Atualizando a conexão...";
        await refreshBackendStatus({ silent: true });
        dialogState.closeButton.textContent = "Concluir";
        dialogState.closeButton.disabled = false;
        if (state.authenticated) {
          dialogState.status.textContent = "Conta ChatGPT conectada. O Codex está pronto quando o backend confirmar a capacidade de chat.";
        } else {
          dialogState.status.textContent = "O login foi concluído, mas o backend ainda não confirmou a conta. Atualize o status do backend.";
        }
        return;
      }
      if (status === "failed" || status === "cancelled" || status === "expired") {
        state.login = null;
        stopLoginPolling();
        dialogState.status.textContent = result.error || `Login ${status}.`;
        dialogState.closeButton.disabled = false;
        return;
      }
      dialogState.status.textContent = "Aguardando confirmação do login...";
    } catch (error) {
      dialogState.status.textContent = `Não foi possível verificar o login: ${error.message}`;
    }

    state.loginPollTimer = window.setTimeout(
      () => pollCodexLogin(dialogState, loginId),
      LOGIN_POLL_INTERVAL_MS
    );
  }

  async function beginCodexLogin() {
    if (state.login) {
      showToast("Já existe um login do ChatGPT em andamento.");
      return;
    }

    try {
      const result = await apiJson(API.login, {
        method: "POST",
        json: { type: "chatgptDeviceCode" }
      });
      if (!result?.loginId || !result?.verificationUrl || !result?.userCode) {
        throw new Error("A API não retornou loginId, verificationUrl e userCode.");
      }
      const verificationUrl = new URL(result.verificationUrl);
      if (verificationUrl.protocol !== "https:") {
        throw new Error("A URL de verificação não é HTTPS; login cancelado por segurança.");
      }

      state.login = { loginId: result.loginId };
      state.loginStartedAt = Date.now();
      const modal = makeDialog(
        "Sign in with ChatGPT",
        "Abra a página oficial de verificação e informe o código abaixo. Mantenha esta janela aberta até o Codex confirmar o login."
      );
      const code = createElement("div", "", result.userCode);
      Object.assign(code.style, {
        padding: "14px", margin: "0 0 12px", borderRadius: "10px",
        background: "#111", color: "#fff", textAlign: "center",
        fontSize: "24px", fontWeight: "700", letterSpacing: "2px"
      });
      const status = createElement("p", "", "Aguardando confirmação do login...");
      Object.assign(status.style, { color: "#aaa", fontSize: "12px", minHeight: "18px" });
      const actions = createElement("div", "");
      Object.assign(actions.style, { display: "flex", gap: "8px", flexWrap: "wrap", marginTop: "16px" });
      const openLink = createElement("a", "", "Open verification page");
      openLink.href = verificationUrl.toString();
      openLink.target = "_blank";
      openLink.rel = "noopener noreferrer";
      Object.assign(openLink.style, {
        display: "inline-flex", alignItems: "center", padding: "9px 12px",
        borderRadius: "8px", background: "#eee", color: "#111",
        textDecoration: "none", fontSize: "12px", fontWeight: "600"
      });
      const copyButton = makeDialogButton("Copy code", async () => {
        try {
          await navigator.clipboard.writeText(result.userCode);
          showToast("Código copiado.");
        } catch {
          status.textContent = "Não foi possível copiar automaticamente. Selecione e copie o código exibido.";
        }
      });
      const closeButton = makeDialogButton("Cancel", async () => {
        stopLoginPolling();
        if (state.login?.loginId === result.loginId) {
          state.login = null;
          await cancelCodexLogin(result.loginId);
        }
        modal.overlay.remove();
      });
      modal.dialog.append(code, status, actions);
      actions.append(openLink, copyButton, closeButton);
      Object.assign(modal, { status, closeButton });
      state.loginPollTimer = window.setTimeout(
        () => pollCodexLogin(modal, result.loginId),
        LOGIN_POLL_INTERVAL_MS
      );
    } catch (error) {
      showToast(`Não foi possível iniciar o login do ChatGPT: ${error.message}`, "error");
    }
  }

  async function logoutCodex() {
    try {
      await apiRequest(API.logout, { method: "POST" });
      state.threadId = null;
      state.authenticated = false;
      state.backendReady = false;
      await refreshBackendStatus({ silent: true });
      showToast("Conta Codex desconectada.");
    } catch (error) {
      showToast(`Falha ao sair: ${error.message}`, "error");
    }
  }

  function openAccountMenu() {
    const options = [];
    if (state.authenticated) {
      options.push({ label: "Refresh connection", onChoose: () => refreshBackendStatus({ silent: false }) });
      options.push({ label: "Sign out", onChoose: logoutCodex });
    } else {
      options.push({ label: "Sign in with ChatGPT", onChoose: beginCodexLogin });
      options.push({ label: "Check Node.js server", onChoose: () => refreshBackendStatus({ silent: false }) });
    }
    openPopover(elements.accountMenu, "Codex account", options);
  }

  function findGitHubServer(servers) {
    if (!Array.isArray(servers)) return null;
    const expected = GITHUB_MCP_SERVER_NAME.toLowerCase();
    return servers.find((server) => String(server?.name || "").toLowerCase() === expected) ||
      servers.find((server) => String(server?.name || "").toLowerCase().includes("github")) || null;
  }

  function githubServerConnected(server) {
    return server?.connected === true || server?.authStatus === "connected" ||
      server?.auth?.status === "connected" || server?.auth?.authenticated === true;
  }

  function renderGitHubPluginPage() {
    if (!elements.secondaryContent) return;
    const panel = createElement("div", "view-empty");
    const icon = createElement("div", "view-empty-icon", "GH");
    const title = createElement("strong", "", "GitHub MCP");
    const description = createElement("p", "", "Conecte o servidor MCP oficial do GitHub ao Codex. Depois da autenticação, o próprio Codex poderá usar as ferramentas disponibilizadas pelo servidor nas conversas.");
    const status = createElement("p", "", "Verificando servidor GitHub...");
    const actions = createElement("div", "");
    Object.assign(actions.style, { display: "flex", gap: "8px", flexWrap: "wrap", justifyContent: "center", marginTop: "8px" });
    const refreshButton = createElement("button", "suggestion-card", "Refresh GitHub status");
    refreshButton.type = "button";
    refreshButton.addEventListener("click", loadGitHubStatus);
    actions.appendChild(refreshButton);
    panel.append(icon, title, description, status, actions);
    elements.secondaryContent.replaceChildren(panel);
    loadGitHubStatus({ panel, status, actions });
  }

  async function loadGitHubStatus(target = {}) {
    const status = target.status || $(".view-empty p", elements.secondaryContent)?.nextElementSibling;
    const actions = target.actions || status?.nextElementSibling;
    if (!state.backendReachable) {
      if (status) status.textContent = "Inicie o servidor Node.js para consultar servidores MCP.";
      return null;
    }
    if (status) status.textContent = "Consultando servidores MCP...";

    try {
      const payload = await apiJson(API.mcpServers);
      const servers = Array.isArray(payload?.servers)
        ? payload.servers
        : (Array.isArray(payload?.data) ? payload.data : []);
      state.githubServer = findGitHubServer(servers);
      if (!state.githubServer) {
        if (status) status.textContent = "O servidor MCP do GitHub não está configurado no ambiente local do Codex App Server.";
        return null;
      }

      const server = state.githubServer;
      const connected = githubServerConnected(server);
      const toolCount = Array.isArray(server.tools) ? server.tools.length : 0;
      if (status) {
        status.textContent = connected
          ? `GitHub conectado${toolCount ? ` · ${toolCount} ferramentas disponíveis` : ""}. O Codex poderá utilizar o servidor nas próximas tarefas.`
          : `Servidor '${server.name}' encontrado, mas a autenticação não está concluída.`;
      }
      if (actions) {
        const oldConnect = $("[data-github-connect]", actions);
        oldConnect?.remove();
        const connect = createElement("button", "suggestion-card", connected ? "Reconnect GitHub" : "Connect GitHub");
        connect.type = "button";
        connect.dataset.githubConnect = "true";
        connect.addEventListener("click", () => beginGitHubOAuth(server.name));
        if (server.configured === false) {
          connect.disabled = true;
          connect.title = "Configure este servidor MCP no Codex primeiro.";
        }
        actions.appendChild(connect);
      }
      return server;
    } catch (error) {
      if (status) status.textContent = `Não foi possível consultar o GitHub MCP: ${error.message}`;
      return null;
    }
  }

  async function beginGitHubOAuth(serverName) {
    if (!serverName) return;
    // Pre-open a tab during the click gesture so popup blockers don't discard
    // the OAuth URL when the backend returns it asynchronously.
    const authWindow = window.open("about:blank", "_blank");
    try {
      const result = await apiJson(API.mcpOAuth(serverName), {
        method: "POST",
        json: { threadId: state.threadId }
      });
      const authUrlText = result?.authorizationUrl || result?.authorization_url;
      if (!result?.loginId || !authUrlText) {
        throw new Error("A API não retornou loginId e authorizationUrl.");
      }
      const authUrl = new URL(authUrlText);
      if (authUrl.protocol !== "https:") {
        throw new Error("A URL OAuth do GitHub não é HTTPS.");
      }
      if (authWindow && !authWindow.closed) {
        authWindow.location.href = authUrl.toString();
      } else {
        const modal = makeDialog(
          "Authorize GitHub",
          "O navegador bloqueou a nova aba. Use o link abaixo para concluir a autorização do GitHub."
        );
        const link = createElement("a", "", "Continue to GitHub authorization");
        link.href = authUrl.toString();
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        Object.assign(link.style, {
          display: "inline-flex", padding: "10px 12px", borderRadius: "8px",
          background: "#eee", color: "#111", textDecoration: "none", fontSize: "12px"
        });
        const close = makeDialogButton("Close", () => modal.overlay.remove());
        modal.dialog.append(link, close);
      }

      state.githubLogin = { loginId: result.loginId, serverName };
      showToast("Conclua a autorização do GitHub na nova aba.");
      pollGitHubOAuth(serverName, result.loginId);
    } catch (error) {
      authWindow?.close();
      showToast(`Não foi possível iniciar o OAuth do GitHub: ${error.message}`, "error");
    }
  }

  async function pollGitHubOAuth(serverName, loginId) {
    if (!state.githubLogin || state.githubLogin.loginId !== loginId) return;
    try {
      const result = await apiJson(API.mcpOAuthStatus(serverName, loginId));
      const status = String(result?.status || "pending").toLowerCase();
      if (status === "completed" || result?.connected === true) {
        state.githubLogin = null;
        showToast("GitHub autorizado. Atualizando o estado do servidor...");
        if (state.page === "plugins") await loadGitHubStatus();
        // Start a fresh thread so its MCP connection picks up the newly saved grant.
        if (!state.busy) showNewThread();
        return;
      }
      if (["failed", "cancelled", "expired"].includes(status)) {
        state.githubLogin = null;
        showToast(result.error || `OAuth do GitHub ${status}.`, "error");
        if (state.page === "plugins") await loadGitHubStatus();
        return;
      }
    } catch (error) {
      showToast(`Não foi possível confirmar o OAuth do GitHub: ${error.message}`, "error");
      state.githubLogin = null;
      return;
    }
    state.githubPollTimer = window.setTimeout(
      () => pollGitHubOAuth(serverName, loginId),
      LOGIN_POLL_INTERVAL_MS
    );
  }

  function attachEventHandlers() {
    elements.composer?.addEventListener("submit", submitChat);
    elements.prompt?.addEventListener("input", resizePrompt);
    elements.prompt?.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        elements.composer?.requestSubmit();
      }
    });
    elements.send?.addEventListener("click", () => {
      // The form submit handler is authoritative. This listener also gives
      // disabled-state feedback on browsers that don't submit disabled forms.
      if (!state.backendReady) showToast("Inicie o servidor Node.js antes de enviar.");
    });
    elements.stop?.addEventListener("click", stopCurrentTurn);
    elements.accountMenu?.addEventListener("click", openAccountMenu);
    elements.modelSelector?.addEventListener("click", openModelMenu);
    elements.reasoningSelector?.addEventListener("click", openReasoningMenu);

    $$('[data-page]').forEach((item) => {
      item.addEventListener("click", (event) => {
        event.preventDefault();
        navigate(item.dataset.page);
      });
    });

    $$(".suggestion-card[data-prompt]").forEach((card) => {
      card.addEventListener("click", () => {
        navigate("new-thread");
        if (!elements.prompt) return;
        elements.prompt.value = card.dataset.prompt || "";
        resizePrompt();
        elements.prompt.focus();
      });
    });

    $$(".sidebar-toggle").forEach((button) => {
      button.addEventListener("click", () => elements.sidebar?.classList.toggle("collapsed"));
    });
    $(".mobile-sidebar-button")?.addEventListener("click", () => {
      elements.sidebar?.classList.toggle("open");
    });

    document.addEventListener("pointerdown", (event) => {
      const popover = $(".codex-popover");
      if (popover && !popover.contains(event.target) && !elements.accountMenu?.contains(event.target) &&
          !elements.modelSelector?.contains(event.target) && !elements.reasoningSelector?.contains(event.target)) {
        closePopover();
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closePopover();
    });
    window.addEventListener("resize", closePopover);
    window.addEventListener("scroll", closePopover, true);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) refreshBackendStatus({ silent: true });
    });
  }

  async function initializeApplication() {
    attachEventHandlers();
    resizePrompt();
    updateNavigation("new-thread");
    updateThreadList(null);
    setSendAvailability();
    setRuntimeStatus("Verificando o servidor Node.js do Codex Web...", "checking");
    await refreshBackendStatus({ silent: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializeApplication, { once: true });
  } else {
    initializeApplication();
  }
})();
