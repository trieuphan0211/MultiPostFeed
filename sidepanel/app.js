import {
  deleteGroup,
  deleteHistory,
  deleteImages,
  getDraft,
  getGroups,
  getHistory,
  getImage,
  getQueueState,
  getSettings,
  historyEntryId,
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
  groupCount: document.getElementById("groupCount"),
  groupFilterInput: document.getElementById("groupFilterInput"),
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
  failedPanel: document.getElementById("failedPanel"),
  failedList: document.getElementById("failedList"),
  retryFailedBtn: document.getElementById("retryFailedBtn"),
  historyFilterInput: document.getElementById("historyFilterInput"),
  historyStatusFilter: document.getElementById("historyStatusFilter"),
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
let groupFilter = "";
let imageIds = [];
let historyEntries = [];
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
  selectedIds = new Set((draft.selectedGroupIds || []).map(String));
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
  els.groupFilterInput.addEventListener("input", onGroupFilterChange);
  els.selectAllBtn.addEventListener("click", toggleSelectAll);
  els.delayMinInput.addEventListener("change", onDelayChange);
  els.delayMaxInput.addEventListener("change", onDelayChange);
  els.startBtn.addEventListener("click", startQueue);
  els.pauseBtn.addEventListener("click", () => send("PAUSE_QUEUE"));
  els.resumeBtn.addEventListener("click", () => send("RESUME_QUEUE"));
  els.skipBtn.addEventListener("click", () => send("SKIP_CURRENT"));
  els.stopBtn.addEventListener("click", () => send("STOP_QUEUE"));
  els.clearHistoryBtn.addEventListener("click", clearHistory);
  els.retryFailedBtn.addEventListener("click", retryFailedGroups);
  els.historyFilterInput.addEventListener("input", () => renderHistory(historyEntries));
  els.historyStatusFilter.addEventListener("change", () => renderHistory(historyEntries));

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
    const isInfo = /^(Xong:|Đã dừng|Đã tạm dừng|Sẽ tạm dừng|Bỏ qua)/.test(state.lastError);
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
  renderFailed(state.items);
  startCountdown(state);
  getHistory().then(renderHistory);
  updateStartButton();
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

function filteredGroups() {
  const query = groupFilter.trim().toLowerCase();
  if (!query) {
    return groups;
  }
  return groups.filter((group) => {
    const name = String(group.name || "").toLowerCase();
    const url = String(group.url || "").toLowerCase();
    return name.includes(query) || url.includes(query);
  });
}

function renderGroups() {
  const visible = filteredGroups();
  els.groupList.innerHTML = "";

  if (groups.length === 0) {
    els.groupEmpty.hidden = false;
    els.groupEmpty.textContent = "Chưa có nhóm. Bấm Quét nhóm đã tham gia hoặc dán URL.";
  } else if (visible.length === 0) {
    els.groupEmpty.hidden = false;
    els.groupEmpty.textContent = "Không có nhóm khớp bộ lọc.";
  } else {
    els.groupEmpty.hidden = true;
  }

  for (const group of visible) {
    const item = document.createElement("li");
    item.className = "group-item";
    item.innerHTML = `
      <label>
        <input type="checkbox" data-id="${group.id}" ${selectedIds.has(String(group.id)) ? "checked" : ""} />
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
      const id = String(group.id);
      if (event.target.checked) {
        selectedIds.add(id);
      } else {
        selectedIds.delete(id);
      }
      updateGroupSelectionUi();
      persistSelection();
    });
    item.querySelector("[data-remove]").addEventListener("click", () => removeGroup(group.id));
    els.groupList.appendChild(item);
  }

  updateGroupSelectionUi();
}

function updateGroupSelectionUi() {
  const visible = filteredGroups();
  const selectedVisible = visible.filter((group) => selectedIds.has(String(group.id))).length;
  const filtering = Boolean(groupFilter.trim());
  const allVisibleSelected = visible.length > 0 && selectedVisible === visible.length;

  els.groupCount.textContent = filtering
    ? `Đã chọn ${selectedIds.size} / ${groups.length} · Hiện ${visible.length}`
    : `Đã chọn ${selectedIds.size} / ${groups.length}`;

  els.selectAllBtn.disabled = visible.length === 0;
  if (filtering) {
    els.selectAllBtn.textContent = allVisibleSelected ? "Bỏ chọn đang hiện" : "Chọn đang hiện";
  } else {
    els.selectAllBtn.textContent = allVisibleSelected ? "Bỏ chọn tất cả" : "Chọn tất cả";
  }
  updateStartButton();
}

function onGroupFilterChange(event) {
  groupFilter = event.target.value;
  renderGroups();
}

function renderFailed(items) {
  const failed = (items || []).filter((item) => item.status === "failed");
  els.failedList.innerHTML = "";
  els.failedPanel.hidden = failed.length === 0;
  const busy =
    queueState?.status === "running" ||
    queueState?.status === "delaying" ||
    queueState?.status === "paused";
  els.retryFailedBtn.disabled = busy || failed.length === 0;

  for (const item of failed) {
    const li = document.createElement("li");
    li.className = "history-item";
    li.innerHTML = `
      <div>
        <strong></strong>
        <small></small>
      </div>
      <span class="badge badge-failed"></span>
    `;
    li.querySelector("strong").textContent = item.groupName;
    li.querySelector("small").textContent = item.error || item.url || "";
    li.querySelector(".badge").textContent = ITEM_LABEL.failed;
    els.failedList.appendChild(li);
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
  historyEntries = Array.isArray(history) ? history : [];
  const query = normalizeFilter(els.historyFilterInput?.value);
  const status = els.historyStatusFilter?.value || "";
  const visible = historyEntries.filter((entry) => {
    if (status && entry.status !== status) {
      return false;
    }
    if (!query) {
      return true;
    }
    const haystack = normalizeFilter(`${entry.groupName || ""} ${entry.textPreview || ""} ${entry.error || ""}`);
    return haystack.includes(query);
  });

  els.historyList.innerHTML = "";
  els.historyEmpty.hidden = historyEntries.length > 0 || (queueState?.items || []).length > 0;
  for (const entry of visible) {
    const li = document.createElement("li");
    li.className = "history-item";
    li.innerHTML = `
      <div>
        <strong></strong>
        <small></small>
        <div class="history-actions"></div>
      </div>
      <span class="badge badge-${entry.status}"></span>
    `;
    li.querySelector("strong").textContent = entry.groupName;
    li.querySelector("small").textContent = formatHistory(entry);
    li.querySelector(".badge").textContent = ITEM_LABEL[entry.status] || entry.status;

    const actions = li.querySelector(".history-actions");
    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "ghost";
    openBtn.textContent = "Mở";
    openBtn.addEventListener("click", () => openHistory(entry));
    actions.appendChild(openBtn);

    if (entry.groupId) {
      const busy =
        queueState?.status === "running" ||
        queueState?.status === "delaying" ||
        queueState?.status === "paused";
      const repostBtn = document.createElement("button");
      repostBtn.type = "button";
      repostBtn.className = "ghost";
      repostBtn.textContent = "Đăng lại";
      repostBtn.disabled = busy;
      repostBtn.addEventListener("click", () => repostHistory(entry));
      actions.appendChild(repostBtn);
    }

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "ghost";
    removeBtn.textContent = "Xóa";
    removeBtn.addEventListener("click", () => removeHistory(entry));
    actions.appendChild(removeBtn);

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
  persistSelection();
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
      persistSelection();
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
    persistSelection();
    return;
  }
  groups = await saveGroup(group);
  selectedIds.add(group.id);
  renderGroups();
  persistSelection();
  showNotice("");
}

async function removeGroup(groupId) {
  groups = await deleteGroup(groupId);
  selectedIds.delete(String(groupId));
  renderGroups();
  persistSelection();
}

function toggleSelectAll() {
  const visible = filteredGroups();
  if (visible.length === 0) {
    return;
  }

  const allVisibleSelected = visible.every((group) => selectedIds.has(String(group.id)));
  for (const group of visible) {
    const id = String(group.id);
    if (allVisibleSelected) {
      selectedIds.delete(id);
    } else {
      selectedIds.add(id);
    }
  }

  renderGroups();
  persistSelection();
}

async function onDelayChange() {
  const saved = await saveSettings({
    delayMinSeconds: Number(els.delayMinInput.value),
    delayMaxSeconds: Number(els.delayMaxInput.value),
  });
  els.delayMinInput.value = String(saved.delayMinSeconds);
  els.delayMaxInput.value = String(saved.delayMaxSeconds);
}

async function persistSelection() {
  await saveDraft({
    text: els.postText.value,
    imageIds,
    selectedGroupIds: [...selectedIds],
  });
}

function updateStartButton() {
  const n = selectedIds.size;
  els.startBtn.textContent = n > 0 ? `Bắt đầu đăng (${n})` : "Bắt đầu đăng";
}

function normalizeFilter(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/\s+/g, " ")
    .trim();
}

async function startQueue() {
  const count = selectedIds.size;
  if (count >= 10 && !window.confirm(`Đăng ${count} nhóm với nội dung hiện tại?`)) {
    return;
  }
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

async function retryFailedGroups() {
  const failed = (queueState?.items || []).filter((item) => item.status === "failed" && item.groupId);
  if (failed.length === 0) {
    showNotice("Không có nhóm lỗi để đăng lại.");
    return;
  }
  selectedIds = new Set(failed.map((item) => String(item.groupId)));
  renderGroups();
  persistSelection();
  const response = await send("START_QUEUE", {
    groupIds: [...selectedIds],
    text: els.postText.value,
    imageIds,
  });
  if (!response?.ok) {
    showError(response?.error || "Không đăng lại được các nhóm lỗi.");
    return;
  }
  applyQueueState(response.state);
}

async function openHistory(entry) {
  const target = entry.postUrl || entry.url;
  if (!target) {
    showNotice("Không có URL bài hoặc nhóm để mở.");
    return;
  }
  await chrome.tabs.create({ url: target, active: true });
}

async function repostHistory(entry) {
  if (!entry.groupId) {
    showNotice("Không xác định được nhóm để đăng lại.");
    return;
  }
  selectedIds = new Set([String(entry.groupId)]);
  renderGroups();
  persistSelection();
  const response = await send("START_QUEUE", {
    groupIds: [entry.groupId],
    text: els.postText.value,
    imageIds,
  });
  if (!response?.ok) {
    showError(response?.error || "Không đăng lại được nhóm này.");
    return;
  }
  applyQueueState(response.state);
}

async function removeHistory(entry) {
  const next = await deleteHistory(historyEntryId(entry));
  renderHistory(next);
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
