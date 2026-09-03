import {
  addHistory,
  blobToBase64,
  createIdleQueue,
  getGroups,
  getImages,
  getQueueState,
  getSettings,
  saveGroups,
  setQueueState,
} from "../lib/storage.js";
import {
  createGroupId,
  isGroupsDirectoryUrl,
  parseGroupUrl,
} from "../lib/groups.js";

const DELAY_ALARM = "mpf-delay";
const POST_TIMEOUT_MS = 120000;
const TAB_WAIT_MS = 25000;
const PING_WAIT_MS = 20000;
const SCAN_TIMEOUT_MS = 120000;
const JOINS_URL = "https://www.facebook.com/groups/joins";

let postingLock = false;
let activeRunId = 0;
let pauseRequested = false;
let scanning = false;

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.runtime.onStartup.addListener(() => {
  recoverQueueAfterRestart();
});

recoverQueueAfterRestart();
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error) => {
      sendResponse({ ok: false, error: error.message || String(error) });
    });
  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === DELAY_ALARM) {
    continueAfterDelay().catch((error) => {
      pauseWithError(error.message || String(error));
    });
  }
});

async function handleMessage(message, sender) {
  switch (message.type) {
    case "GET_STATE":
      return { ok: true, state: await getQueueState() };
    case "FILL_PAGE_COMPOSER":
      return fillPageComposer(sender?.tab?.id, message.text);
    case "ARM_PAGE_FILES":
      return armPageFiles(sender?.tab?.id, message.images || []);
    case "DISARM_PAGE_FILES":
      return disarmPageFiles(sender?.tab?.id);
    case "START_QUEUE":
      return startQueue(message);
    case "PAUSE_QUEUE":
      return pauseQueue();
    case "RESUME_QUEUE":
      return resumeQueue();
    case "SKIP_CURRENT":
      return skipCurrent();
    case "STOP_QUEUE":
      return stopQueue();
    case "GET_CURRENT_GROUP":
      return getCurrentGroupFromTab();
    case "GET_POST_IMAGE":
      return getPostImage(message.imageId);
    case "SCAN_JOINED_GROUPS":
      return scanJoinedGroups();
    case "SCAN_PROGRESS":
    case "SCAN_STATE":
    case "QUEUE_STATE":
      return { ok: true };
    default:
      return { ok: false, error: "Unknown message" };
  }
}

async function recoverQueueAfterRestart() {
  const state = await getQueueState();
  if (state.status === "running") {
    state.status = "paused";
    state.lastError = "Extension vừa khởi động lại. Nhấn Tiếp tục để chạy nhóm hiện tại.";
    await persistAndBroadcast(state);
    return;
  }
  if (state.status === "delaying") {
    const remaining = (state.delayEndsAt || 0) - Date.now();
    if (remaining > 1000) {
      chrome.alarms.create(DELAY_ALARM, { when: state.delayEndsAt });
    } else {
      await continueAfterDelay();
    }
  }
}

async function startQueue({ groupIds, text, imageIds }) {
  const current = await getQueueState();
  if (current.status === "running" || current.status === "delaying") {
    return { ok: false, error: "Hàng đợi đang chạy." };
  }

  const cleanText = (text || "").trim();
  const images = Array.isArray(imageIds) ? imageIds : [];
  if (!cleanText && images.length === 0) {
    return { ok: false, error: "Nhập nội dung hoặc đính ít nhất một ảnh." };
  }

  const groups = await getGroups();
  const selected = groups.filter((group) => groupIds.includes(group.id));
  if (selected.length === 0) {
    return { ok: false, error: "Chọn ít nhất một nhóm." };
  }

  pauseRequested = false;
  activeRunId += 1;
  const settings = await getSettings();
  const state = {
    ...createIdleQueue(),
    status: "running",
    jobId: `job_${Date.now()}`,
    items: selected.map((group) => ({
      groupId: group.id,
      groupName: group.name,
      url: group.url,
      status: "pending",
      error: "",
    })),
    currentIndex: 0,
    delayMinSeconds: settings.delayMinSeconds,
    delayMaxSeconds: settings.delayMaxSeconds,
    delaySeconds: settings.delayMaxSeconds,
    lastError: "",
    text: cleanText,
    imageIds: images,
    tabId: current.tabId || null,
  };

  await persistAndBroadcast(state);
  runCurrentItem().catch((error) => {
    pauseWithError(error.message || String(error));
  });
  return { ok: true, state };
}

