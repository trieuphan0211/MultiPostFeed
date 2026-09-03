const KEYS = {
  groups: "mpf_groups",
  settings: "mpf_settings",
  draft: "mpf_draft",
  history: "mpf_history",
  queue: "mpf_queue",
};

const IMAGE_DB = "multipostfeed";
const IMAGE_STORE = "images";
const HISTORY_LIMIT = 50;

export const DEFAULT_SETTINGS = {
  delaySeconds: 45,
};

export function createIdleQueue() {
  return {
    status: "idle",
    jobId: null,
    items: [],
    currentIndex: -1,
    delaySeconds: DEFAULT_SETTINGS.delaySeconds,
    delayEndsAt: 0,
    lastError: "",
    text: "",
    imageIds: [],
    tabId: null,
  };
}

async function getLocal(key, fallback) {
  const result = await chrome.storage.local.get(key);
  return result[key] ?? fallback;
}

async function setLocal(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

export async function getGroups() {
  const groups = await getLocal(KEYS.groups, []);
  return Array.isArray(groups) ? groups : [];
}

export async function saveGroup(group) {
  const groups = await getGroups();
  const exists = groups.some((item) => item.id === group.id);
  const next = exists
    ? groups.map((item) => (item.id === group.id ? { ...item, ...group } : item))
    : [...groups, group];
  await setLocal(KEYS.groups, next);
  return next;
}

export async function deleteGroup(groupId) {
  const groups = await getGroups();
  const next = groups.filter((item) => item.id !== groupId);
  await setLocal(KEYS.groups, next);
  return next;
}

export async function getSettings() {
  const settings = await getLocal(KEYS.settings, {});
  const delay = Number(settings.delaySeconds);
  return {
    delaySeconds: Number.isFinite(delay)
      ? Math.min(120, Math.max(20, delay))
      : DEFAULT_SETTINGS.delaySeconds,
  };
}

export async function saveSettings(settings) {
  const current = await getSettings();
  const next = { ...current, ...settings };
  next.delaySeconds = Math.min(120, Math.max(20, Number(next.delaySeconds) || 45));
  await setLocal(KEYS.settings, next);
  return next;
}

export async function getDraft() {
  return getLocal(KEYS.draft, { text: "", imageIds: [] });
}

export async function saveDraft(draft) {
  const next = {
    text: draft.text ?? "",
    imageIds: Array.isArray(draft.imageIds) ? draft.imageIds : [],
  };
  await setLocal(KEYS.draft, next);
  return next;
}

export async function getHistory() {
  const history = await getLocal(KEYS.history, []);
  return Array.isArray(history) ? history : [];
}

export async function addHistory(entry) {
  const history = await getHistory();
  const next = [entry, ...history].slice(0, HISTORY_LIMIT);
  await setLocal(KEYS.history, next);
  return next;
}

export async function getQueueState() {
  const state = await getLocal(KEYS.queue, null);
  return state ? { ...createIdleQueue(), ...state } : createIdleQueue();
}

export async function setQueueState(state) {
  await setLocal(KEYS.queue, state);
  return state;
}

function openImageDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(IMAGE_DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(IMAGE_STORE)) {
        db.createObjectStore(IMAGE_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function putImage(record) {
  const db = await openImageDb();
  try {
    const tx = db.transaction(IMAGE_STORE, "readwrite");
    await idbRequest(tx.objectStore(IMAGE_STORE).put(record));
  } finally {
    db.close();
  }
}

export async function getImage(id) {
  const db = await openImageDb();
  try {
    const tx = db.transaction(IMAGE_STORE, "readonly");
    return await idbRequest(tx.objectStore(IMAGE_STORE).get(id));
  } finally {
    db.close();
  }
}

export async function getImages(ids) {
  const images = [];
  for (const id of ids) {
    const image = await getImage(id);
    if (image) {
      images.push(image);
    }
  }
  return images;
}

export async function deleteImages(ids) {
  if (!ids.length) {
    return;
  }
  const db = await openImageDb();
  try {
    const tx = db.transaction(IMAGE_STORE, "readwrite");
    const store = tx.objectStore(IMAGE_STORE);
    await Promise.all(ids.map((id) => idbRequest(store.delete(id))));
  } finally {
    db.close();
  }
}

export async function blobToBase64(blob) {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
