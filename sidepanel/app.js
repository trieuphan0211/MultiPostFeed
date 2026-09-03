import {
  deleteGroup,
  deleteImages,
  getDraft,
  getGroups,
  getHistory,
  getImage,
  getQueueState,
  getSettings,
  putImage,
  saveDraft,
  saveGroup,
  saveSettings,
} from "../lib/storage.js";
import { createGroupId, parseGroupUrl, sameGroup } from "../lib/groups.js";

const els = {
  statusPill: document.getElementById("statusPill"),
  statusBar: document.getElementById("statusBar"),
  progressLabel: document.getElementById("progressLabel"),
  delayLabel: document.getElementById("delayLabel"),
  errorLabel: document.getElementById("errorLabel"),
  postText: document.getElementById("postText"),
  draftMeta: document.getElementById("draftMeta"),
  imageInput: document.getElementById("imageInput"),
  imageList: document.getElementById("imageList"),
  clearImagesBtn: document.getElementById("clearImagesBtn"),
  groupUrlInput: document.getElementById("groupUrlInput"),
  groupNameInput: document.getElementById("groupNameInput"),
  addUrlBtn: document.getElementById("addUrlBtn"),
  addCurrentBtn: document.getElementById("addCurrentBtn"),
  scanGroupsBtn: document.getElementById("scanGroupsBtn"),
  selectAllBtn: document.getElementById("selectAllBtn"),
  groupList: document.getElementById("groupList"),
  groupEmpty: document.getElementById("groupEmpty"),
  delayMinInput: document.getElementById("delayMinInput"),
  delayMaxInput: document.getElementById("delayMaxInput"),
  startBtn: document.getElementById("startBtn"),
  pauseBtn: document.getElementById("pauseBtn"),
  resumeBtn: document.getElementById("resumeBtn"),
  skipBtn: document.getElementById("skipBtn"),
  stopBtn: document.getElementById("stopBtn"),
  queueList: document.getElementById("queueList"),
  historyList: document.getElementById("historyList"),
  historyEmpty: document.getElementById("historyEmpty"),
  clearHistoryBtn: document.getElementById("clearHistoryBtn"),
};

const STATUS_LABEL = {
  idle: "Sẵn sàng",
  running: "Đang đăng",
  delaying: "Đang chờ",
  paused: "Tạm dừng",
};

const ITEM_LABEL = {
  pending: "Chờ",
  posting: "Đang đăng",
  posted: "Xong",
  failed: "Lỗi",
  skipped: "Bỏ qua",
  cancelled: "Hủy",
};

let groups = [];
let selectedIds = new Set();
let imageIds = [];
let queueState = null;
let countdownTimer = null;
const objectUrls = new Map();

init().catch((error) => {
  showError(error.message || String(error));
});

async function init() {
  const [draft, settings, history, state] = await Promise.all([
    getDraft(),
    getSettings(),
    getHistory(),
    getQueueState(),
  ]);

  groups = await getGroups();
  imageIds = draft.imageIds || [];
  els.postText.value = draft.text || "";
  els.delayMinInput.value = String(settings.delayMinSeconds);
  els.delayMaxInput.value = String(settings.delayMaxSeconds);
  renderGroups();
  await renderImages();
  updateDraftMeta();
  renderHistory(history);
  applyQueueState(state);

  els.postText.addEventListener("input", onDraftChange);
  els.imageInput.addEventListener("change", onImagesPicked);
  els.clearImagesBtn.addEventListener("click", clearImages);
  els.addUrlBtn.addEventListener("click", addGroupFromUrl);
  els.addCurrentBtn.addEventListener("click", addCurrentGroup);
  els.scanGroupsBtn.addEventListener("click", scanJoinedGroups);
  els.selectAllBtn.addEventListener("click", toggleSelectAll);
  els.delayMinInput.addEventListener("change", onDelayChange);
  els.delayMaxInput.addEventListener("change", onDelayChange);
  els.startBtn.addEventListener("click", startQueue);
  els.pauseBtn.addEventListener("click", () => send("PAUSE_QUEUE"));
  els.resumeBtn.addEventListener("click", () => send("RESUME_QUEUE"));
  els.skipBtn.addEventListener("click", () => send("SKIP_CURRENT"));
  els.stopBtn.addEventListener("click", () => send("STOP_QUEUE"));
  els.clearHistoryBtn.addEventListener("click", clearHistory);

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "QUEUE_STATE") {
      applyQueueState(message.state);
    }
    if (message.type === "SCAN_STATE" || message.type === "SCAN_PROGRESS") {
      applyScanState(message);
    }
  });
}