async function pauseQueue() {
  await chrome.alarms.clear(DELAY_ALARM);
  const state = await getQueueState();
  if (state.status === "idle") {
    return { ok: true, state };
  }

  // Nếu đang bấm Đăng, đợi bài hiện tại xong rồi mới pause — tránh đăng trùng khi Tiếp tục.
  if (state.status === "running" && postingLock) {
    pauseRequested = true;
    state.lastError = "Sẽ tạm dừng sau bài hiện tại.";
    await persistAndBroadcast(state);
    return { ok: true, state };
  }

  pauseRequested = false;
  state.status = "paused";
  state.delayEndsAt = 0;
  await persistAndBroadcast(state);
  return { ok: true, state };
}

async function resumeQueue() {
  const state = await getQueueState();
  if (state.status !== "paused") {
    return { ok: false, error: "Không có hàng đợi đang tạm dừng." };
  }
  const hasPending = state.items.some(
    (item) => item.status === "pending" || item.status === "posting"
  );
  if (!hasPending) {
    return stopQueue();
  }
  if (state.currentIndex < 0) {
    state.currentIndex = state.items.findIndex((item) => item.status === "pending");
  }
  if (state.items[state.currentIndex]?.status === "posting") {
    state.items[state.currentIndex].status = "pending";
  }
  pauseRequested = false;
  activeRunId += 1;
  state.status = "running";
  state.lastError = "";
  await persistAndBroadcast(state);
  runCurrentItem().catch((error) => {
    pauseWithError(error.message || String(error));
  });
  return { ok: true, state };
}

async function skipCurrent() {
  activeRunId += 1;
  pauseRequested = false;
  await chrome.alarms.clear(DELAY_ALARM);
  const state = await getQueueState();
  const item = state.items[state.currentIndex];
  if (!item) {
    return { ok: false, error: "Không có nhóm đang chạy." };
  }

  item.status = "skipped";
  item.error = "Đã bỏ qua";
  await addHistory(historyEntry(state, item, "skipped", "Đã bỏ qua"));
  await persistAndBroadcast(state);
  return advanceOrFinish(state, { skipped: true });
}

async function stopQueue() {
  activeRunId += 1;
  pauseRequested = false;
  await chrome.alarms.clear(DELAY_ALARM);
  const previous = await getQueueState();
  for (const item of previous.items) {
    if (item.status === "pending" || item.status === "posting") {
      item.status = "cancelled";
    }
  }
  const state = createIdleQueue();
  state.tabId = previous.tabId;
  state.lastError = previous.items.some((item) => item.status === "cancelled")
    ? "Đã dừng hàng đợi."
    : "";
  await persistAndBroadcast(state);
  return { ok: true, state };
}

async function runCurrentItem() {
  if (postingLock) {
    return;
  }
  const runId = activeRunId;
  postingLock = true;
  try {
    const state = await getQueueState();
    if (state.status !== "running") {
      return;
    }

    const item = state.items[state.currentIndex];
    if (!item) {
      await finishQueue(state);
      return;
    }

    item.status = "posting";
    item.error = "";
    state.lastError = "";
    await persistAndBroadcast(state);

    const tabId = await ensureGroupTab(state, item.url);
    if (runId !== activeRunId) {
      return;
    }
    await waitForContentScript(tabId);
    if (runId !== activeRunId) {
      return;
    }

    const imageRecords = await getImages(state.imageIds || []);
    if ((state.imageIds || []).length > 0 && imageRecords.length === 0) {
      throw new Error("Không đọc được ảnh đã chọn. Thêm lại ảnh rồi thử.");
    }
    const result = await requestPost(tabId, state.text, state.imageIds);
    if (runId !== activeRunId) {
      return;
    }

    if (result?.success) {
      item.status = "posted";
      await addHistory(historyEntry(state, item, "posted", ""));
      await persistAndBroadcast(state);
      await advanceOrFinish(state, { skipped: false });
      return;
    }

    const error = result?.error || "Không đăng được bài.";
    item.status = "failed";
    item.error = error;
    state.status = "paused";
    state.lastError = error;
    await addHistory(historyEntry(state, item, "failed", error));
    await persistAndBroadcast(state);
  } finally {
    postingLock = false;
  }
}

