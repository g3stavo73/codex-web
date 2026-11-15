
"use strict";

/* =========================================================
   CODEX WEB
   Frontend controller
   HTML + CSS + Vanilla JavaScript

   RESPONSIBILITIES:
   - DOM manipulation
   - User interactions
   - Visual interface state
   - HTTP requests to the C# backend
   - Display backend responses

   NOT RESPONSIBLE FOR:
   - OAuth implementation
   - Codex App Server communication
   - MCP
   - Repository analysis
   - Business rules
   - Credential management
   ========================================================= */

/* =========================================================
   API CONTRACTS
   All frontend requests go through ASP.NET Core.
   ========================================================= */

const API = Object.freeze({
  auth: {
    status: "/api/auth/status",
    login: "/api/auth/login",
    logout: "/api/auth/logout"
  },

  chat: {
    stream: "/api/chat/stream"
  },

  projects: "/api/projects",
  tasks: "/api/tasks",
  history: "/api/history",
  files: "/api/files",
  terminal: "/api/terminal",
  git: "/api/git",
  agents: "/api/agents",
  plugins: "/api/plugins",
  settings: "/api/settings"
});

/* =========================================================
   DOM HELPERS
   ========================================================= */

const $ = (selector, parent = document) =>
  parent.querySelector(selector);

const $$ = (selector, parent = document) =>
  [...parent.querySelectorAll(selector)];

function createElement(tag, className = "", text) {
  const element = document.createElement(tag);

  if (className) {
    element.className = className;
  }

  if (text !== undefined) {
    element.textContent = text;
  }

  return element;
}

/* =========================================================
   APPLICATION STATE
   ========================================================= */

const state = {
  page: "new-thread",

  mode: "local",
  model: "default",
  reasoning: "medium",
  branch: "main",

  attachments: [],

  busy: false,
  conversationStarted: false,

  currentRequest: null,
  authenticated: false,
  account: null
};

/* =========================================================
   DOM REFERENCES
   ========================================================= */

const elements = {
  app: $(".app-shell"),
  sidebar: $("#sidebar"),

  workspace: $(".workspace"),
  workspaceCenter: $(".workspace-center"),

  welcome: $(".welcome-section"),
  suggestions: $(".suggestions-section"),

  composer: $("#composer"),
  prompt: $("#prompt-input"),
  sendButton: $("#send-button"),
  stopButton: $("#stop-button"),

  fileInput: $("#file-input"),
  attachButton: $("#attach-file"),
  attachmentList: $("#attachment-list"),

  conversationView: $("#conversation-view"),
  conversationMessages: $("#conversation-messages"),
  conversationComposer: $("#conversation-composer"),

  secondaryView: $("#secondary-view"),
  secondaryTitle: $("#secondary-view-title"),
  secondaryDescription: $("#secondary-view-description"),
  secondaryContent: $("#secondary-view-content"),

  threadList: $("#thread-list"),

  branchSelector: $("#branch-selector"),
  modelSelector: $("#model-selector"),
  reasoningSelector: $("#reasoning-selector"),

  modeSelector: $("#mode-selector"),

  currentPage: $(".breadcrumb-section"),

  accountName: $("#account-name"),
  accountPlan: $("#account-plan")
};

/* =========================================================
   API CLIENT
   The frontend communicates only with ASP.NET Core.
   ========================================================= */