function applyQueueState(state) {
  queueState = state;
  const busy = state.status === "running" || state.status === "delaying";
  const paused = state.status === "paused";

  els.statusPill.textContent = STATUS_LABEL[state.status] || state.status;
  els.statusPill.className = `pill pill-${state.status}`;
  els.statusBar.hidden = state.status === "idle" && !state.lastError && state.items.length === 0;

  const done = state.items.filter((item) => item.status !== "pending" && item.status !== "posting").length;
  els.progressLabel.textContent = state.items.length
    ? `${done} / ${state.items.length}`
    : "0 / 0";

  if (state.lastError) {
    const isInfo = /^(Xong:|Đã dừng|Đã tạm dừng|Sẽ tạm dừng)/.test(state.lastError);
    els.errorLabel.hidden = false;
    els.errorLabel.classList.toggle("is-info", isInfo);
    els.errorLabel.textContent = state.lastError;
  } else {
    els.errorLabel.hidden = true;
    els.errorLabel.classList.remove("is-info");
    els.errorLabel.textContent = "";
  }

  els.startBtn.hidden = busy || paused;
  els.pauseBtn.hidden = !busy;
  els.resumeBtn.hidden = !paused;
  els.skipBtn.hidden = !(busy || paused);
  els.stopBtn.hidden = !(busy || paused);

  const lockForm = busy || paused;
  els.postText.disabled = lockForm;
  els.imageInput.disabled = lockForm;
  els.delayMinInput.disabled = busy;
  els.delayMaxInput.disabled = busy;
  els.addUrlBtn.disabled = lockForm;
  els.addCurrentBtn.disabled = lockForm;
  els.scanGroupsBtn.disabled = lockForm || els.scanGroupsBtn.dataset.busy === "1";

  renderQueue(state.items);
  startCountdown(state);
  getHistory().then(renderHistory);
}

function startCountdown(state) {
  clearInterval(countdownTimer);
  if (state.status !== "delaying" || !state.delayEndsAt) {
    els.delayLabel.textContent = "";
    return;
  }

  const tick = () => {
    const remain = Math.max(0, Math.ceil((state.delayEndsAt - Date.now()) / 1000));
    els.delayLabel.textContent = remain > 0 ? `Nhóm tiếp theo sau ${remain}s` : "Đang chuyển nhóm…";
  };
  tick();
  countdownTimer = setInterval(tick, 500);
}

function renderGroups() {
  els.groupList.innerHTML = "";
  els.groupEmpty.hidden = groups.length > 0;
  for (const group of groups) {
    const item = document.createElement("li");
    item.className = "group-item";
    item.innerHTML = `
      <label>
        <input type="checkbox" data-id="${group.id}" ${selectedIds.has(group.id) ? "checked" : ""} />
        <span>
          <strong></strong>
          <small></small>
        </span>
      </label>
      <button type="button" class="ghost" data-remove="${group.id}">Xóa</button>
    `;
    item.querySelector("strong").textContent = group.name;
    item.querySelector("small").textContent = group.url;
    item.querySelector("input").addEventListener("change", (event) => {
      if (event.target.checked) {
        selectedIds.add(group.id);
      } else {
        selectedIds.delete(group.id);
      }
    });
    item.querySelector("[data-remove]").addEventListener("click", () => removeGroup(group.id));
    els.groupList.appendChild(item);
  }
}

function renderQueue(items) {
  els.queueList.innerHTML = "";
  for (const item of items) {
    const li = document.createElement("li");
    li.className = "history-item";
    li.innerHTML = `
      <div>
        <strong></strong>
        <small></small>
      </div>
      <span class="badge badge-${item.status}"></span>
    `;
    li.querySelector("strong").textContent = item.groupName;
    li.querySelector("small").textContent = item.error || item.url;
    li.querySelector(".badge").textContent = ITEM_LABEL[item.status] || item.status;
    els.queueList.appendChild(li);
  }
}