async function advanceOrFinish(state, { skipped }) {
  const nextIndex = state.items.findIndex(
    (item, index) => index > state.currentIndex && item.status === "pending"
  );

  if (nextIndex === -1) {
    return finishQueue(state);
  }

  state.currentIndex = nextIndex;
  if (pauseRequested) {
    pauseRequested = false;
    state.status = "paused";
    state.delayEndsAt = 0;
    state.lastError = "Đã tạm dừng. Nhấn Tiếp tục khi sẵn sàng.";
    await persistAndBroadcast(state);
    return { ok: true, state };
  }

  if (skipped) {
    state.status = "running";
    state.delayEndsAt = 0;
    await persistAndBroadcast(state);
    runCurrentItem().catch((error) => {
      pauseWithError(error.message || String(error));
    });
    return { ok: true, state };
  }

  state.status = "delaying";
  const waitSeconds = randomDelaySeconds(state);
  state.delaySeconds = waitSeconds;
  state.delayEndsAt = Date.now() + waitSeconds * 1000;
  await persistAndBroadcast(state);
  chrome.alarms.create(DELAY_ALARM, { when: state.delayEndsAt });
  return { ok: true, state };
}

function randomDelaySeconds(state) {
  const min = Number(state.delayMinSeconds);
  const max = Number(state.delayMaxSeconds);
  const low = Number.isFinite(min) ? min : 30;
  const high = Number.isFinite(max) ? max : Number(state.delaySeconds) || 60;
  const from = Math.min(low, high);
  const to = Math.max(low, high);
  return from + Math.floor(Math.random() * (to - from + 1));
}

async function continueAfterDelay() {
  const state = await getQueueState();
  if (state.status !== "delaying") {
    return;
  }
  state.status = "running";
  state.delayEndsAt = 0;
  await persistAndBroadcast(state);
  await runCurrentItem();
}

async function finishQueue(state) {
  await chrome.alarms.clear(DELAY_ALARM);
  const next = createIdleQueue();
  next.tabId = state.tabId;
  const posted = state.items.filter((item) => item.status === "posted").length;
  const failed = state.items.filter((item) => item.status === "failed").length;
  next.lastError = `Xong: ${posted} thành công, ${failed} lỗi, ${state.items.length} nhóm.`;
  await persistAndBroadcast(next);
  return { ok: true, state: next };
}

async function pauseWithError(error) {
  await chrome.alarms.clear(DELAY_ALARM);
  const state = await getQueueState();
  const item = state.items[state.currentIndex];
  if (item && item.status === "posting") {
    item.status = "failed";
    item.error = error;
    await addHistory(historyEntry(state, item, "failed", error));
  }
  state.status = "paused";
  state.lastError = error;
  state.delayEndsAt = 0;
  await persistAndBroadcast(state);
}

async function persistAndBroadcast(state) {
  await setQueueState(state);
  chrome.runtime.sendMessage({ type: "QUEUE_STATE", state }).catch(() => {});
}

function historyEntry(state, item, status, error) {
  return {
    jobId: state.jobId,
    groupId: item.groupId,
    groupName: item.groupName,
    textPreview: state.text.slice(0, 140),
    status,
    error,
    at: Date.now(),
  };
}

async function ensureGroupTab(state, url) {
  if (state.tabId) {
    try {
      const tab = await chrome.tabs.get(state.tabId);
      if (tab && /facebook\.com/.test(tab.url || "")) {
        await chrome.tabs.update(state.tabId, { url, active: true });
        await waitForTabReady(state.tabId, url);
        return state.tabId;
      }
    } catch {
      state.tabId = null;
    }
  }

  const tab = await chrome.tabs.create({ url, active: true });
  state.tabId = tab.id;
  await setQueueState(state);
  await waitForTabReady(tab.id, url);
  return tab.id;
}

