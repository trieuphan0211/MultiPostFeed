(() => {
  if (window.__mpfPosterInstalled) {
    return;
  }
  window.__mpfPosterInstalled = true;

  const COMPOSER_TRIGGERS = [
    "write something",
    "what's on your mind",
    "ban viet gi di",
    "bạn viết gì đi",
    "ban dang nghi gi",
    "bạn đang nghĩ gì",
    "create a public post",
    "create a post",
    "tạo bài viết",
    "tao bai viet",
  ];

  const PHOTO_LABELS = [
    "photo/video",
    "photo and video",
    "photos",
    "photo",
    "ảnh/video",
    "anh/video",
    "ảnh",
    "anh",
  ];

  const POST_LABELS = ["đăng", "dang", "post", "đăng bài", "dang bai"];

  const GROUP_PATH_SKIP = new Set([
    "feed",
    "joins",
    "discover",
    "notifications",
    "creates",
    "search",
  ]);

  const SEE_MORE_LABELS = [
    "see more",
    "see all",
    "show more",
    "xem thêm",
    "xem tất cả",
    "hiện thêm",
    "groups you've joined",
    "your groups",
    "nhóm bạn đã tham gia",
    "nhóm của bạn",
    "nhóm đã tham gia",
  ];

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "PING") {
      sendResponse({
        ok: true,
        isGroup: isLikelyGroupPage(),
        isJoins: isJoinsPage(),
      });
      return false;
    }
    if (message.type === "POST_TO_GROUP") {
      postToGroup(message.text || "", message.images || [])
        .then((result) => sendResponse(result))
        .catch((error) => {
          sendResponse({
            success: false,
            error: error.message || String(error),
          });
        });
      return true;
    }
    if (message.type === "SCAN_JOINED_GROUPS") {
      scanJoinedGroups()
        .then((result) => sendResponse(result))
        .catch((error) => {
          sendResponse({
            success: false,
            error: error.message || String(error),
          });
        });
      return true;
    }
    return false;
  });

  async function postToGroup(text, images) {
    if (!isLikelyGroupPage()) {
      return { success: false, error: "Trang hiện tại không phải trang nhóm Facebook." };
    }

    const dialog = await openComposer();
    const textbox = findComposerTextbox(dialog);
    if (!textbox) {
      return { success: false, error: "Không tìm thấy ô soạn bài. Hãy mở composer thủ công rồi thử lại." };
    }

    if (text) {
      await fillText(textbox, text);
    }

    if (images.length > 0) {
      const uploaded = await attachImages(dialog, images);
      if (!uploaded) {
        return {
          success: false,
          error: "Không gắn được ảnh. Hàng đợi đã tạm dừng để bạn kiểm tra composer.",
        };
      }
    }

    const posted = await clickPostButton(dialog);
    if (!posted) {
      return {
        success: false,
        error: "Không bấm được nút Đăng. Kiểm tra nội dung rồi nhấn Tiếp tục.",
      };
    }

    const closed = await waitFor(() => !findComposerDialog(), 15000);
    if (!closed) {
      return {
        success: false,
        error: "Composer vẫn mở sau khi bấm Đăng. Facebook có thể đang hỏi xác nhận.",
      };
    }

    return { success: true };
  }

  function isLikelyGroupPage() {
    const match = location.pathname.match(/\/groups\/([^/]+)/i);
    if (!match) {
      return false;
    }
    return !GROUP_PATH_SKIP.has(decodeURIComponent(match[1]).toLowerCase());
  }

  function isJoinsPage() {
    const path = location.pathname.replace(/\/+$/, "");
    return (
      path === "/groups" ||
      path === "/groups/joins" ||
      /joins|membership|your_groups/i.test(location.search)
    );
  }

  async function scanJoinedGroups() {
    await expandJoinedGroupLists();

    let stableRounds = 0;
    let lastCount = 0;
    const started = Date.now();
    const limitMs = 90000;

    while (Date.now() - started < limitMs && stableRounds < 6) {
      const groups = collectJoinedGroups();
      chrome.runtime
        .sendMessage({ type: "SCAN_PROGRESS", found: groups.length })
        .catch(() => {});

      if (groups.length <= lastCount) {
        stableRounds += 1;
      } else {
        stableRounds = 0;
        lastCount = groups.length;
      }

      clickSeeMoreButtons();
      scrollGroupLists();
      await sleep(750);
    }

    const groups = collectJoinedGroups();
    if (groups.length === 0) {
      return {
        success: false,
        error: "Không thấy nhóm nào. Hãy mở facebook.com/groups/joins rồi thử lại.",
      };
    }
    return { success: true, groups };
  }

  async function expandJoinedGroupLists() {
    if (!isJoinsPage()) {
      const joinsLink = [...document.querySelectorAll("a[href*='/groups/joins']")].find(isVisible);
      if (joinsLink) {
        humanClick(joinsLink);
        await sleep(1200);
      }
    }
    clickSeeMoreButtons();
    await sleep(400);
  }

  function collectJoinedGroups() {
    const found = new Map();
    const anchors = document.querySelectorAll('a[href*="/groups/"]');

    for (const anchor of anchors) {
      let parsed;
      try {
        parsed = new URL(anchor.href, location.origin);
      } catch {
        continue;
      }

      const match = parsed.pathname.match(/\/groups\/([^/]+)/i);
      if (!match) {
        continue;
      }
      const slug = decodeURIComponent(match[1]);
      if (!slug || GROUP_PATH_SKIP.has(slug.toLowerCase())) {
        continue;
      }

      const name = pickGroupName(anchor, slug);
      const key = slug.toLowerCase();
      const current = found.get(key);
      if (!current || (current.name === slug && name !== slug)) {
        found.set(key, {
          slug,
          name,
          url: `${location.origin}/groups/${encodeURIComponent(slug)}/`,
        });
      }
    }
    return [...found.values()];
  }

  function pickGroupName(anchor, slug) {
    const candidates = [
      anchor.getAttribute("aria-label"),
      anchor.innerText,
      anchor.closest('[role="article"], [role="listitem"], [role="link"]')?.innerText,
    ];

    for (const raw of candidates) {
      if (!raw) {
        continue;
      }
      const line = raw
        .split("\n")
        .map((item) => item.trim())
        .find((item) => item && !isJunkGroupLabel(item));
      if (line) {
        return line.slice(0, 120);
      }
    }
    return slug;
  }

  function isJunkGroupLabel(text) {
    return /^(join|tham gia|visit|xem|see all|see more|members|thành viên|\d)/i.test(text);
  }

  function clickSeeMoreButtons() {
    const roots = [
      document.querySelector('[role="main"]'),
      ...document.querySelectorAll('[role="navigation"]'),
    ].filter(Boolean);
    const scope = roots.length ? roots : [document.body];
    let clicks = 0;

    for (const root of scope) {
      const buttons = [...root.querySelectorAll('[role="button"], button, a')].filter(isVisible);
      for (const button of buttons) {
        const label = visibleLabel(button);
        const matched = SEE_MORE_LABELS.some(
          (item) => label === item || label.startsWith(`${item} `)
        );
        if (!matched) {
          continue;
        }
        humanClick(button);
        clicks += 1;
        if (clicks >= 3) {
          return;
        }
      }
    }
  }

  function scrollGroupLists() {
    window.scrollTo(0, document.documentElement.scrollHeight);
    const roots = [
      document.querySelector('[role="main"]'),
      ...document.querySelectorAll('[role="navigation"], [role="feed"]'),
    ].filter(Boolean);

    for (const root of roots) {
      const scroller = findScrollable(root);
      if (scroller) {
        scroller.scrollTop = scroller.scrollHeight;
      }
    }
  }

  function findScrollable(root) {
    let node = root;
    while (node && node !== document.body) {
      const style = window.getComputedStyle(node);
      const canScroll =
        /(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 20;
      if (canScroll) {
        return node;
      }
      node = node.parentElement;
    }
    return document.scrollingElement;
  }

  async function openComposer() {
    const existing = findComposerDialog();
    if (existing) {
      return existing;
    }

    const trigger = findComposerTrigger();
    if (!trigger) {
      throw new Error("Không tìm thấy ô 'Viết gì đó' trên trang nhóm.");
    }

    humanClick(trigger);
    const opened = await waitFor(() => findComposerDialog(), 8000);
    if (!opened) {
      throw new Error("Composer không mở sau khi bấm ô soạn bài.");
    }
    return opened;
  }

  function findComposerDialog() {
    const dialogs = [...document.querySelectorAll('[role="dialog"]')];
    return (
      dialogs.find((dialog) => findComposerTextbox(dialog)) ||
      null
    );
  }

  function findComposerTextbox(root) {
    const nodes = [...root.querySelectorAll('[role="textbox"], [contenteditable="true"]')];
    const visible = nodes.filter(isVisible);
    if (visible.length === 0) {
      return null;
    }
    visible.sort((a, b) => area(b) - area(a));
    return visible[0];
  }

  function findComposerTrigger() {
    const feed = document.querySelector('[role="main"]') || document.body;
    const byLabel = findClickableByTexts(feed, COMPOSER_TRIGGERS);
    if (byLabel) {
      return byLabel;
    }

    const boxes = [...feed.querySelectorAll('[role="textbox"], [contenteditable="true"]')].filter(
      isVisible
    );
    return boxes[0] || null;
  }

  async function fillText(textbox, text) {
    textbox.focus();
    await sleep(120);
    document.execCommand("selectAll", false, null);
    const inserted = document.execCommand("insertText", false, text);
    if (!inserted) {
      textbox.textContent = text;
      textbox.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          cancelable: true,
          inputType: "insertText",
          data: text,
        })
      );
    }
    await sleep(250);
  }

  async function attachImages(dialog, images) {
    let input = findImageInput(dialog);
    if (!input) {
      const photoButton = findClickableByTexts(dialog, PHOTO_LABELS);
      if (photoButton) {
        humanClick(photoButton);
        input = await waitFor(() => findImageInput(dialog) || findImageInput(document), 5000);
      }
    }

    if (!input) {
      return false;
    }

    const transfer = new DataTransfer();
    for (const image of images) {
      const bytes = base64ToUint8Array(image.dataBase64);
      const file = new File([bytes], image.name || "image.jpg", {
        type: image.mime || "image/jpeg",
      });
      transfer.items.add(file);
    }

    const imageCountBefore = dialog.querySelectorAll("img").length;
    input.files = transfer.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));

    return Boolean(
      await waitFor(() => dialog.querySelectorAll("img").length > imageCountBefore, 8000)
    );
  }

  function findImageInput(root) {
    const inputs = [...root.querySelectorAll('input[type="file"]')];
    return (
      inputs.find((input) => {
        const accept = (input.getAttribute("accept") || "").toLowerCase();
        return accept.includes("image") || accept.includes("video") || accept === "";
      }) || null
    );
  }

  async function clickPostButton(dialog) {
    const button = await waitFor(() => {
      const candidate = findPostButton(dialog);
      if (!candidate || isDisabled(candidate)) {
        return null;
      }
      return candidate;
    }, 8000);

    if (!button) {
      return false;
    }

    humanClick(button);
    return true;
  }

  function findPostButton(root) {
    const buttons = [
      ...root.querySelectorAll('[role="button"], button'),
    ].filter(isVisible);

    return (
      buttons.find((button) => {
        const label = visibleLabel(button);
        return POST_LABELS.includes(label);
      }) || null
    );
  }

  function findClickableByTexts(root, texts) {
    const normalized = texts.map(normalize);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let node;
    let best = null;

    while ((node = walker.nextNode())) {
      if (!isVisible(node)) {
        continue;
      }
      const label = visibleLabel(node);
      if (!label) {
        continue;
      }
      const matched = normalized.some((text) => {
        if (text.length <= 4) {
          return label === text || label.startsWith(`${text} `) || label.startsWith(`${text}/`);
        }
        return label === text || label.startsWith(text) || label.includes(text);
      });
      if (!matched) {
        continue;
      }
      const clickable =
        node.closest('[role="button"]') ||
        node.closest("button") ||
        (node.getAttribute("role") === "button" ? node : null);
      if (clickable && isVisible(clickable)) {
        best = clickable;
        break;
      }
    }
    return best;
  }

  function visibleLabel(el) {
    const aria = el.getAttribute("aria-label") || "";
    const text = el.innerText || "";
    return normalize(aria || text);
  }

  function normalize(value) {
    return value
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  }

  function isVisible(el) {
    if (!el) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return (
      rect.width > 8 &&
      rect.height > 8 &&
      style.visibility !== "hidden" &&
      style.display !== "none" &&
      style.opacity !== "0"
    );
  }

  function isDisabled(el) {
    return el.getAttribute("aria-disabled") === "true" || el.hasAttribute("disabled");
  }

  function area(el) {
    const rect = el.getBoundingClientRect();
    return rect.width * rect.height;
  }

  function humanClick(el) {
    el.scrollIntoView({ block: "center", inline: "nearest" });
    const rect = el.getBoundingClientRect();
    const clientX = rect.left + rect.width / 2;
    const clientY = rect.top + rect.height / 2;
    const opts = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX,
      clientY,
    };
    el.dispatchEvent(new PointerEvent("pointerdown", opts));
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.dispatchEvent(new PointerEvent("pointerup", opts));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));
    if (typeof el.click === "function") {
      el.click();
    }
  }

  function base64ToUint8Array(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  function waitFor(predicate, timeout) {
    return new Promise((resolve) => {
      const started = Date.now();
      const existing = predicate();
      if (existing) {
        resolve(existing);
        return;
      }

      const timer = setInterval(() => {
        const value = predicate();
        if (value) {
          cleanup();
          resolve(value);
          return;
        }
        if (Date.now() - started >= timeout) {
          cleanup();
          resolve(null);
        }
      }, 200);

      function cleanup() {
        clearInterval(timer);
      }
    });
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
})();