function renderHistory(history) {
  els.historyList.innerHTML = "";
  els.historyEmpty.hidden = history.length > 0 || (queueState?.items || []).length > 0;
  for (const entry of history) {
    const li = document.createElement("li");
    li.className = "history-item";
    li.innerHTML = `
      <div>
        <strong></strong>
        <small></small>
      </div>
      <span class="badge badge-${entry.status}"></span>
    `;
    li.querySelector("strong").textContent = entry.groupName;
    li.querySelector("small").textContent = formatHistory(entry);
    li.querySelector(".badge").textContent = ITEM_LABEL[entry.status] || entry.status;
    els.historyList.appendChild(li);
  }
}

function formatHistory(entry) {
  const time = new Date(entry.at).toLocaleString("vi-VN");
  const preview = entry.textPreview ? ` — ${entry.textPreview}` : "";
  const error = entry.error ? ` — ${entry.error}` : "";
  return `${time}${preview}${error}`;
}

async function renderImages() {
  els.imageList.innerHTML = "";
  els.imageList.hidden = imageIds.length === 0;
  els.clearImagesBtn.hidden = imageIds.length === 0;

  for (const id of imageIds) {
    const record = await getImage(id);
    if (!record) {
      continue;
    }
    revokeUrl(id);
    const url = URL.createObjectURL(record.blob);
    objectUrls.set(id, url);

    const wrap = document.createElement("div");
    wrap.className = "thumb";
    wrap.innerHTML = `<img alt="" /><button type="button" aria-label="Xóa ảnh">×</button>`;
    wrap.querySelector("img").src = url;
    wrap.querySelector("button").addEventListener("click", () => removeImage(id));
    els.imageList.appendChild(wrap);
  }
}

function updateDraftMeta() {
  const chars = els.postText.value.trim().length;
  els.draftMeta.textContent = `${chars} chữ · ${imageIds.length} ảnh`;
}

async function onDraftChange() {
  updateDraftMeta();
  await saveDraft({ text: els.postText.value, imageIds });
}