function urlMatchesGroup(tabUrl, targetUrl) {
  const tabGroup = parseGroupUrl(tabUrl || "");
  const targetGroup = parseGroupUrl(targetUrl);
  return Boolean(tabGroup && targetGroup && tabGroup.slug === targetGroup.slug);
}

async function waitForTabReady(tabId, targetUrl) {
  const started = Date.now();
  while (Date.now() - started < TAB_WAIT_MS) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (urlMatchesGroup(tab.url, targetUrl)) {
        await sleep(1200);
        return;
      }
    } catch {
      throw new Error("Tab Facebook đã bị đóng.");
    }
    await sleep(350);
  }
  throw new Error("Hết thời gian chờ trang nhóm tải xong.");
}

async function waitForContentScript(tabId) {
  const started = Date.now();
  while (Date.now() - started < PING_WAIT_MS) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: "PING" });
      if (response?.ok) {
        return;
      }
    } catch {
      // Content script chưa gắn vào trang SPA.
    }
    await sleep(400);
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content/facebook-poster.js"],
  });

  const retryUntil = Date.now() + 8000;
  while (Date.now() < retryUntil) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: "PING" });
      if (response?.ok) {
        return;
      }
    } catch {
      // Chờ script vừa inject.
    }
    await sleep(300);
  }
  throw new Error("Không kết nối được content script trên tab Facebook.");
}

async function fillPageComposer(tabId, text) {
  if (!tabId) {
    return { ok: false, error: "Không có tab Facebook." };
  }
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: pageFillComposer,
    args: [text],
  });
  return injection?.result || { ok: false, error: "Không ghi được chữ vào composer." };
}

async function armPageFiles(tabId, images) {
  if (!tabId) {
    return { ok: false, error: "Không có tab Facebook." };
  }
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: pageInstallFileHook,
  });
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: pageSetPendingFiles,
    args: [images],
  });
  return injection?.result || { ok: false, error: "Không chuẩn bị được ảnh." };
}

async function disarmPageFiles(tabId) {
  if (!tabId) {
    return { ok: false, error: "Không có tab Facebook." };
  }
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: pageClearPendingFiles,
  });
  return injection?.result || { ok: true };
}