async function apiRequest(endpoint, options = {}) {
  const headers = new Headers(options.headers || {});
  const isFormData = options.body instanceof FormData;

  if (!isFormData && options.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(endpoint, {
    ...options,
    headers,
    credentials: "same-origin",
    cache: "no-store"
  });

  if (!response.ok) {
    let message = `Request failed: ${response.status}`;

    try {
      const result = await response.json();

      if (typeof result.message === "string") {
        message = result.message;
      }
    } catch {
      // The response may not contain JSON.
    }

    throw new Error(message);
  }

  return response;
}

async function apiRequestJson(endpoint, options = {}) {
  const response = await apiRequest(endpoint, options);

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

/* =========================================================
   TOAST NOTIFICATIONS
   ========================================================= */

const toastRegion = createElement("div", "codex-toast-region");

toastRegion.setAttribute("aria-live", "polite");
toastRegion.setAttribute("aria-atomic", "false");

document.body.appendChild(toastRegion);

function showToast(message, type = "normal") {
  const toast = createElement(
    "div",
    `codex-toast ${type === "error" ? "error" : ""}`,
    message
  );

  toast.setAttribute("role", "status");

  toastRegion.appendChild(toast);

  window.setTimeout(() => {
    toast.remove();
  }, 3600);
}

/* =========================================================
   POPOVER MENUS
   ========================================================= */

let activePopover = null;
let activePopoverAnchor = null;

function closePopover() {
  if (activePopover) {
    activePopover.remove();
  }

  activePopover = null;
  activePopoverAnchor = null;
}

function openPopover(anchor, options, onSelect, label = "") {
  if (!anchor) {
    return;
  }

  closePopover();

  const menu = createElement("div", "codex-popover");

  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", label || "Options");

  if (label) {
    menu.appendChild(
      createElement("div", "codex-popover-label", label)
    );
  }

  for (const option of options) {
    const button = createElement(
      "button",
      "",
      option.label
    );

    button.type = "button";
    button.setAttribute("role", "menuitem");

    if (option.disabled) {
      button.disabled = true;
      button.setAttribute("aria-disabled", "true");
    }

    if (option.selected) {
      const check = createElement("span", "", "✓");
      check.setAttribute("aria-hidden", "true");
      button.appendChild(check);
    }

    button.addEventListener("click", () => {
      if (option.disabled) {
        return;
      }

      closePopover();

      if (typeof onSelect === "function") {
        onSelect(option.value);
      }
    });

    menu.appendChild(button);
  }

  document.body.appendChild(menu);

  const rect = anchor.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();

  let left = rect.left;
  let top = rect.bottom + 6;

  if (left + menuRect.width > window.innerWidth - 10) {
    left = window.innerWidth - menuRect.width - 10;
  }

  if (top + menuRect.height > window.innerHeight - 10) {
    top = rect.top - menuRect.height - 6;
  }

  menu.style.left = `${Math.max(10, left)}px`;
  menu.style.top = `${Math.max(10, top)}px`;

  activePopover = menu;
  activePopoverAnchor = anchor;
}

document.addEventListener("pointerdown", (event) => {
  if (!activePopover) {
    return;
  }

  const target = event.target;

  if (
    activePopover.contains(target) ||
    activePopoverAnchor?.contains(target)
  ) {
    return;
  }

  closePopover();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closePopover();
    closeMobileSidebar();
  }
});

window.addEventListener("resize", closePopover);
window.addEventListener("scroll", closePopover, true);

/* =========================================================
   SIDEBAR
   ========================================================= */

let mobileBackdrop = null;

function isMobile() {
  return window.matchMedia("(max-width: 640px)").matches;
}

function openMobileSidebar() {
  if (!elements.sidebar || !isMobile()) {
    return;
  }

  closeMobileSidebar();

  elements.sidebar.classList.add("open");

  mobileBackdrop = createElement(
    "div",
    "codex-mobile-backdrop"
  );

  mobileBackdrop.addEventListener(
    "click",
    closeMobileSidebar
  );

  document.body.appendChild(mobileBackdrop);
}

function closeMobileSidebar() {
  elements.sidebar?.classList.remove("open");

  if (mobileBackdrop) {
    mobileBackdrop.remove();
    mobileBackdrop = null;
  }
}

const sidebarToggle = $(".sidebar-toggle");
const mobileSidebarButton = $(".mobile-sidebar-button");

sidebarToggle?.addEventListener("click", () => {
  if (!elements.sidebar) {
    return;
  }

  if (isMobile()) {
    closeMobileSidebar();
    return;
  }

  elements.sidebar.classList.toggle("collapsed");
});

mobileSidebarButton?.addEventListener(
  "click",
  openMobileSidebar
);

/* =========================================================
   NAVIGATION
   ========================================================= */

const pageInformation = {
  "new-thread": {
    title: "New thread",
    description: "Start a new task with Codex."
  },

  tasks: {
    title: "Tasks",
    description: "View and manage your coding tasks."
  },

  history: {
    title: "History",
    description: "Browse your previous conversations."
  },

  projects: {
    title: "Projects",
    description: "Manage your development projects."
  },

  files: {
    title: "Files",
    description: "Browse files in your selected project."
  },

  terminal: {
    title: "Terminal",
    description: "Work with your project's terminal."
  },

  git: {
    title: "Git",
    description: "Review changes and manage your repository."
  },

  agents: {
    title: "Agents",
    description: "Manage agents and delegated work."
  },

  automations: {
    title: "Automations",
    description: "Create and manage scheduled tasks."
  },

  skills: {
    title: "Skills",
    description: "Explore reusable Codex skills."
  },

  plugins: {
    title: "Plugins",
    description: "Discover and manage available plugins."
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