async function onImagesPicked(event) {
  const files = [...event.target.files];
  event.target.value = "";
  if (imageIds.length + files.length > 10) {
    showError("Tối đa 10 ảnh mỗi bài.");
    return;
  }

  for (const file of files) {
    if (file.size > 8 * 1024 * 1024) {
      showError(`Ảnh ${file.name} vượt 8MB.`);
      continue;
    }
    const blob = await normalizeImage(file).catch(() => file);
    const id = `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await putImage({
      id,
      name: file.name.replace(/\.[^.]+$/, "") + ".jpg",
      mime: "image/jpeg",
      blob,
      createdAt: Date.now(),
    });
    imageIds.push(id);
  }
  await saveDraft({ text: els.postText.value, imageIds });
  await renderImages();
  updateDraftMeta();
}

async function removeImage(id) {
  imageIds = imageIds.filter((item) => item !== id);
  await deleteImages([id]);
  revokeUrl(id);
  await saveDraft({ text: els.postText.value, imageIds });
  await renderImages();
  updateDraftMeta();
}

async function clearImages() {
  await deleteImages(imageIds);
  imageIds.forEach(revokeUrl);
  imageIds = [];
  await saveDraft({ text: els.postText.value, imageIds });
  await renderImages();
  updateDraftMeta();
}

async function addGroupFromUrl() {
  const parsed = parseGroupUrl(els.groupUrlInput.value);
  if (!parsed) {
    showNotice("URL không phải trang nhóm Facebook hợp lệ.");
    return;
  }
  await upsertGroup({
    id: createGroupId(parsed.slug),
    name: els.groupNameInput.value.trim() || parsed.slug,
    url: parsed.url,
    addedAt: Date.now(),
  });
  els.groupUrlInput.value = "";
  els.groupNameInput.value = "";
}

async function addCurrentGroup() {
  const response = await send("GET_CURRENT_GROUP");
  if (!response?.ok) {
    showNotice(response?.error || "Không đọc được nhóm hiện tại.");
    return;
  }
  await upsertGroup(response.group);
}

async function scanJoinedGroups() {
  setScanBusy(true);
  showNotice("Đang quét nhóm đã tham gia trên Facebook…", true);
  const response = await send("SCAN_JOINED_GROUPS");
  setScanBusy(false);
  if (!response?.ok) {
    showNotice(response?.error || "Không quét được danh sách nhóm.");
    return;
  }
  groups = await getGroups();
  for (const id of response.addedIds || []) {
    selectedIds.add(id);
  }
  renderGroups();
  showNotice(response.message, true);
}

function applyScanState(message) {
  if (message.type === "SCAN_PROGRESS" && typeof message.found === "number") {
    showNotice(`Đã thấy ${message.found} nhóm, đang cuộn thêm…`, true);
    setScanBusy(true);
    return;
  }
  if (typeof message.found === "number" && message.status === "running") {
    showNotice(`Đã thấy ${message.found} nhóm, đang cuộn thêm…`, true);
    setScanBusy(true);
    return;
  }
  if (message.message && message.status === "running") {
    showNotice(message.message, true);
    setScanBusy(true);
    return;
  }
  if (message.status === "done") {
    setScanBusy(false);
    getGroups().then((next) => {
      groups = next;
      for (const id of message.addedIds || []) {
        selectedIds.add(id);
      }
      renderGroups();
    });
    showNotice(message.message || "Đã quét xong.", true);
  }
}

function setScanBusy(busy) {
  els.scanGroupsBtn.dataset.busy = busy ? "1" : "";
  els.scanGroupsBtn.disabled = busy;
  els.scanGroupsBtn.textContent = busy ? "Đang quét…" : "Quét nhóm đã tham gia";
}

async function upsertGroup(group) {
  const duplicate = groups.find((item) => sameGroup(item.url, group.url));
  if (duplicate) {
    showNotice("Nhóm này đã có trong danh sách.");
    selectedIds.add(duplicate.id);
    renderGroups();
    return;
  }
  groups = await saveGroup(group);
  selectedIds.add(group.id);
  renderGroups();
  showNotice("");
}

async function removeGroup(groupId) {
  groups = await deleteGroup(groupId);
  selectedIds.delete(groupId);
  renderGroups();
}

function toggleSelectAll() {
  if (selectedIds.size === groups.length && groups.length > 0) {
    selectedIds.clear();
  } else {
    selectedIds = new Set(groups.map((group) => group.id));
  }
  renderGroups();
}

async function onDelayChange() {
  const saved = await saveSettings({
    delayMinSeconds: Number(els.delayMinInput.value),
    delayMaxSeconds: Number(els.delayMaxInput.value),
  });
  els.delayMinInput.value = String(saved.delayMinSeconds);
  els.delayMaxInput.value = String(saved.delayMaxSeconds);
}

async function startQueue() {
  const response = await send("START_QUEUE", {
    groupIds: [...selectedIds],
    text: els.postText.value,
    imageIds,
  });
  if (!response?.ok) {
    showError(response?.error || "Không bắt đầu được hàng đợi.");
    return;
  }
  applyQueueState(response.state);
}

async function clearHistory() {
  await chrome.storage.local.set({ mpf_history: [] });
  renderHistory([]);
}

function showError(message) {
  showNotice(message, false);
}

function showNotice(message, isInfo = false) {
  els.statusBar.hidden = !message && (queueState?.status === "idle") && !(queueState?.items || []).length;
  els.errorLabel.hidden = !message;
  els.errorLabel.classList.toggle("is-info", Boolean(isInfo && message));
  els.errorLabel.textContent = message || "";
}

function revokeUrl(id) {
  const url = objectUrls.get(id);
  if (url) {
    URL.revokeObjectURL(url);
    objectUrls.delete(id);
  }
}

function send(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload });
}

async function normalizeImage(file) {
  const bitmap = await createImageBitmap(file);
  const maxEdge = 1600;
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return canvas.convertToBlob({ type: "image/jpeg", quality: 0.82 });
}