function pageFillComposer(text) {
  function isLexicalEditor(value) {
    return Boolean(
      value &&
        typeof value.getEditorState === "function" &&
        typeof value.setEditorState === "function" &&
        typeof value.parseEditorState === "function"
    );
  }

  function pickEditor(value, depth) {
    if (!value || depth > 4 || typeof value !== "object" || value instanceof Node) {
      return null;
    }
    if (isLexicalEditor(value)) {
      return value;
    }
    if (isLexicalEditor(value.editor)) {
      return value.editor;
    }
    if (isLexicalEditor(value.lexicalEditor)) {
      return value.lexicalEditor;
    }
    for (const key of ["editor", "lexicalEditor", "_editor", "current"]) {
      if (value[key]) {
        const found = pickEditor(value[key], depth + 1);
        if (found) {
          return found;
        }
      }
    }
    return null;
  }

  function findEditor(el) {
    if (!el) {
      return null;
    }
    let node = el;
    for (let i = 0; i < 8 && node; i += 1) {
      if (isLexicalEditor(node.__lexicalEditor)) {
        return node.__lexicalEditor;
      }
      for (const key of Object.getOwnPropertyNames(node)) {
        if (/lexical/i.test(key) && isLexicalEditor(node[key])) {
          return node[key];
        }
      }
      node = node.parentElement;
    }

    const fiberKey = Object.keys(el).find(
      (key) => key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$")
    );
    if (!fiberKey) {
      return null;
    }
    let fiber = el[fiberKey];
    for (let i = 0; i < 40 && fiber; i += 1) {
      const bags = [fiber.memoizedProps, fiber.pendingProps, fiber.stateNode];
      let hook = fiber.memoizedState;
      while (hook) {
        bags.push(hook.memoizedState);
        hook = hook.next;
      }
      for (const bag of bags) {
        const editor = pickEditor(bag, 0);
        if (editor) {
          return editor;
        }
      }
      fiber = fiber.return;
    }
    return null;
  }

  function findTextNode(node) {
    if (!node || typeof node !== "object") {
      return null;
    }
    if (typeof node.text === "string" && /text/i.test(node.type || "text")) {
      return node;
    }
    for (const child of node.children || []) {
      const found = findTextNode(child);
      if (found) {
        return found;
      }
    }
    return null;
  }

  function hasAllLines(el, value) {
    const actual = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
    const lines = value
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) {
      return true;
    }
    return actual.includes(lines[0].slice(0, 24)) && actual.includes(lines[lines.length - 1].slice(0, 24));
  }

  const dialogs = [...document.querySelectorAll('[role="dialog"]')];
  const textbox =
    dialogs
      .map((dialog) => {
        const nodes = [...dialog.querySelectorAll('[role="textbox"], [contenteditable="true"]')];
        return nodes.sort((a, b) => {
          const areaA = a.getBoundingClientRect();
          const areaB = b.getBoundingClientRect();
          return areaB.width * areaB.height - areaA.width * areaA.height;
        })[0];
      })
      .find(Boolean) || document.querySelector('[role="textbox"][contenteditable="true"]');

  if (!textbox) {
    return { ok: false, error: "no-textbox", hasAllLines: false };
  }

  textbox.focus();
  const editor = findEditor(textbox);
  if (editor) {
    try {
      const current = editor.getEditorState().toJSON();
      if (current?.root?.children) {
        const paragraphTemplate =
          current.root.children.find((node) => node.type === "paragraph") ||
          current.root.children[0] || {
            children: [],
            direction: "ltr",
            format: "",
            indent: 0,
            type: "paragraph",
            version: 1,
          };
        const textTemplate = findTextNode(paragraphTemplate) || {
          detail: 0,
          format: 0,
          mode: "normal",
          style: "",
          text: "",
          type: "text",
          version: 1,
        };
        current.root.children = String(text)
          .replace(/\r\n/g, "\n")
          .replace(/\r/g, "\n")
          .split("\n")
          .map((line) => {
            const paragraph = JSON.parse(JSON.stringify(paragraphTemplate));
            const textNode = JSON.parse(JSON.stringify(textTemplate));
            textNode.text = line;
            paragraph.children = line ? [textNode] : [];
            return paragraph;
          });
        editor.setEditorState(editor.parseEditorState(JSON.stringify(current)));
        textbox.dispatchEvent(
          new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText" })
        );
      }
    } catch (error) {
      return { ok: false, error: String(error), hasAllLines: false, foundEditor: true };
    }
  }

  return {
    ok: true,
    foundEditor: Boolean(editor),
    hasAllLines: hasAllLines(textbox, text),
  };
}

function pageInstallFileHook() {
  if (window.__mpfFileHookVersion === 2) {
    return { ok: true, already: true };
  }

  const proto = HTMLInputElement.prototype;
  if (!window.__mpfNativeInputClick) {
    window.__mpfNativeInputClick = proto.click;
    window.__mpfNativeShowPicker = proto.showPicker;
  } else {
    proto.click = window.__mpfNativeInputClick;
    if (typeof window.__mpfNativeShowPicker === "function") {
      proto.showPicker = window.__mpfNativeShowPicker;
    }
  }

  window.__mpfMainFileHook = true;
  window.__mpfFileHookVersion = 2;
  window.__mpfPendingFiles = window.__mpfPendingFiles || null;

  const originalClick = window.__mpfNativeInputClick;
  const originalShowPicker = window.__mpfNativeShowPicker;

  const isComposerInput = (input) => {
    if (!input || input.closest('[role="article"], [role="feed"]')) {
      return false;
    }
    const dialog = input.closest('[role="dialog"]');
    if (dialog) {
      return Boolean(dialog.querySelector('[role="textbox"], [contenteditable="true"]'));
    }
    return !input.closest('[role="main"]');
  };

  const assign = (input) => {
    const pending = window.__mpfPendingFiles;
    if (!pending || !pending.length || !isComposerInput(input)) {
      return false;
    }
    const dt = new DataTransfer();
    for (const file of pending) {
      dt.items.add(file);
    }
    try {
      input.files = dt.files;
    } catch {
      return false;
    }
    if (!input.files.length) {
      return false;
    }
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  };

  proto.click = function () {
    if (this.type === "file" && assign(this)) {
      return;
    }
    return originalClick.apply(this, arguments);
  };

  if (typeof originalShowPicker === "function") {
    proto.showPicker = function () {
      if (this.type === "file" && assign(this)) {
        return;
      }
      return originalShowPicker.apply(this, arguments);
    };
  }

  return { ok: true, already: false };
}

