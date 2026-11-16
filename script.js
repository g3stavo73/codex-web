"use strict";

/*
 * CODEX WEB — browser controller
 *
 * The browser NEVER starts `codex app-server` and NEVER speaks JSON-RPC
 * to Codex directly. ASP.NET Core owns the Codex process, its stdio JSONL
 * connection, authentication, project root, sandbox and permissions.
 *
 * HTTP adapter contract implemented by the future ASP.NET Core backend:
 *
 * GET /api/codex/status
 *   {
 *     "ready": true,
 *     "codex": { "available": true, "authenticated": true,
 *                 "version": "...", "account": { "email": "..." } },
 *     "capabilities": { "chat": true, "interrupt": true },
 *     "models": [
 *       { "id": "...", "displayName": "...", "isDefault": true,
 *         "defaultReasoningEffort": "medium",
 *         "supportedReasoningEfforts": ["low", "medium", "high"] }
 *     ]
 *   }
 *
 * POST /api/codex/turns
 *   JSON body:
 *   {
 *     "threadId": null | "thr_...",
 *     "input": [{ "type": "text", "text": "..." }],
 *     "model": "..." (optional),
 *     "effort": "low|medium|high" (optional)
 *   }
 *   Response: text/event-stream. Each SSE event name is the original
 *   Codex App Server notification method, and `data` is its `params` JSON.
 *   The backend creates a thread with `thread/start` when threadId is null,
 *   then calls `turn/start` and forwards the notifications below.
 *
 * POST /api/codex/threads/{threadId}/turns/{turnId}/interrupt
 *   The backend MUST send JSON-RPC `turn/interrupt`; aborting fetch alone
 *   is not an interruption of Codex.
 *
 * These are Codex Web's HTTP routes, not official OpenAI endpoints. They
 * are a deliberate contract for the C# backend; they do not exist in the
 * current static-only repository yet. Until the backend responds correctly,
 * sending is kept disabled instead of pretending that Codex is connected.
 */