function pageClearPendingFiles() {
  window.__mpfPendingFiles = null;
  return { ok: true };
}

function pageSetPendingFiles(payloads) {
  window.__mpfPendingFiles = (payloads || []).map((item) => {
    const binary = atob(item.dataBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new File([bytes], item.name || "image.jpg", {
      type: item.mime || "image/jpeg",
    });
  });
  return { ok: true, count: window.__mpfPendingFiles.length };
}

async function getPostImage(imageId) {
  const records = await getImages(imageId ? [imageId] : []);
  const record = records[0];
  if (!record?.blob) {
    return { ok: false, error: "Không tìm thấy ảnh." };
  }
  return {
    ok: true,
    image: {
      name: record.name,
      mime: record.mime,
      dataBase64: await blobToBase64(record.blob),
    },
  };
}

function requestPost(tabId, text, imageIds) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      resolve({ success: false, error: "Hết thời gian chờ Facebook xử lý bài đăng." });
    }, POST_TIMEOUT_MS);

    chrome.tabs.sendMessage(
      tabId,
      { type: "POST_TO_GROUP", text, imageIds: imageIds || [] },
      (response) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(response || { success: false, error: "Không nhận được phản hồi từ trang." });
      }
    );
  });
}

async function getCurrentGroupFromTab() {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const facebookTabs = tabs.filter((tab) => /facebook\.com\/groups\//.test(tab.url || ""));
  const tab =
    facebookTabs.find((item) => item.active) ||
    facebookTabs[0] ||
    (await chrome.tabs.query({ url: "*://*.facebook.com/groups/*" }))[0];

  if (!tab?.url) {
    return { ok: false, error: "Không tìm thấy tab nhóm Facebook." };
  }

  const parsed = parseGroupUrl(tab.url);
  if (!parsed) {
    return { ok: false, error: "Tab hiện tại không phải trang một nhóm." };
  }

  let name = parsed.slug;
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const heading = document.querySelector("h1");
        return (heading?.innerText || document.title || "").trim();
      },
    });
    if (injection?.result) {
      name = injection.result.replace(/\s*\|\s*Facebook\s*$/i, "").trim() || name;
    }
  } catch {
    // Giữ slug nếu không đọc được tiêu đề trang.
  }

  return {
    ok: true,
    group: {
      id: createGroupId(parsed.slug),
      name,
      url: parsed.url,
      addedAt: Date.now(),
    },
  };
}

async function scanJoinedGroups() {
  const queue = await getQueueState();
  if (queue.status === "running" || queue.status === "delaying") {
    return { ok: false, error: "Đang đăng bài. Dừng hàng đợi trước khi quét nhóm." };
  }
  if (scanning) {
    return { ok: false, error: "Đang quét nhóm, vui lòng đợi." };
  }

  scanning = true;
  broadcastScan({ status: "running", found: 0, message: "Đang mở danh sách nhóm đã tham gia…" });

  try {
    const tabId = await ensureFacebookDirectoryTab(queue.tabId);
    if (queue.tabId !== tabId) {
      queue.tabId = tabId;
      await setQueueState(queue);
    }

    await waitForContentScript(tabId);
    broadcastScan({ status: "running", found: 0, message: "Đang cuộn và thu thập nhóm…" });

    const result = await requestScan(tabId);
    if (!result?.success) {
      const error = result?.error || "Không quét được danh sách nhóm.";
      broadcastScan({ status: "idle", found: 0, message: error });
      return { ok: false, error };
    }

    const existing = await getGroups();
    const merged = mergeScannedGroups(existing, result.groups || []);
    await saveGroups(merged.groups);

    const message = `Quét xong: thêm ${merged.added} nhóm mới, ${merged.skipped} đã có, tổng ${merged.groups.length}.`;
    broadcastScan({
      status: "done",
      found: merged.groups.length,
      added: merged.added,
      skipped: merged.skipped,
      addedIds: merged.addedIds,
      message,
    });
    return {
      ok: true,
      added: merged.added,
      skipped: merged.skipped,
      total: merged.groups.length,
      addedIds: merged.addedIds,
      message,
    };
  } catch (error) {
    const message = error.message || String(error);
    broadcastScan({ status: "idle", found: 0, message });
    return { ok: false, error: message };
  } finally {
    scanning = false;
  }
}

async function ensureFacebookDirectoryTab(existingTabId) {
  if (existingTabId) {
    try {
      const tab = await chrome.tabs.get(existingTabId);
      if (tab && /facebook\.com/.test(tab.url || "")) {
        await chrome.tabs.update(existingTabId, { url: JOINS_URL, active: true });
        await waitForTabMatch(existingTabId, isGroupsDirectoryUrl);
        return existingTabId;
      }
    } catch {
      // Mở tab mới nếu tab cũ đã đóng.
    }
  }

  const existing = await chrome.tabs.query({ url: "*://*.facebook.com/*" });
  const reusable = existing[0];
  if (reusable?.id) {
    await chrome.tabs.update(reusable.id, { url: JOINS_URL, active: true });
    await waitForTabMatch(reusable.id, isGroupsDirectoryUrl);
    return reusable.id;
  }

  const tab = await chrome.tabs.create({ url: JOINS_URL, active: true });
  await waitForTabMatch(tab.id, isGroupsDirectoryUrl);
  return tab.id;
}

async function waitForTabMatch(tabId, matchFn) {
  const started = Date.now();
  while (Date.now() - started < TAB_WAIT_MS) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (matchFn(tab.url || "")) {
        await sleep(1500);
        return;
      }
    } catch {
      throw new Error("Tab Facebook đã bị đóng.");
    }
    await sleep(350);
  }
  throw new Error("Hết thời gian chờ trang danh sách nhóm.");
}

function requestScan(tabId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      resolve({ success: false, error: "Hết thời gian quét danh sách nhóm." });
    }, SCAN_TIMEOUT_MS);

    chrome.tabs.sendMessage(tabId, { type: "SCAN_JOINED_GROUPS" }, (response) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response || { success: false, error: "Không nhận được danh sách nhóm." });
    });
  });
}

function mergeScannedGroups(existing, scanned) {
  const bySlug = new Map();
  for (const group of existing) {
    const parsed = parseGroupUrl(group.url);
    bySlug.set((parsed?.slug || group.id).toLowerCase(), group);
  }

  let added = 0;
  let skipped = 0;
  const addedIds = [];
  const now = Date.now();

  for (const item of scanned) {
    const slug = String(item.slug || "").toLowerCase();
    if (!slug) {
      continue;
    }
    const current = bySlug.get(slug);
    if (current) {
      skipped += 1;
      if (current.name === slug || current.name === current.id.replace(/^grp_/, "")) {
        current.name = item.name || current.name;
      }
      continue;
    }

    const group = {
      id: createGroupId(slug),
      name: item.name || slug,
      url: item.url || `https://www.facebook.com/groups/${encodeURIComponent(slug)}/`,
      addedAt: now,
    };
    bySlug.set(slug, group);
    addedIds.push(group.id);
    added += 1;
  }

  return {
    groups: [...bySlug.values()],
    added,
    skipped,
    addedIds,
  };
}

function broadcastScan(payload) {
  chrome.runtime.sendMessage({ type: "SCAN_STATE", ...payload }).catch(() => {});
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