(() => {
  const API = Object.freeze({
    status: "/api/codex/status",
    turns: "/api/codex/turns",
    interrupt: (threadId, turnId) =>
      `/api/codex/threads/${encodeURIComponent(threadId)}/turns/${encodeURIComponent(turnId)}/interrupt`
  });

  const state = {
    page: "new-thread",
    backendReady: false,
    codexAuthenticated: false,
    capabilities: { chat: false, interrupt: false },
    models: [],
    model: null,
    effort: null,
    threadId: null,
    turnId: null,
    busy: false,
    stopRequested: false,
    currentAssistantMessage: null,
    currentRequest: null,
    account: null,
    threadTitle: "New conversation"
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  const elements = {
    sidebar: $("#sidebar"),
    workspace: $(".workspace"),
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
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
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
    window.setTimeout(() => toast.remove(), 4500);
  }

  async function readError(response) {
    const contentType = response.headers.get("content-type") || "";
    try {
      if (contentType.includes("application/json")) {
        const body = await response.json();
        return body.message || body.error?.message || body.title || `HTTP ${response.status}`;
      }
      const body = (await response.text()).trim();
      return body.slice(0, 500) || `HTTP ${response.status}`;
    } catch {
      return `HTTP ${response.status}`;
    }
  }

  async function apiRequest(path, options = {}) {
    const headers = new Headers(options.headers || {});
    const request = { ...options, headers };
    delete request.json;

    if (Object.prototype.hasOwnProperty.call(options, "json")) {
      headers.set("Content-Type", "application/json");
      request.body = JSON.stringify(options.json);
    }

    headers.set("Accept", headers.get("Accept") || "application/json");

    const response = await fetch(path, {
      ...request,
      credentials: "same-origin",
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error(await readError(response));
    }
    return response;
  }

  async function apiJson(path, options = {}) {
    const response = await apiRequest(path, options);
    if (response.status === 204) return null;
    return response.json();
  }

  function setRuntimeStatus(message, status = "offline") {
    let banner = elements.runtime;
    if (!banner) {
      banner = createElement("div", "runtime-status");
      banner.setAttribute("role", "status");
      banner.setAttribute("aria-live", "polite");
      if (elements.welcomeDescription?.parentElement) {
        elements.welcomeDescription.insertAdjacentElement("afterend", banner);
      } else if (elements.composer?.parentElement) {
        elements.composer.parentElement.insertBefore(banner, elements.composer);
      }
      elements.runtime = banner;
    }

    banner.dataset.state = status;
    banner.classList.remove("coming-soon-panel");
    banner.replaceChildren(createElement("span", "runtime-status-text", message));
  }

  function setComingSoon(button, unavailable, explanation = "This feature is not available yet.") {
    if (!button) return;
    button.disabled = Boolean(unavailable);
    button.classList.toggle("is-coming-soon", Boolean(unavailable));
    if (unavailable) {
      button.dataset.comingSoon = "true";
      button.title = explanation;
    } else {
      delete button.dataset.comingSoon;
      button.removeAttribute("title");
    }
  }

  function setSendAvailability(available) {
    setComingSoon(
      elements.send,
      !available,
      available ? "Send to Codex" : "Connect the Codex Web backend first."
    );
    if (elements.send) {
      elements.send.setAttribute("aria-label", available ? "Send message" : "Codex backend unavailable");
    }
    if (elements.prompt) {
      elements.prompt.placeholder = available
        ? "Ask Codex to work on your project..."
        : "The Codex backend is not connected yet...";
    }

    $$(".suggestion-card[data-prompt]").forEach((card) => {
      setComingSoon(card, !available, "Connect the Codex Web backend first.");
    });
  }

  function ensureStopButton() {
    if (!elements.stop) {
      if (!elements.send?.parentElement) return null;
      const button = createElement("button", "composer-icon-button stop-button", "Stop");
      button.type = "button";
      button.id = "stop-button";
      button.hidden = true;
      button.disabled = true;
      button.setAttribute("aria-label", "Interrupt the current Codex turn");
      button.title = "Interrupt Codex";
      elements.send.parentElement.insertBefore(button, elements.send);
      elements.stop = button;
    }

    // The button may already be present in a repaired HTML file.
    if (elements.stop.dataset.interruptHandler !== "attached") {
      elements.stop.addEventListener("click", stopCurrentTurn);
      elements.stop.dataset.interruptHandler = "attached";
    }
    return elements.stop;
  }

  function isReadyStatus(payload) {
    return Boolean(
      payload &&
      payload.ready === true &&
      payload.codex?.available === true &&
      payload.codex?.authenticated === true &&
      payload.capabilities?.chat === true
    );
  }

  function updateAccount(payload) {
    state.account = payload?.codex?.account || null;
    if (!elements.accountMenu) return;

    const name = $(".account-info strong", elements.accountMenu);
    const detail = $(".account-info small", elements.accountMenu);

    if (name) {
      name.textContent = state.account?.name || state.account?.email || "Personal";
    }
    if (detail) {
      detail.textContent = state.account?.planType || "Codex workspace";
    }
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
              .map((entry) => typeof entry === "string" ? entry : entry?.reasoningEffort)
              .filter((entry) => typeof entry === "string")
          : []
      }));
  }

  function currentModel() {
    return state.models.find((model) => model.id === state.model) || null;
  }

  let openMenu = null;
  let openMenuAnchor = null;

  function closeMenu() {
    openMenu?.remove();
    openMenu = null;
    openMenuAnchor = null;
  }

  function openOptionsMenu(anchor, options, label, onChoose) {
    if (!anchor || !Array.isArray(options) || options.length === 0) return;
    closeMenu();

    const menu = createElement("div", "codex-popover");
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", label);
    menu.appendChild(createElement("div", "codex-popover-label", label));

    for (const option of options) {
      const button = createElement("button", "", option.label);
      button.type = "button";
      button.setAttribute("role", "menuitem");
      button.addEventListener("click", () => {
        closeMenu();
        onChoose(option.value);
      });
      menu.appendChild(button);
    }

    document.body.appendChild(menu);
    const anchorRect = anchor.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const left = Math.max(8, Math.min(anchorRect.left, window.innerWidth - menuRect.width - 8));
    const top = anchorRect.bottom + menuRect.height + 8 > window.innerHeight
      ? Math.max(8, anchorRect.top - menuRect.height - 6)
      : anchorRect.bottom + 6;
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    openMenu = menu;
    openMenuAnchor = anchor;
  }

  document.addEventListener("pointerdown", (event) => {
    if (!openMenu) return;
    if (openMenu.contains(event.target) || openMenuAnchor?.contains(event.target)) return;
    closeMenu();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeMenu();
  });
  window.addEventListener("resize", closeMenu);
  window.addEventListener("scroll", closeMenu, true);

  function updateSelectorLabel(button, label) {
    if (!button) return;
    const span = $("span", button);
    if (span) span.textContent = label;
  }

  function configureModelSelectors(models) {
    state.models = normalizeModels(models);
    if (state.models.length === 0) {
      setComingSoon(elements.modelSelector, true, "The backend did not provide a model list.");
      setComingSoon(elements.reasoningSelector, true, "Reasoning options depend on the selected model.");
      return;
    }

    const defaultModel = state.models.find((model) => model.isDefault) || state.models[0];
    if (!state.model || !state.models.some((model) => model.id === state.model)) {
      state.model = defaultModel.id;
    }

    const model = currentModel();
    if (!state.effort || !model?.efforts.includes(state.effort)) {
      state.effort = model?.efforts.includes(model?.defaultEffort)
        ? model.defaultEffort
        : (model?.efforts[0] || null);
    }

    updateSelectorLabel(elements.modelSelector, model?.label || "Model");
    updateSelectorLabel(elements.reasoningSelector, state.effort || "Default");
    setComingSoon(elements.modelSelector, false);
    setComingSoon(elements.reasoningSelector, !model?.efforts.length,
      "This model does not expose reasoning-effort choices.");
  }

  elements.modelSelector?.addEventListener("click", () => {
    if (!state.backendReady || state.models.length === 0) return;
    openOptionsMenu(
      elements.modelSelector,
      state.models.map((model) => ({ label: model.label, value: model.id })),
      "Model",
      (modelId) => {
        state.model = modelId;
        state.effort = null;
        configureModelSelectors(state.models.map((model) => ({
          id: model.id,
          displayName: model.label,
          isDefault: model.isDefault,
          defaultReasoningEffort: model.defaultEffort,
          supportedReasoningEfforts: model.efforts
        })));
      }
    );
  });

  elements.reasoningSelector?.addEventListener("click", () => {
    const model = currentModel();
    if (!state.backendReady || !model?.efforts.length) return;
    openOptionsMenu(
      elements.reasoningSelector,
      model.efforts.map((effort) => ({ label: effort, value: effort })),
      "Reasoning effort",
      (effort) => {
        state.effort = effort;
        updateSelectorLabel(elements.reasoningSelector, effort);
      }
    );
  });

  async function refreshBackendStatus() {
    setRuntimeStatus("Checking the Codex Web backend...", "checking");
    setSendAvailability(false);

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 8000);

    try {
      const payload = await apiJson(API.status, { signal: controller.signal });
      if (!payload || typeof payload !== "object") {
        throw new Error("The backend returned an invalid status document.");
      }

      state.backendReady = isReadyStatus(payload);
      state.codexAuthenticated = payload.codex?.authenticated === true;
      state.capabilities = {
        chat: payload.capabilities?.chat === true,
        interrupt: payload.capabilities?.interrupt === true
      };
      updateAccount(payload);
      if (state.backendReady) {
        configureModelSelectors(payload.models);
      } else {
        setComingSoon(elements.modelSelector, true, "Connect and authenticate the Codex backend first.");
        setComingSoon(elements.reasoningSelector, true, "Connect and authenticate the Codex backend first.");
      }

      if (state.backendReady) {
        setRuntimeStatus(
          `Codex connected${payload.codex?.version ? ` · ${payload.codex.version}` : ""}.`,
          "ready"
        );
        setSendAvailability(true);
      } else if (payload.codex?.available === true && !state.codexAuthenticated) {
        setRuntimeStatus(
          "Codex is running, but no authenticated account is available. Complete sign-in on the backend machine.",
          "warning"
        );
      } else if (payload.ready === true && payload.capabilities?.chat !== true) {
        setRuntimeStatus("The backend is running, but chat capability is not enabled.", "warning");
      } else {
        setRuntimeStatus("The backend is reachable, but Codex is not ready yet.", "warning");
      }

      return payload;
    } catch (error) {
      const message = error.name === "AbortError"
        ? "The backend status check timed out."
        : `Backend unavailable: ${error.message}`;
      setRuntimeStatus(message, "offline");
      setSendAvailability(false);
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

  function startConversation() {
    elements.workspace && (elements.workspace.hidden = true);
    elements.conversation && (elements.conversation.hidden = false);
    elements.secondary && (elements.secondary.hidden = true);

    if (elements.composer && elements.conversationComposer &&
        elements.composer.parentElement !== elements.conversationComposer) {
      elements.conversationComposer.appendChild(elements.composer);
    }
  }

  function restoreWorkspaceComposer() {
    if (!elements.composer || !elements.workspaceCenter) return;
    const disclaimer = $(".workspace-disclaimer");
    if (elements.composer.parentElement !== elements.workspaceCenter) {
      if (disclaimer) elements.workspaceCenter.insertBefore(elements.composer, disclaimer);
      else elements.workspaceCenter.appendChild(elements.composer);
    }
  }

  function showNewThread() {
    if (state.busy) {
      showToast("Interrupt the current Codex turn before starting another thread.", "error");
      return;
    }

    state.page = "new-thread";
    state.threadId = null;
    state.turnId = null;
    state.currentAssistantMessage = null;

    restoreWorkspaceComposer();
    elements.workspace && (elements.workspace.hidden = false);
    elements.conversation && (elements.conversation.hidden = true);
    elements.secondary && (elements.secondary.hidden = true);
    elements.welcome && (elements.welcome.hidden = false);
    elements.suggestions && (elements.suggestions.hidden = false);
    elements.messages?.replaceChildren();
    initializeSidebar();
    if (elements.prompt) {
      elements.prompt.value = "";
      resizePrompt();
      elements.prompt.focus();
    }

    if (elements.breadcrumb) elements.breadcrumb.textContent = "New thread";
    updateNavigation("new-thread");
  }

  function updateNavigation(page) {
    $$(".navigation-item[data-page]").forEach((item) => {
      const active = item.dataset.page === page;
      item.classList.toggle("active", active);
      if (active) item.setAttribute("aria-current", "page");
      else item.removeAttribute("aria-current");
    });
  }

  const pageInfo = {
    tasks: ["Tasks", "Task management is not connected to the backend yet."],
    history: ["History", "Saved thread history requires the backend history API."],
    projects: ["Projects", "Project management requires backend support."],
    files: ["Files", "File browsing is not connected yet."],
    terminal: ["Terminal", "Terminal sessions are not connected yet."],
    git: ["Git", "Git operations are not connected yet."],
    agents: ["Agents", "Agent management is not connected yet."],
    automations: ["Automations", "Automations are not connected yet."],
    skills: ["Skills", "Skills management is not connected yet."],
    plugins: ["Plugins", "Plugin management is not connected yet."],
    settings: ["Settings", "Workspace settings are not connected yet."]
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
    if (state.busy && page !== "new-thread") {
      showToast("Finish or interrupt the active Codex turn before switching views.");
      return;
    }
    if (page === "new-thread") {
      showNewThread();
      return;
    }
    if (!pageInfo[page]) return;
    closeMenu();
    state.page = page;
    elements.workspace && (elements.workspace.hidden = true);
    elements.conversation && (elements.conversation.hidden = true);
    elements.secondary && (elements.secondary.hidden = false);
    if (elements.secondaryTitle) elements.secondaryTitle.textContent = pageInfo[page][0];
    if (elements.secondaryDescription) elements.secondaryDescription.textContent = pageInfo[page][1];
    if (elements.breadcrumb) elements.breadcrumb.textContent = pageInfo[page][0];
    renderUnavailablePage(page);
    updateNavigation(page);
  }

  $$(".navigation-item[data-page]").forEach((item) => {
    item.addEventListener("click", (event) => {
      event.preventDefault();
      if (item.getAttribute("aria-disabled") === "true" || item.dataset.comingSoon === "true") {
        return;
      }
      navigate(item.dataset.page);
    });
  });

  $$(".suggestion-card[data-prompt]").forEach((card) => {
    card.addEventListener("click", () => {
      if (!state.backendReady || card.disabled || !elements.prompt) return;
      navigate("new-thread");
      elements.prompt.value = card.dataset.prompt || "";
      resizePrompt();
      elements.prompt.focus();
    });
  });

  function createMessage(role, text = "") {
    if (!elements.messages) return null;
    const article = createElement("article", `message message-${role}`);
    article.dataset.role = role;
    const content = createElement("div", "message-content");
    const textNode = createElement("div", "message-text", text);
    textNode.style.whiteSpace = "pre-wrap";
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
    pre.style.whiteSpace = "pre-wrap";
    pre.style.overflowWrap = "anywhere";
    details.appendChild(pre);
    message.content.appendChild(details);
  }

  function eventParams(event) {
    if (event.data && typeof event.data === "object") {
      return event.data.params && typeof event.data.params === "object"
        ? event.data.params
        : event.data;
    }
    return {};
  }

  function applyCodexEvent(event) {
    const method = event.name;
    const params = eventParams(event);

    switch (method) {
      case "thread/started": {
        const threadId = params.thread?.id || params.threadId;
        if (typeof threadId === "string" && threadId) {
          state.threadId = threadId;
          if (elements.threadList) {
            const row = createElement("div", "thread-item selected");
            row.setAttribute("aria-current", "page");
            row.append(
              createElement("span", "thread-status"),
              createElement("span", "thread-name", state.threadTitle)
            );
            elements.threadList.replaceChildren(row);
          }
          if (elements.emptyThreads) elements.emptyThreads.hidden = true;
        }
        break;
      }

      case "turn/started": {
        const turnId = params.turn?.id || params.turnId;
        if (typeof turnId === "string" && turnId) {
          state.turnId = turnId;
          const stop = ensureStopButton();
          if (stop) {
            stop.disabled = !state.capabilities.interrupt || !state.threadId || !state.turnId;
          }
        }
        setMessageStatus(state.currentAssistantMessage, "Codex is working...");
        break;
      }

      case "turn/plan/updated": {
        setMessageStatus(state.currentAssistantMessage, "Codex is planning the task...");
        break;
      }

      case "item/started": {
        const item = params.item || {};
        if (item.type === "commandExecution") {
          setMessageStatus(state.currentAssistantMessage, "Codex is running a command...");
        } else if (item.type === "fileChange") {
          setMessageStatus(state.currentAssistantMessage, "Codex is updating project files...");
        }
        break;
      }

      case "item/agentMessage/delta": {
        const delta = params.delta;
        if (typeof delta === "string" && delta.length > 0) {
          const message = state.currentAssistantMessage;
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
        if (item.type === "agentMessage" && typeof item.text === "string") {
          const message = state.currentAssistantMessage;
          if (message?.textNode && !message.textNode.textContent) {
            message.textNode.textContent = item.text;
          }
        }
        break;
      }

      case "turn/diff/updated": {
        appendDiff(state.currentAssistantMessage, params.diff);
        break;
      }

      case "turn/completed": {
        const turn = params.turn || params;
        const turnStatus = turn.status;
        if (turnStatus === "failed") {
          const reason = turn.error?.message || turn.error?.additionalDetails || "Codex reported that the turn failed.";
          setMessageStatus(state.currentAssistantMessage, reason, true);
          event.failure = reason;
        } else if (turnStatus === "interrupted") {
          setMessageStatus(state.currentAssistantMessage, "Turn interrupted.");
        } else if (turnStatus === "completed") {
          clearMessageStatus(state.currentAssistantMessage);
          if (!state.currentAssistantMessage?.textNode?.textContent) {
            setMessageStatus(state.currentAssistantMessage, "Codex completed the turn without a text message.");
          }
        } else {
          event.failure = `Codex returned an unknown turn status: ${String(turnStatus)}`;
        }
        event.turnCompleted = true;
        event.turnStatus = turnStatus;
        break;
      }

      case "error": {
        const message = params.message || params.error?.message || "The backend reported an error.";
        setMessageStatus(state.currentAssistantMessage, message, true);
        event.failure = message;
        break;
      }

      case "warning":
      case "configWarning": {
        const warning = params.message || params.summary;
        if (warning) setMessageStatus(state.currentAssistantMessage, warning);
        break;
      }

      default:
        // Unknown Codex notifications are intentionally ignored.
        break;
    }
  }

  function parseSseBlock(block) {
    const lines = block.split(/\r?\n/);
    let name = "message";
    const data = [];

    for (const line of lines) {
      if (!line || line.startsWith(":")) continue;
      const separator = line.indexOf(":");
      const field = separator === -1 ? line : line.slice(0, separator);
      let value = separator === -1 ? "" : line.slice(separator + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") name = value || "message";
      else if (field === "data") data.push(value);
    }

    if (data.length === 0) return null;
    const raw = data.join("\n");
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Invalid JSON in server-sent event '${name}'.`);
    }
    return { name, data: parsed };
  }

  async function consumeEventStream(response) {
    if (!response.body) throw new Error("The backend returned no event stream.");
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
          const bridge = {
            ...event,
            set failure(value) { outcome.failure = value; },
            set turnCompleted(value) { outcome.turnCompleted = value; },
            set turnStatus(value) { outcome.turnStatus = value; }
          };
          applyCodexEvent(bridge);
          if (outcome.turnCompleted) break;
        }
        // turn/completed is terminal by protocol; do not wait for an
        // unrelated keep-alive or an unclosed HTTP response after it.
        if (outcome.turnCompleted) {
          await reader.cancel();
          break;
        }
      }

      buffer += decoder.decode();
      if (buffer.trim()) {
        const event = parseSseBlock(buffer);
        if (event) {
          const bridge = {
            ...event,
            set failure(value) { outcome.failure = value; },
            set turnCompleted(value) { outcome.turnCompleted = value; },
            set turnStatus(value) { outcome.turnStatus = value; }
          };
          applyCodexEvent(bridge);
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (!outcome.turnCompleted) {
      throw new Error(outcome.failure || "The event stream closed before Codex sent turn/completed. The final turn state is unknown.");
    }
    if (outcome.failure) throw new Error(outcome.failure);
    return outcome;
  }

  function setBusy(busy) {
    state.busy = busy;
    if (elements.prompt) elements.prompt.disabled = busy;
    if (elements.send) elements.send.disabled = busy || !state.backendReady;
    const stop = ensureStopButton();
    if (stop) {
      stop.hidden = !busy;
      stop.disabled = !busy || !state.capabilities.interrupt || !state.threadId || !state.turnId;
    }
    elements.composer?.setAttribute("aria-busy", String(busy));
  }

  async function submitChat(event) {
    event.preventDefault();
    if (state.busy) return;
    if (!state.backendReady) {
      showToast("Codex is not connected. The backend must be running first.", "error");
      return;
    }

    const text = elements.prompt?.value.trim() || "";
    if (!text) {
      elements.prompt?.focus();
      return;
    }

    state.threadTitle = text.replace(/\s+/g, " ").slice(0, 52) || "New conversation";
    const payload = {
      threadId: state.threadId,
      input: [{ type: "text", text }]
    };
    if (state.model) payload.model = state.model;
    if (state.effort) payload.effort = state.effort;

    setBusy(true);
    state.stopRequested = false;
    state.turnId = null;
    state.currentAssistantMessage = null;
    state.currentRequest = new AbortController();

    try {
      const response = await apiRequest(API.turns, {
        method: "POST",
        headers: { Accept: "text/event-stream" },
        json: payload,
        signal: state.currentRequest.signal
      });

      const contentType = response.headers.get("content-type") || "";
      if (!contentType.toLowerCase().includes("text/event-stream")) {
        throw new Error("Expected a text/event-stream response from /api/codex/turns.");
      }

      startConversation();
      elements.welcome && (elements.welcome.hidden = true);
      elements.suggestions && (elements.suggestions.hidden = true);
      if (elements.breadcrumb) elements.breadcrumb.textContent = "Codex thread";

      createMessage("user", text);
      state.currentAssistantMessage = createMessage("assistant");
      setMessageStatus(state.currentAssistantMessage, "Connecting to Codex App Server...");

      if (elements.prompt) {
        elements.prompt.value = "";
        resizePrompt();
      }

      await consumeEventStream(response);
    } catch (error) {
      const message = error.name === "AbortError"
        ? "The browser connection was interrupted. The Codex turn may still be running; check the backend before retrying."
        : error.message || "An unexpected error occurred.";

      if (state.currentAssistantMessage) {
        setMessageStatus(state.currentAssistantMessage, message, true);
      } else {
        showToast(message, "error");
      }
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
      showToast("Codex has not supplied the thread and turn IDs required for interruption yet.", "error");
      return;
    }

    state.stopRequested = true;
    if (elements.stop) elements.stop.disabled = true;
    setMessageStatus(state.currentAssistantMessage, "Sending interruption request to Codex...");

    try {
      await apiRequest(API.interrupt(state.threadId, state.turnId), { method: "POST" });
      setMessageStatus(state.currentAssistantMessage, "Interruption requested. Waiting for Codex to confirm...");
    } catch (error) {
      state.stopRequested = false;
      if (elements.stop) elements.stop.disabled = false;
      setMessageStatus(state.currentAssistantMessage, `Could not interrupt Codex: ${error.message}`, true);
      showToast(`Interrupt request failed: ${error.message}`, "error");
    }
  }

  function initializeSidebar() {
    if (elements.threadList) {
      elements.threadList.replaceChildren(
        createElement("div", "thread-history-placeholder", "Thread history will appear when the backend history API is implemented.")
      );
    }
    if (elements.emptyThreads) elements.emptyThreads.hidden = true;
  }

  function initializeApplication() {
    ensureStopButton();
    initializeSidebar();
    updateNavigation("new-thread");
    setSendAvailability(false);
    setRuntimeStatus("Codex backend has not been checked yet.", "checking");

    elements.prompt?.addEventListener("input", resizePrompt);
    elements.prompt?.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        elements.composer?.requestSubmit();
      }
    });

    elements.composer?.addEventListener("submit", submitChat);
    $$(".sidebar-toggle").forEach((button) => {
      button.addEventListener("click", () => elements.sidebar?.classList.toggle("collapsed"));
    });
    $(".mobile-sidebar-button")?.addEventListener("click", () => {
      elements.sidebar?.classList.toggle("open");
    });

    elements.accountMenu?.addEventListener("click", () => {
      if (state.account) {
        showToast(`Connected account: ${state.account.email || state.account.name || "Codex account"}`);
      } else {
        showToast("Account status is provided by the local Codex backend.");
      }
    });

    resizePrompt();
    refreshBackendStatus();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializeApplication, { once: true });
  } else {
    initializeApplication();
  }
})();
nd manage available plugins."
  },

  settings: {
    title: "Settings",
    description: "Configure your Codex workspace."
  }
};

const pageMessages = {
  tasks:
    "Tasks will appear here when the backend provides task data.",

  history:
    "Conversation history will be loaded from the backend.",

  projects:
    "Your projects will be loaded from the backend.",

  files:
    "The file explorer will use the selected backend project.",

  terminal:
    "Terminal operations will be handled by the backend.",

  git:
    "Repository status, diffs, branches and commits will be loaded from the backend.",

  agents:
    "Agent configuration and delegated tasks will be managed by the backend.",

  automations:
    "Scheduled tasks and automation history will be managed by the backend.",

  skills:
    "Available skills will be provided by the backend.",

  plugins:
    "The plugin catalog and installed plugins will be loaded from the backend.",

  settings:
    "Workspace and account preferences will be managed by the backend."
};

function renderEmptyPage(page) {
  if (!elements.secondaryContent) {
    return;
  }

  const info = pageInformation[page] || {
    title: "Workspace",
    description: "Workspace tools."
  };

  const empty = createElement("div", "view-empty");

  const icon = createElement(
    "div",
    "view-empty-icon",
    "◈"
  );

  const title = createElement(
    "strong",
    "",
    info.title
  );

  const description = createElement(
    "p",
    "",
    pageMessages[page] || "This workspace area is being prepared."
  );

  empty.append(icon, title, description);

  elements.secondaryContent.replaceChildren(empty);
}

function updateNavigation(page) {
  $$(".navigation-item[data-page]").forEach((item) => {
    const isActive = item.dataset.page === page;

    item.classList.toggle("active", isActive);

    if (isActive) {
      item.setAttribute("aria-current", "page");
    } else {
      item.removeAttribute("aria-current");
    }
  });
}

function setPage(page) {
  if (!pageInformation[page]) {
    return;
  }

  if (state.busy && page === "new-thread") {
    showToast("Finish or stop the current request first.");
    return;
  }

  state.page = page;

  closePopover();
  closeMobileSidebar();

  updateNavigation(page);

  if (elements.currentPage) {
    elements.currentPage.textContent =
      pageInformation[page].title;
  }

  if (page === "new-thread") {
    showNewThread();
    return;
  }

  if (elements.workspace) {
    elements.workspace.hidden = true;
  }

  if (elements.conversationView) {
    elements.conversationView.hidden = true;
  }

  if (elements.secondaryView) {
    elements.secondaryView.hidden = false;
  }

  if (elements.secondaryTitle) {
    elements.secondaryTitle.textContent =
      pageInformation[page].title;
  }

  if (elements.secondaryDescription) {
    elements.secondaryDescription.textContent =
      pageInformation[page].description;
  }

  renderEmptyPage(page);
}

$$(".navigation-item[data-page]").forEach((item) => {
  item.addEventListener("click", (event) => {
    event.preventDefault();
    setPage(item.dataset.page);
  });
});

/* =========================================================
   NEW THREAD
   ========================================================= */

function showNewThread() {
  if (state.busy) {
    showToast("A request is currently running.");
    return;
  }

  state.page = "new-thread";
  state.conversationStarted = false;

  if (elements.workspace) {
    elements.workspace.hidden = false;
  }

  if (elements.conversationView) {
    elements.conversationView.hidden = true;
  }

  if (elements.secondaryView) {
    elements.secondaryView.hidden = true;
  }

  const disclaimer = $(".workspace-disclaimer");

  if (
    elements.composer &&
    elements.workspaceCenter &&
    elements.composer.parentElement !== elements.workspaceCenter
  ) {
    if (disclaimer) {
      elements.workspaceCenter.insertBefore(
        elements.composer,
        disclaimer
      );
    } else {
      elements.workspaceCenter.appendChild(elements.composer);
    }
  }

  if (elements.welcome) {
    elements.welcome.hidden = false;
  }

  if (elements.suggestions) {
    elements.suggestions.hidden = false;
  }

  elements.conversationMessages?.replaceChildren();

  if (elements.prompt) {
    elements.prompt.value = "";
    resizePrompt();
  }

  state.attachments = [];

  renderAttachments();

  updateNavigation("new-thread");

  if (elements.currentPage) {
    elements.currentPage.textContent = "New thread";
  }

  closePopover();
  closeMobileSidebar();

  elements.prompt?.focus();
}

function startConversation() {
  if (state.conversationStarted) {
    return;
  }

  state.conversationStarted = true;

  if (elements.workspace) {
    elements.workspace.hidden = true;
  }

  if (elements.conversationView) {
    elements.conversationView.hidden = false;
  }

  if (
    elements.composer &&
    elements.conversationComposer
  ) {
    elements.conversationComposer.appendChild(
      elements.composer
    );
  }

  updateNavigation("new-thread");

  if (elements.currentPage) {
    elements.currentPage.textContent = "New thread";
  }
}

/* =========================================================
   SUGGESTED TASKS
   ========================================================= */

$$(".suggestion-card[data-prompt]").forEach((card) => {
  card.addEventListener("click", () => {
    setPage("new-thread");

    if (!elements.prompt) {
      return;
    }

    elements.prompt.value = card.dataset.prompt || "";

    resizePrompt();
    elements.prompt.focus();
  });
});

/* =========================================================
   PROMPT INPUT
   ========================================================= */

function resizePrompt() {
  if (!elements.prompt) {
    return;
  }

  const input = elements.prompt;

  input.style.height = "auto";

  const maxHeight = 220;

  input.style.height =
    `${Math.min(input.scrollHeight, maxHeight)}px`;
}

elements.prompt?.addEventListener("input", resizePrompt);

elements.prompt?.addEventListener("keydown", (event) => {
  if (
    event.key === "Enter" &&
    !event.shiftKey &&
    !event.isComposing
  ) {
    event.preventDefault();
    elements.composer?.requestSubmit();
  }
});

/* =========================================================
   FILE ATTACHMENTS
   ========================================================= */

function isDuplicateFile(file) {
  return state.attachments.some((existing) =>
    existing.name === file.name &&
    existing.size === file.size &&
    existing.lastModified === file.lastModified
  );
}

function renderAttachments() {
  if (!elements.attachmentList) {
    return;
  }

  elements.attachmentList.replaceChildren();

  state.attachments.forEach((file, index) => {
    const chip = createElement("div", "attachment-chip");

    const name = createElement("span", "", file.name);

    const remove = createElement("button", "", "×");

    remove.type = "button";

    remove.setAttribute(
      "aria-label",
      `Remove ${file.name}`
    );

    remove.addEventListener("click", () => {
      state.attachments.splice(index, 1);
      renderAttachments();
    });

    chip.append(name, remove);

    elements.attachmentList.appendChild(chip);
  });
}

function addAttachments(files) {
  for (const file of files) {
    if (!isDuplicateFile(file)) {
      state.attachments.push(file);
    }
  }

  renderAttachments();
}

elements.attachButton?.addEventListener("click", () => {
  elements.fileInput?.click();
});

elements.fileInput?.addEventListener("change", (event) => {
  const files = [...(event.target.files || [])];

  addAttachments(files);

  // Allows selecting the same file again later.
  event.target.value = "";
});

/* =========================================================
   SELECTOR MENUS
   ========================================================= */

const selectorOptions = {
  mode: [
    { label: "Local", value: "local" },
    { label: "Worktree", value: "worktree" },
    { label: "Cloud", value: "cloud" }
  ],

  model: [
    { label: "Default", value: "default" }
  ],

  reasoning: [
    { label: "Low", value: "low" },
    { label: "Medium", value: "medium" },
    { label: "High", value: "high" }
  ]
};

function readCustomOptions(anchor) {
  const raw = anchor?.dataset.options;

  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);

    if (!Array.isArray(parsed)) {
      return null;
    }

    return parsed
      .filter((option) =>
        typeof option.label === "string" &&
        typeof option.value === "string"
      )
      .map((option) => ({
        label: option.label,
        value: option.value,
        disabled: Boolean(option.disabled),
        selected: option.value === anchor.dataset.value
      }));
  } catch {
    return null;
  }
}

function applySelectorValue(anchor, key, value) {
  if (!(key in state)) {
    return;
  }

  state[key] = value;

  if (anchor) {
    anchor.dataset.value = value;

    anchor.setAttribute(
      "aria-label",
      `${key}: ${value}`
    );
  }
}

function openSelector(anchor, key) {
  if (!anchor) {
    return;
  }

  if (key === "branch") {
    const customOptions = readCustomOptions(anchor);

    if (!customOptions?.length) {
      showToast("Branch options will be provided by the backend.");
      return;
    }

    openPopover(
      anchor,
      customOptions,
      (value) => applySelectorValue(anchor, key, value),
      "Branch"
    );

    return;
  }

  const customOptions = readCustomOptions(anchor);

  const options = customOptions || selectorOptions[key];

  if (!options) {
    return;
  }

  openPopover(
    anchor,
    options.map((option) => ({
      ...option,
      selected: option.value === state[key]
    })),
    (value) => applySelectorValue(anchor, key, value),
    key
  );
}

function getSelectorKey(anchor) {
  if (anchor.dataset.selector) {
    return anchor.dataset.selector;
  }

  const mapping = {
    "mode-selector": "mode",
    "model-selector": "model",
    "reasoning-selector": "reasoning",
    "branch-selector": "branch"
  };

  return mapping[anchor.id] || null;
}

$$(".composer-select, #mode-selector, #model-selector, #reasoning-selector, #branch-selector")
  .forEach((anchor) => {
    anchor.addEventListener("click", () => {
      const key = getSelectorKey(anchor);

      if (key) {
        openSelector(anchor, key);
      }
    });
  });

/* =========================================================
   ACCOUNT / CHATGPT AUTHENTICATION
   ========================================================= */

/*
 * The backend owns OAuth.
 *
 * Expected POST /api/auth/login response:
 *
 * {
 *   "authUrl": "https://..."
 * }
 *
 * The backend starts the Codex App Server login.
 * JavaScript only opens the returned URL.
 */

function updateAccountInterface(result) {
  if (!result) {
    return;
  }

  state.authenticated = Boolean(result.authenticated);
  state.account = result.account || null;

  const account = state.account || {};

  if (elements.accountName) {
    elements.accountName.textContent =
      account.email || "Not signed in";
  }

  if (elements.accountPlan) {
    elements.accountPlan.textContent =
      account.planType || "";
  }

  document.body.dataset.authenticated =
    String(state.authenticated);
}

async function refreshAuthStatus(silent = true) {
  try {
    const result = await apiRequestJson(API.auth.status);

    updateAccountInterface(result);

    return result;
  } catch (error) {
    if (!silent) {
      showToast(error.message, "error");
    }

    return null;
  }
}

function isValidAuthUrl(value) {
  try {
    const url = new URL(value);

    return url.protocol === "https:";
  } catch {
    return false;
  }
}

async function beginChatGPTLogin() {
  /*
   * Open synchronously to avoid popup blockers.
   * The backend will provide the real authentication URL.
   */

  const authWindow = window.open(
    "about:blank",
    "_blank"
  );

  try {
    const result = await apiRequestJson(API.auth.login, {
      method: "POST",
      body: JSON.stringify({
        provider: "chatgpt"
      })
    });

    if (!result?.authUrl || !isValidAuthUrl(result.authUrl)) {
      throw new Error(
        "The backend did not return a valid authentication URL."
      );
    }

    if (authWindow && !authWindow.closed) {
      authWindow.location.href = result.authUrl;
    } else {
      window.location.assign(result.authUrl);
    }

    showToast("Complete your sign-in in the browser.");

  } catch (error) {
    authWindow?.close();

    showToast(error.message, "error");
  }
}

async function logout() {
  try {
    await apiRequestJson(API.auth.logout, {
      method: "POST"
    });

    updateAccountInterface({
      authenticated: false,
      account: null
    });

    showToast("Signed out.");

  } catch (error) {
    showToast(error.message, "error");
  }
}

$$("[data-action='login'], #login-button, .login-button")
  .forEach((button) => {
    button.addEventListener("click", beginChatGPTLogin);
  });

$$("[data-action='logout'], #logout-button")
  .forEach((button) => {
    button.addEventListener("click", logout);
  });

/*
 * Refresh the visible account state when returning
 * from the authentication browser tab.
 */

window.addEventListener("focus", () => {
  refreshAuthStatus(true);
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    refreshAuthStatus(true);
  }
});

/* =========================================================
   CHAT MESSAGE RENDERING
   ========================================================= */

function appendMessage(role, text = "", attachments = []) {
  if (!elements.conversationMessages) {
    return null;
  }

  const article = createElement(
    "article",
    `message message-${role}`
  );

  article.setAttribute("data-role", role);

  const content = createElement(
    "div",
    "message-content"
  );

  const textElement = createElement(
    role === "assistant" ? "div" : "div",
    role === "assistant" ? "message-text" : ""
  );

  textElement.textContent = text;

  content.appendChild(textElement);

  if (attachments.length > 0) {
    const attachmentContainer = createElement(
      "div",
      "message-attachments"
    );

    attachments.forEach((file) => {
      const item = createElement(
        "span",
        "message-attachment",
        file.name
      );

      attachmentContainer.appendChild(item);
    });

    content.appendChild(attachmentContainer);
  }

  article.appendChild(content);

  elements.conversationMessages.appendChild(article);

  article.scrollIntoView({
    behavior: "smooth",
    block: "end"
  });

  return {
    article,
    content,
    textElement
  };
}

function addMessageStatus(message, text, isError = false) {
  if (!message?.content) {
    return;
  }

  let status = message.content.querySelector(".message-status");

  if (!status) {
    status = createElement("div", "message-status");

    message.content.prepend(status);
  }

  status.textContent = text;
  status.classList.toggle("error", isError);
}

function removeMessageStatus(message) {
  message?.content
    ?.querySelector(".message-status")
    ?.remove();
}

/* =========================================================
   CHAT STREAMING
   ========================================================= */

/*
 * Expected request:
 *
 * POST /api/chat/stream
 * Content-Type: multipart/form-data
 *
 * Fields:
 *   message
 *   mode
 *   model
 *   reasoning
 *   branch
 *   attachments[]
 *
 * Expected SSE events:
 *
 * data: {"type":"status","message":"Working..."}
 * data: {"type":"text_delta","text":"Hello"}
 * data: {"type":"completed"}
 * data: {"type":"error","message":"Something went wrong"}
 */

function parseSseBlock(block) {
  const lines = block.split(/\r?\n/);

  let eventName = "message";
  const dataLines = [];

  for (const line of lines) {
    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim();
    }

    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  if (!dataLines.length) {
    return null;
  }

  const rawData = dataLines.join("\n");

  if (rawData === "[DONE]") {
    return { type: "completed" };
  }

  try {
    const parsed = JSON.parse(rawData);

    if (!parsed.type && eventName !== "message") {
      parsed.type = eventName;
    }

    return parsed;

  } catch {
    return {
      type: eventName === "message" ? "text_delta" : eventName,
      text: rawData
    };
  }
}

function handleStreamEvent(event, message) {
  if (!event || typeof event !== "object") {
    return;
  }

  switch (event.type) {
    case "status": {
      addMessageStatus(
        message,
        event.message || "Working..."
      );

      break;
    }

    case "text_delta": {
      if (typeof event.text === "string") {
        message.textElement.textContent += event.text;

        message.article.scrollIntoView({
          behavior: "auto",
          block: "end"
        });
      }

      break;
    }

    case "completed": {
      removeMessageStatus(message);
      break;
    }

    case "error": {
      const errorMessage =
        event.message || "The request failed.";

      addMessageStatus(
        message,
        errorMessage,
        true
      );

      throw new Error(errorMessage);
    }

    default: {
      /*
       * Unknown events are ignored.
       * The backend can add event types later
       * without breaking the frontend.
       */

      break;
    }
  }
}

async function consumeEventStream(response, message) {
  if (!response.body) {
    throw new Error("The server returned an empty response stream.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, {
        stream: true
      });

      const blocks = buffer.split(/\r?\n\r?\n/);

      buffer = blocks.pop() || "";

      for (const block of blocks) {
        const event = parseSseBlock(block);

        handleStreamEvent(event, message);
      }
    }

    buffer += decoder.decode();

    if (buffer.trim()) {
      const event = parseSseBlock(buffer);

      handleStreamEvent(event, message);
    }

  } finally {
    reader.releaseLock();
  }
}

/* =========================================================
   CHAT REQUEST
   ========================================================= */

function setBusy(busy) {
  state.busy = busy;

  if (elements.sendButton) {
    elements.sendButton.disabled = busy;

    elements.sendButton.setAttribute(
      "aria-busy",
      String(busy)
    );
  }

  if (elements.stopButton) {
    elements.stopButton.hidden = !busy;
    elements.stopButton.disabled = !busy;
  }

  if (elements.prompt) {
    elements.prompt.disabled = busy;
  }

  if (elements.composer) {
    elements.composer.setAttribute(
      "aria-busy",
      String(busy)
    );
  }
}

function createChatFormData(message, attachments) {
  const data = new FormData();

  data.append("message", message);
  data.append("mode", state.mode);
  data.append("model", state.model);
  data.append("reasoning", state.reasoning);

  if (state.branch) {
    data.append("branch", state.branch);
  }

  for (const file of attachments) {
    data.append("attachments", file, file.name);
  }

  return data;
}

async function submitChat(event) {
  event.preventDefault();

  if (state.busy) {
    return;
  }

  const messageText = elements.prompt?.value.trim() || "";
  const attachments = [...state.attachments];

  if (!messageText && attachments.length === 0) {
    elements.prompt?.focus();
    return;
  }

  /*
   * Create the visual conversation.
   */

  startConversation();

  appendMessage(
    "user",
    messageText,
    attachments
  );

  const assistantMessage = appendMessage(
    "assistant"
  );

  if (!assistantMessage) {
    showToast("The conversation interface is unavailable.", "error");
    return;
  }

  addMessageStatus(
    assistantMessage,
    "Connecting to Codex..."
  );

  /*
   * Clear the composer without discarding
   * the File objects being sent.
   */

  if (elements.prompt) {
    elements.prompt.value = "";
    resizePrompt();
  }

  state.attachments = [];
  renderAttachments();

  setBusy(true);

  const controller = new AbortController();

  state.currentRequest = controller;

  try {
    const formData = createChatFormData(
      messageText,
      attachments
    );

    const response = await apiRequest(API.chat.stream, {
      method: "POST",
      body: formData,

      headers: {
        Accept: "text/event-stream"
      },

      signal: controller.signal
    });

    const contentType =
      response.headers.get("content-type") || "";

    /*
     * The normal response is SSE.
     * JSON is also accepted for backend errors
     * or non-streaming responses.
     */

    if (contentType.includes("application/json")) {
      const result = await response.json();

      if (result.message) {
        assistantMessage.textElement.textContent =
          result.message;
      }

      removeMessageStatus(assistantMessage);

    } else {
      await consumeEventStream(
        response,
        assistantMessage
      );

      removeMessageStatus(assistantMessage);
    }

  } catch (error) {
    if (error.name === "AbortError") {
      addMessageStatus(
        assistantMessage,
        "Request interrupted.",
        true
      );

    } else {
      addMessageStatus(
        assistantMessage,
        error.message || "An unexpected error occurred.",
        true
      );

      showToast(
        error.message || "Chat request failed.",
        "error"
      );
    }

  } finally {
    if (state.currentRequest === controller) {
      state.currentRequest = null;
      setBusy(false);
    }

    elements.prompt?.focus();
  }
}

elements.composer?.addEventListener(
  "submit",
  submitChat
);

/* =========================================================
   STOP CURRENT REQUEST
   ========================================================= */

function stopCurrentRequest() {
  if (!state.currentRequest) {
    return;
  }

  state.currentRequest.abort();
}

elements.stopButton?.addEventListener(
  "click",
  stopCurrentRequest
);

/* =========================================================
   INITIALIZATION
   ========================================================= */

function initializeApplication() {
  /*
   * Initial visual state.
   */

  updateNavigation(state.page);

  renderAttachments();

  resizePrompt();

  /*
   * Authentication status is requested from
   * the backend. Failure is silent because
   * the authentication API may not exist yet.
   */

  const hasAccountInterface = Boolean(
    elements.accountName ||
    elements.accountPlan ||
    $("[data-action='login']") ||
    $("#login-button")
  );

  if (hasAccountInterface) {
    refreshAuthStatus(true);
  }

  /*
   * Initialize selector values from the DOM
   * when explicitly provided by the HTML.
   */

  const selectors = [
    [elements.modeSelector, "mode"],
    [elements.modelSelector, "model"],
    [elements.reasoningSelector, "reasoning"],
    [elements.branchSelector, "branch"]
  ];

  selectors.forEach(([element, key]) => {
    if (element?.dataset.value) {
      state[key] = element.dataset.value;
    }
  });

  /*
   * Initial page.
   */

  if (elements.secondaryView) {
    elements.secondaryView.hidden = true;
  }

  if (elements.conversationView) {
    elements.conversationView.hidden = true;
  }

  if (elements.workspace) {
    elements.workspace.hidden = false;
  }
}

/*
 * Supports scripts loaded both with defer
 * and at the end of the document.
 */

if (document.readyState === "loading") {
  document.addEventListener(
    "DOMContentLoaded",
    initializeApplication,
    { once: true }
  );
} else {
  initializeApplication();
}
