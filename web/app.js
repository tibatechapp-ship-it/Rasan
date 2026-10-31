const $ = (id) => document.getElementById(id);
const state = {
  token: localStorage.getItem("rasan_token"),
  user: null, socket: null,
  myKeys: null,
  convs: [], activeConv: null, activeKey: null, activeKeyVersion: 1,
  locale: localStorage.getItem("rasan_locale") || "ar",
  outbox: [], // رسائل مؤجلة لغياب الاتصال — تُمسح عند العودة (طابور أوفلاين)
  // P4 — التفاعل والمراسلة: ذاكرة النصوص المفكوكة (للردود والبحث — محلية فقط
  // لا تخرج عن الجهاز)، تفاعلات لكل رسالة، الرد الجاري، المحفوظات والأرشيف.
  _msgCache: new Map(),   // mid -> { text, senderName, time, type }
  _reactions: new Map(),  // mid -> [{ emoji, userId }]
  _pollVotes: new Map(),  // P5: mid -> [{ userId, optionIndex }] — أصوات الاستطلاعات الحية
  replyTo: null,          // { id, text, senderName } — الرد الجاري
  starred: JSON.parse(localStorage.getItem("rasan_starred") || "[]"),
  archived: JSON.parse(localStorage.getItem("rasan_archived") || "[]"),
  showArchived: false,
  searchQuery: "",
  // P6 — ترقيم صفحات التاريخ (نمط Telegram/WhatsApp): مؤشر أقدم صفحة محمّلة
  // وهل هناك مزيد — يتغذّيان من hasMore/oldestId التي يرجعها الخادم.
  _oldestId: null, _hasMore: false, _loadingOlder: false,
};

// ===== P4: مخازن محلية (محفوظات/أرشيف) — E2EE آمنة: النص المفكوك يبقى على الجهاز
function saveStarred() { try { localStorage.setItem("rasan_starred", JSON.stringify(state.starred)); } catch {} }
function saveArchived() { try { localStorage.setItem("rasan_archived", JSON.stringify(state.archived)); } catch {} }
function isStarred(mid) { return state.starred.some((s) => s.mid === mid); }
function toggleStar(m) {
  const idx = state.starred.findIndex((s) => s.mid === m.id);
  if (idx >= 0) state.starred.splice(idx, 1);
  else state.starred.push({ convId: m.conversationId || state.activeConv?.id, mid: m.id, text: m.text || "", senderName: m.senderName || "", time: m.time || Date.now() });
  saveStarred();
}
function isArchived(cid) { return state.archived.includes(cid); }
function toggleArchive(cid) {
  const idx = state.archived.indexOf(cid);
  if (idx >= 0) state.archived.splice(idx, 1); else state.archived.push(cid);
  saveArchived(); renderList();
}

// ===== P5: مسودات محلية لكل محادثة (نمط الجميع) — نص غير مرسل يبقى على
// الجهاز فقط (localStorage) فيُستعاد عند العودة للمحادثة ويُمسح عند الإرسال.
// E2EE آمنة: لا تُرسل للخادم إطلاقاً.
function loadDrafts() { try { return JSON.parse(localStorage.getItem("rasan_drafts") || "{}"); } catch { return {}; } }
function getDraft(cid) { return loadDrafts()[String(cid)] || ""; }
function saveDraft(cid, text) {
  try {
    const d = loadDrafts();
    if (text) d[String(cid)] = text; else delete d[String(cid)];
    localStorage.setItem("rasan_drafts", JSON.stringify(d));
  } catch {}
}
function clearDraft(cid) { saveDraft(cid, ""); }
// قائمة تفاعلات ثابتة مطابقة لقائمة الخادم (interactions.ALLOWED_REACTIONS)
const REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "😡", "🔥", "✅"];

// ===== طابور الأوفلاين =====
// عند انقطاع الاتصال تُحفظ الرسائل المشفّرة محلياً (localStorage) وتُعرض
// بعلامة ⏳، وعند العودة تُعاد الإرسال ثم يستبدل echo الخادم النسخة
// المتفائلة عبر clientId — بلا تكرار وبلا فقد.
const OUTBOX_KEY = "rasan_outbox";
function newClientId() { return "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10); }
function saveOutbox() { try { localStorage.setItem(OUTBOX_KEY, JSON.stringify(state.outbox)); } catch {} }
function loadOutbox() { try { state.outbox = JSON.parse(localStorage.getItem(OUTBOX_KEY) || "[]"); } catch { state.outbox = []; } }

function setMsgStatus(clientId, status) {
  if (!clientId) return;
  const el = document.querySelector(`[data-cid="${clientId}"] .msg-status`);
  if (el) { el.dataset.status = status; el.textContent = status === "sent" ? "✓" : "⏳"; }
}

/** إرسال فوري إن وُجد اتصال، وإلا حفظ في الطابور — وفي الحالتين عرض متفائل. */
function sendOrQueue(payload, { preview, pendingRender } = {}) {
  payload.clientId = newClientId();
  const connected = !!state.socket?.connected;
  if (connected) state.socket.emit("message", payload);
  else { state.outbox.push({ ...payload }); saveOutbox(); }
  if (state.activeConv?.id === payload.conversationId && pendingRender) {
    appendMessage({
      id: null, clientId: payload.clientId, conversationId: payload.conversationId,
      senderId: state.user.id, senderName: state.user.username,
      type: payload.type, text: preview || "", time: Date.now(),
      pending: !connected,
    });
  }
}

function flushOutbox() {
  if (!state.socket?.connected || !state.outbox.length) return;
  for (const item of [...state.outbox]) {
    // أعد عرض النسخة المتفائلة إن كانت المحادثة مفتوحة (بعد إعادة التحميل مثلاً)
    if (state.activeConv?.id === item.conversationId && !document.querySelector(`[data-cid="${item.clientId}"]`)) {
      appendMessage({
        id: null, clientId: item.clientId, conversationId: item.conversationId,
        senderId: state.user.id, senderName: state.user.username,
        type: item.type, text: item._preview || "", time: Date.now(), pending: true,
      });
    }
    state.socket.emit("message", item);
  }
}

applyI18n(state.locale);

// ===== IndexedDB =====
async function idbPut(key, val) {
  return new Promise((res, rej) => {
    const req = indexedDB.open("rasan", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onsuccess = () => { const tx = req.result.transaction("kv", "readwrite"); tx.objectStore("kv").put(val, key); tx.oncomplete = res; tx.onerror = () => rej(tx.error); };
    req.onerror = () => rej(req.error);
  });
}
async function idbGet(key) {
  return new Promise((res, rej) => {
    const req = indexedDB.open("rasan", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onsuccess = () => { const tx = req.result.transaction("kv", "readonly"); const g = tx.objectStore("kv").get(key); g.onsuccess = () => res(g.result); g.onerror = () => rej(g.error); };
    req.onerror = () => rej(req.error);
  });
}

// ===== API helper =====
async function api(path, opts = {}) {
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  if (state.token) headers.Authorization = "Bearer " + state.token;
  const r = await fetch(path, { ...opts, headers });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || r.status);
  return data;
}

// ===== UX helpers: modals, toasts, prompts (UX audit R-1/R-2) =====
let _lastFocus = null;
function openModal(id) {
  const m = $(id);
  if (!m) return;
  _lastFocus = document.activeElement;
  m.classList.remove("hidden");
  const f = m.querySelector("input, textarea, select, button");
  if (f) f.focus();
}
function closeModal(id) {
  const m = $(id);
  if (!m) return;
  m.classList.add("hidden");
  if (_lastFocus && document.contains(_lastFocus)) { try { _lastFocus.focus(); } catch {} }
  _lastFocus = null;
}
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const open = [...document.querySelectorAll(".modal:not(.hidden), #verify-modal:not(.hidden)")];
  if (!open.length) return;
  e.preventDefault();
  const top = open[open.length - 1];
  if (top.id === "verify-modal") { top.classList.add("hidden"); top.setAttribute("aria-hidden", "true"); }
  else closeModal(top.id);
});
document.addEventListener("click", (e) => {
  const m = e.target.classList?.contains("modal") ? e.target : null;
  if (m && m.id) closeModal(m.id);
});

function showToast(msg, type = "info") {
  const t = document.createElement("div");
  t.className = "toast toast-" + type;
  t.setAttribute("role", type === "error" ? "alert" : "status");
  t.textContent = msg;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add("show"));
  setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.remove(), 300); }, 3800);
}

function t(key) { return I18N[state.locale]?.[key] ?? I18N.en[key] ?? I18N.ar[key] ?? key; }
function translateErr(msg) {
  const m = String(msg ?? "");
  const map = (I18N[state.locale] || I18N.en).errors || I18N.en.errors || {};
  return map[m] || map[m.toLowerCase()] || m;
}

// Promise-based text prompt (replaces window.prompt)
function textPrompt({ title, initial = "", hint = "", confirmLabel }) {
  return new Promise((resolve) => {
    const wrap = document.createElement("section");
    wrap.className = "modal";
    wrap.setAttribute("role", "dialog");
    wrap.setAttribute("aria-modal", "true");
    wrap.innerHTML = `<div class="modal-card">
      <h3>${escapeHtml(title)}</h3>
      ${hint ? `<p class="recovery-hint">${escapeHtml(hint)}</p>` : ""}
      <input id="tp-input" autocomplete="off" />
      <div class="modal-actions">
        <button id="tp-ok" class="btn-primary">${escapeHtml(confirmLabel || t("save"))}</button>
        <button id="tp-cancel" class="btn-secondary">${t("cancel")}</button>
      </div>
    </div>`;
    document.body.appendChild(wrap);
    const input = wrap.querySelector("#tp-input");
    input.value = initial;
    input.focus();
    input.select();
    const done = (val) => { wrap.remove(); resolve(val); };
    wrap.querySelector("#tp-ok").onclick = () => done(input.value);
    wrap.querySelector("#tp-cancel").onclick = () => done(null);
    wrap.addEventListener("click", (e) => { if (e.target === wrap) done(null); });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); done(input.value); } });
  });
}

// ===== Auth =====
document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    tab.classList.add("active");
    $("submit").dataset.mode = tab.dataset.mode;
    const dict = I18N[state.locale];
    $("submit").textContent = tab.dataset.mode === "login" ? dict.login : dict.register;
  });
});
$("submit").dataset.mode = "login";

$("auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("err").textContent = "";
  const mode = $("submit").dataset.mode;
  const btn = $("submit");
  state.locale = $("locale").value;
  localStorage.setItem("rasan_locale", state.locale);
  applyI18n(state.locale);
  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = t("pleaseWait");
  try {
    if (mode === "register") {
      // Keypair is generated ONLY on registration (fix: never clobber keys on login)
      const kp = await RasanCrypto.genKeypair();
      state.myKeys = kp;
      await idbPut("myKeypair", kp);
    } else {
      // On login, reuse the locally stored keypair
      state.myKeys = await idbGet("myKeypair");
    }
    const path = mode === "login" ? "/api/auth/login" : "/api/auth/register";
    const body = { username: $("username").value.trim(), password: $("password").value };
    if (mode === "register") { body.publicKey = state.myKeys.publicKey; body.locale = state.locale; }
    const data = await api(path, { method: "POST", body: JSON.stringify(body) });
    state.token = data.token;
    state.user = data.user;
    localStorage.setItem("rasan_token", data.token);

    if (mode === "register") {
      const recoveryCode = RasanCrypto.generateRecoveryCode();
      const backup = await RasanCrypto.createKeyBackup(recoveryCode);
      await api("/api/auth/key-backup", { method: "POST", body: JSON.stringify(backup) });
      await showRecoveryCode(recoveryCode);
    } else if (!state.myKeys) {
      // New device without local keys — offer the restore flow
      await promptRestore();
    }
    await enterApp();
  } catch (err) { $("err").textContent = translateErr(err.message); }
  finally { btn.disabled = false; btn.textContent = originalText; }
});

function showRecoveryCode(code) {
  return new Promise((resolve) => {
    const modal = document.createElement("section");
    modal.className = "modal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.innerHTML = `<div class="modal-card">
      <h3>${t("recoveryTitle")}</h3>
      <p class="recovery-hint">${t("recoveryHint")}</p>
      <div class="recovery-code">${code}</div>
      <button id="copy-rec" class="icon recovery-copy">${t("copy")}</button>
      <label class="recovery-ack">
        <input type="checkbox" id="ack-rec" /> ${t("ackSaved")}
      </label>
      <button id="confirm-rec" class="btn-primary" disabled style="opacity:.5">${t("continue")}</button>
    </div>`;
    document.body.appendChild(modal);
    const confirmBtn = modal.querySelector("#confirm-rec");
    modal.querySelector("#copy-rec").onclick = () => { navigator.clipboard.writeText(code); modal.querySelector("#copy-rec").textContent = t("copied"); setTimeout(() => modal.querySelector("#copy-rec").textContent = t("copy"), 1500); };
    modal.querySelector("#ack-rec").onchange = (e) => { confirmBtn.disabled = !e.target.checked; confirmBtn.style.opacity = e.target.checked ? "1" : ".5"; };
    confirmBtn.onclick = () => { modal.remove(); resolve(); };
  });
}

async function promptRestore() {
  const code = await textPrompt({
    title: t("restoreTitle"),
    hint: t("restoreHint"),
    confirmLabel: t("restoreBtn"),
  });
  if (!code) {
    const kp = await RasanCrypto.genKeypair();
    state.myKeys = kp;
    await idbPut("myKeypair", kp);
    await api("/api/auth/update-public-key", { method: "POST", body: JSON.stringify({ publicKey: kp.publicKey }) }).catch(() => {});
    return;
  }
  try {
    const backup = await api("/api/auth/key-backup");
    const recovered = await RasanCrypto.restoreFromBackup(code.trim(), backup);
    const parsed = JSON.parse(recovered);
    state.myKeys = parsed;
    await idbPut("myKeypair", parsed);
    showToast(t("restoreSuccess"), "success");
  } catch (e) {
    showToast(t("restoreFailed") + e.message, "error");
  }
}

// ===== Enter app =====
async function enterApp() {
  $("auth").classList.add("hidden");
  $("app").classList.remove("hidden");
  if (!state.myKeys) state.myKeys = await idbGet("myKeypair");
  // شارة الزائر التجريبي (P7): حسابات /demo فقط — تذكير دائم بأن البيانات مؤقتة
  if (state.user?.is_demo) $("demo-banner")?.classList.remove("hidden");
  connectSocket();
  await loadConversations();
  loadBlocks(); // قائمة حظري (P4) — فشلها لا يعطل الدخول (أزرار الحظر تعرض الحالة الافتراضية)
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("فشل تحميل السكربت: " + src));
    document.head.appendChild(s);
  });
}

async function connectSocket() {
  // socket.io client is lazy-loaded on first connect (~40KB saved on the
  // auth screen). `io` is referenced nowhere else, so the injection point
  // is exactly here.
  if (!window.io) await loadScript("/socket.io/socket.io.js");
  state.socket = io({ auth: { token: state.token } });
  state.socket.on("connect", () => { loadOutbox(); flushOutbox(); });
  state.socket.on("disconnect", () => { if (state.user) showToast(I18N[state.locale].offlineQueued || "انقطع الاتصال — ستوضع الرسائل في الطابور", "error"); teardownCall(true); teardownGroupCall(false); });
  bindCallEvents();
  bindGroupCallEvents(); // أحداث المكالمات الجماعية (mesh — server/groupcalls.js)
  // إقرار الخادم: الرسالة حُفظت — مؤشر ✓
  state.socket.on("message:ack", ({ clientId }) => setMsgStatus(clientId, "sent"));
  state.socket.on("message", async (msg) => {
    // استبدال النسخة المتفائلة للرسائل المُرسلة من هذا الجهاز (بلا تكرار)
    if (msg.clientId && msg.senderId === state.user.id) {
      document.querySelector(`[data-cid="${msg.clientId}"]`)?.remove();
      const idx = state.outbox.findIndex(o => o.clientId === msg.clientId);
      if (idx >= 0) { state.outbox.splice(idx, 1); saveOutbox(); }
    }
    if (state.activeConv && msg.conversationId === state.activeConv.id) {
      if (msg.type === "file") {
        const text = await decryptMessage(msg);
        try { appendFileMessage(msg, JSON.parse(text)); } catch { appendMessage({ ...msg, text: "📎 ملف" }); }
      } else {
        const text = await decryptMessage(msg);
        appendMessage({ ...msg, text });
      }
    } else {
      const conv = state.convs.find(c => c.id === msg.conversationId);
      if (conv) { conv._unread = (conv._unread || 0) + 1; renderList(); }
    }
  });
  state.socket.on("message:deleted", ({ id }) => {
    const el = document.querySelector(`[data-mid="${id}"]`);
    if (el) { el.style.transition = "opacity .3s"; el.style.opacity = "0"; setTimeout(() => el.remove(), 300); }
    // تنظيف الذاكرة المحلية (P4): النص المفكوك والتفاعلات والمحفوظات — بلا أثر
    state._msgCache.delete(id);
    state._reactions.delete(id);
    state._pollVotes?.delete(id); // P5: أصوات الاستطلاع ماتت مع الرسالة (زناد الخادم)
    state._pollMeta?.delete(id);
    const si = state.starred.findIndex((s) => s.mid === id);
    if (si >= 0) { state.starred.splice(si, 1); saveStarred(); }
    if (state.replyTo?.id === id) { state.replyTo = null; updateReplyBar(); }
  });
  // تفاعل حي (P4): أحدّث لاصقات الرسالة فوراً بلا إعادة جلب
  state.socket.on("message:reaction", ({ conversationId, messageId, userId, emoji }) => {
    if (state.activeConv?.id !== conversationId) return;
    applyReactionUpdate({ messageId, userId, emoji });
  });
  // صوت استطلاع حي (P5): أعد رسم بطاقة الاستطلاع فوراً بلا إعادة جلب
  state.socket.on("message:poll-vote", ({ conversationId, messageId, userId, optionIndex }) => {
    if (state.activeConv?.id !== conversationId) return;
    applyPollVoteUpdate({ messageId, userId, optionIndex });
  });
  // P6 — مؤقت المتلاشية حي (نمط Signal): أي عضو يغيّره يظهر للجميع فوراً
  state.socket.on("conv:ttl", ({ conversationId, ttlSeconds, by }) => {
    if (by === state.user.id) return; // أنا وضعته — الإشعار وصل أولاً
    const conv = state.convs.find(c => c.id === conversationId);
    if (conv) { conv.ttl_seconds = ttlSeconds; renderList(); }
    if (state.activeConv?.id === conversationId) showToast(ttlSeconds > 0 ? t("ttlToast") : t("ttlClearedToast"), "info");
  });
  // P6 — قبول/رفض طلب الرسالة حيًا: القائمة تتحدث لدى الطرفين بلا إعادة جلب
  state.socket.on("conv:accepted", ({ conversationId }) => {
    const conv = state.convs.find(c => c.id === conversationId);
    if (conv && conv.dm_accepted === 0) { conv.dm_accepted = 1; renderList(); }
  });
  state.socket.on("conv:declined", ({ conversationId }) => {
    const existed = state.convs.some(c => c.id === conversationId);
    if (existed) { state.convs = state.convs.filter(c => c.id !== conversationId); renderList(); }
    if (state.activeConv?.id === conversationId) $("back").click(); // المحادثة ماتت — عُد للقائمة
  });
  state.socket.on("message:edited", async ({ id, ciphertext, iv, edited_at }) => {
    const el = document.querySelector(`[data-mid="${id}"]`);
    if (!el || !state.activeKey) return;
    try {
      const text = await RasanCrypto.decrypt(state.activeKey, ciphertext, iv);
      const span = el.querySelector(".text");
      if (span) span.textContent = text;
      const edited = el.querySelector(".edited");
      if (edited) edited.textContent = "(معدّلة)";
    } catch (e) { console.error("edit decrypt failed:", e); }
  });
  state.socket.on("typing", ({ conversationId, name, isTyping }) => {
    if (state.activeConv?.id === conversationId) $("typing").textContent = isTyping ? `${name} ${I18N[state.locale].typing}` : "";
  });
  state.socket.on("presence", ({ userId, online }) => {
    document.querySelectorAll(`[data-uid="${userId}"]`).forEach(el => el.classList.toggle("online", online));
  });
  // إنذار طوارئ: لافتة حمراء في المحادثة المفتوحة، وتنبيه إن كانت في الخلفية
  state.socket.on("emergency", ({ conversationId, byName }) => {
    if (state.activeConv?.id === conversationId) showEmergencyBanner(byName);
    else showToast(`🚨 إنذار طوارئ من ${byName} — في محادثة أخرى`, "error");
  });
  state.socket.on("group-key:updated", async ({ by, key_version }) => {
    if (!state.activeConv || by === state.user.id) return;
    try {
      const payload = await api(`/api/conversations/${state.activeConv.id}/group-key`);
      if (!payload.wrapped_key) return;
      state.activeKey = await RasanCrypto.unwrapGroupKey(payload, state.myKeys.privateKey, payload.owner_public_key);
      state.activeKeyVersion = payload.key_version;
    } catch (e) { console.error("Failed to refresh key:", e); $("typing").textContent = "⚠ تعذر تحديث مفتاح المجموعة"; }
  });
  state.socket.on("member:added", async ({ userId, username }) => {
    if (!state.activeConv) return;
    // If I'm owner, wrap key for new member
    if (state.activeConv.owner_id === state.user.id && state.activeKey) {
      try {
        const { members } = await api(`/api/conversations/${state.activeConv.id}/members`);
        const newMember = members.find(m => m.id === userId);
        if (newMember?.public_key) {
          const wrapped = await RasanCrypto.wrapGroupKeyForMember(state.activeKey, state.myKeys.privateKey, newMember.public_key);
          await api(`/api/conversations/${state.activeConv.id}/group-key/bulk`, { method: "POST", body: JSON.stringify({ entries: [{ userId, ...wrapped }], key_version: state.activeKeyVersion }) }).catch(() => {});
        }
      } catch (e) { console.error(e); }
    }
  });
  state.socket.on("member:removed", async ({ userId }) => {
    if (!state.activeConv) return;
    const { members } = await api(`/api/conversations/${state.activeConv.id}/members`).catch(() => ({ members: [] }));
    const me = members.find(m => m.id === state.user.id);
    if (!me || !["owner", "admin"].includes(me.role)) return;
    try { await rotateGroupKey(state.activeConv); } catch (e) { console.error("Key rotation failed:", e); }
  });
  state.socket.on("message:rejected", async ({ reason, expected, got }) => {
    if (reason === "key_version_mismatch") {
      try {
        const payload = await api(`/api/conversations/${state.activeConv.id}/group-key`);
        if (payload.wrapped_key) {
          state.activeKey = await RasanCrypto.unwrapGroupKey(payload, state.myKeys.privateKey, payload.owner_public_key);
          state.activeKeyVersion = payload.key_version;
        }
      } catch (e) { console.error(e); }
    } else if (reason === "channel_readonly") {
      // القنوات للقراءة فقط — النشر للمشرفين/المالك (أدوات الإشراف)
      showToast(t("channelReadonly"), "error");
    } else if (reason === "blocked") {
      // حظر ثنائي الاتجاه (P4): رسائل DM القائمة تصمت مع إشعار واضح
      showToast(t("blockedToast"), "error");
    } else if (reason === "reply_invalid") {
      // الرد على رسالة محذوفة أو من محادثة أخرى — يُرفض صراحةً
      showToast(t("replyInvalidToast"), "error");
      state.replyTo = null;
      updateReplyBar();
    }
  });

  // ===== أحداث الإشراف (نافذة الأعضاء حية) =====
  state.socket.on("member:role", ({ conversationId, userId, role }) => {
    if (state.activeConv?.id !== conversationId) return;
    const mm = state.activeConv._members?.find((x) => x.id === userId);
    if (mm) mm.role = role;
    if (userId === state.user.id) state.activeConv._myRole = role; // دوري تغيّر
    if (!$("members-modal").classList.contains("hidden")) renderMembersLists();
  });
  state.socket.on("member:banned", ({ conversationId, username }) => {
    if (state.activeConv?.id !== conversationId) return;
    if (state.activeConv._members) state.activeConv._members = state.activeConv._members.filter((x) => x.username !== username);
    showToast(`⛔ ${username} — ${t("memberBannedToast")}`, "info");
    if (!$("members-modal").classList.contains("hidden")) renderMembersLists();
  });
  state.socket.on("member:unbanned", ({ conversationId }) => {
    if (state.activeConv?.id !== conversationId) return;
    if (!$("members-modal").classList.contains("hidden")) renderMembersLists();
  });
  state.socket.on("message:pinned", ({ conversationId, messageId }) => {
    if (state.activeConv?.id !== conversationId) return;
    state.activeConv.pinned_message_id = messageId;
    updatePinnedBanner();
    showToast(t("msgPinnedToast"), "info");
  });
  state.socket.on("message:unpinned", ({ conversationId }) => {
    if (state.activeConv?.id !== conversationId) return;
    state.activeConv.pinned_message_id = null;
    updatePinnedBanner();
  });
}

// ===== Conversations =====
// طلب مراسلة معلّق (P6 — نمط WhatsApp/Signal): DM بدأها غيري ولم أقبله بعد —
// يظهر في قسم الطلبات لا في القائمة الرئيسية.
function isPendingRequest(c) {
  return c.type === "dm" && c.dm_accepted === 0 && c.owner_id !== state.user?.id;
}

async function loadConversations() {
  const { conversations } = await api("/api/conversations");
  state.convs = conversations;
  renderList();
}

// صف طلب مراسلة: اسم + زرا قبول/رفض صريحان — والفتح بالضغط مسموح للقراءة
// قبل القرار (نفس عقد WhatsApp: ترى الطلب ثم تقبله أو ترفضه)
function requestRow(c) {
  const el = document.createElement("div");
  el.className = "conv request";
  el.dataset.cid = c.id;
  const name = c.name || `DM #${c.id}`;
  el.innerHTML = `<div class="conv-icon">📨</div><div class="conv-body"><b>${escapeHtml(name)}</b><small>${t("convPending")}</small></div>`;
  const acc = document.createElement("button");
  acc.type = "button"; acc.className = "req-accept"; acc.textContent = "✅ " + t("reqAccept");
  acc.addEventListener("click", async (e) => {
    e.stopPropagation();
    try {
      await api(`/api/conversations/${c.id}/accept`, { method: "POST", body: "{}" });
      c.dm_accepted = 1; renderList(); showToast(t("reqAcceptedToast"), "success");
      openConversation(c);
    } catch (err) { showToast(translateErr(err.message), "error"); }
  });
  const dec = document.createElement("button");
  dec.type = "button"; dec.className = "req-decline"; dec.textContent = "🗑 " + t("reqDecline");
  dec.addEventListener("click", async (e) => {
    e.stopPropagation();
    try {
      await api(`/api/conversations/${c.id}/decline`, { method: "POST", body: "{}" });
      state.convs = state.convs.filter(x => x.id !== c.id);
      renderList(); showToast(t("reqDeclinedToast"), "info");
    } catch (err) { showToast(translateErr(err.message), "error"); }
  });
  el.append(acc, dec);
  el.tabIndex = 0;
  el.setAttribute("role", "button");
  el.setAttribute("aria-label", name);
  el.addEventListener("click", () => openConversation(c));
  el.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); openConversation(c); } });
  return el;
}

function renderList() {
  const list = $("list");
  list.innerHTML = "";
  // الأرشيف (P4 — نمط Telegram/WhatsApp): مبدّل يعرض المحادثات المؤرشفة بدل الرئيسية
  const archiveBar = document.createElement("div");
  archiveBar.className = "archive-bar";
  const archiveBtn = document.createElement("button");
  archiveBtn.type = "button";
  archiveBtn.className = "archive-toggle" + (state.showArchived ? " active" : "");
  archiveBtn.setAttribute("aria-pressed", String(state.showArchived));
  archiveBtn.textContent = `📦 ${t("archivedChats")} (${state.archived.length})`;
  archiveBtn.onclick = () => { state.showArchived = !state.showArchived; renderList(); };
  archiveBar.appendChild(archiveBtn);
  list.appendChild(archiveBar);

  // طلبات المراسلة (P6 — نمط WhatsApp/Signal): قسم خاص أعلى القائمة — لا
  // تُخلط بالمحادثات النشطة، وفيه أزرار قبول/رفض صريحة (بلا إشعارات دفع —
  // عقد الخادم: الطلبات صامتة حتى تُقبل)
  const pending = state.showArchived ? [] : state.convs.filter(isPendingRequest);
  if (pending.length) {
    const reqs = document.createElement("div");
    reqs.className = "requests-section";
    reqs.dataset.requestsSection = "1";
    const h = document.createElement("b");
    h.textContent = `📨 ${t("requestsTitle")} (${pending.length})`;
    reqs.appendChild(h);
    for (const c of pending) reqs.appendChild(requestRow(c));
    list.appendChild(reqs);
  }

  const visible = state.convs
    .filter((c) => (state.showArchived ? isArchived(c.id) : !isArchived(c.id)))
    .filter((c) => !isPendingRequest(c)); // الطلبات في قسمها — لا مكرر
  if (!visible.length && !pending.length) { list.innerHTML += `<p class="empty">${I18N[state.locale].noMessages}</p>`; return; }
  for (const c of visible) {
    const el = document.createElement("div");
    el.className = "conv";
    el.dataset.cid = c.id;
    const icon = c.type === "channel" ? "📢" : c.type === "group" ? "👥" : "💬";
    const unread = c._unread ? `<span class="badge">${c._unread}</span>` : "";
    const ttlBadge = c.ttl_seconds > 0 ? ` <span class="ttl-badge" title="${t("ttlMenu")}">${t("ttlBadge")}</span>` : "";
    const name = c.name || `DM #${c.id}`;
    el.innerHTML = `<div class="conv-icon">${icon}</div><div class="conv-body"><b>${escapeHtml(name)}</b><small>${c.members} ${I18N[state.locale].members || "members"}${ttlBadge}</small></div>${unread}`;
    el.tabIndex = 0;
    el.setAttribute("role", "button");
    el.setAttribute("aria-label", name);
    el.addEventListener("click", () => openConversation(c));
    el.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); openConversation(c); } });
    // قائمة سياق للأرشفة/إلغاء الأرشفة (يمين الفأرة، أو ضغط طويل — نفس عقد قائمة الرسائل)
    el.addEventListener("contextmenu", (e) => { e.preventDefault(); showConvMenu(c, el); });
    let at = null;
    el.addEventListener("touchstart", () => { at = setTimeout(() => showConvMenu(c, el), 600); });
    el.addEventListener("touchend", () => clearTimeout(at));
    el.addEventListener("touchmove", () => clearTimeout(at));
    list.appendChild(el);
  }
}

// قائمة المحادثة: أرشفة/إلغاء أرشفة (P4) — إخفاء بدون حذف + مؤقت المتلاشية (P6)
function showConvMenu(c, el) {
  const menu = document.createElement("div");
  menu.className = "msg-menu";
  menu.dataset.msgMenu = "1";
  menu.setAttribute("role", "menu");
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "msg-menu-item";
  btn.textContent = isArchived(c.id) ? `↩ ${t("unarchiveChat")}` : `📦 ${t("archiveChat")}`;
  btn.onclick = () => { menu.remove(); toggleArchive(c.id); };
  menu.appendChild(btn);
  // مؤقت المتلاشية للمحادثة (P6 — نمط Signal): قائمة فرعية بالمدد البيضاء
  const ttlBtn = document.createElement("button");
  ttlBtn.type = "button";
  ttlBtn.className = "msg-menu-item";
  ttlBtn.textContent = t("ttlMenu") + (c.ttl_seconds > 0 ? ` (${c.ttl_seconds}s)` : "");
  ttlBtn.onclick = () => { menu.remove(); showTtlMenu(c, el); };
  menu.appendChild(ttlBtn);
  const rect = el.getBoundingClientRect();
  menu.style.top = Math.min(rect.top, window.innerHeight - 90) + "px";
  menu.style.insetInlineStart = "16px";
  document.body.appendChild(menu);
  btn.focus();
  setTimeout(() => document.addEventListener("click", closeMsgMenu, { once: true }), 0);
}

// قائمة مؤقت المتلاشية (P6 — نمط Signal): إيقاف/ساعة/يوم/أسبوع/30 يوماً —
// يُرفع PATCH للخادم فيبثّه للغرفة، فتصير كل الرسائل الجديدة تختفي بعد المدة
// حتى بلا فعل من المرسل (الخادم يملك المؤقت — المسح الدوري في ephemeral.js)
function showTtlMenu(c, el) {
  const menu = document.createElement("div");
  menu.className = "msg-menu";
  menu.dataset.msgMenu = "1";
  menu.setAttribute("role", "menu");
  const opts = [["ttlOff", 0], ["ttl1h", 3600], ["ttl1d", 86400], ["ttl1w", 604800], ["ttl30d", 2592000]];
  for (const [key, secs] of opts) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "msg-menu-item";
    b.dataset.ttlSeconds = String(secs);
    b.textContent = (c.ttl_seconds === secs ? "✓ " : "") + t(key);
    b.onclick = async () => {
      menu.remove();
      try {
        await api(`/api/conversations/${c.id}/ttl`, { method: "PATCH", body: JSON.stringify({ ttl_seconds: secs }) });
        c.ttl_seconds = secs;
        showToast(secs > 0 ? `${t("ttlToast")}: ${t(key)}` : t("ttlClearedToast"), "success");
        renderList();
      } catch (err) { showToast(translateErr(err.message), "error"); }
    };
    menu.appendChild(b);
  }
  const rect = el.getBoundingClientRect();
  menu.style.top = Math.min(rect.top, window.innerHeight - 220) + "px";
  menu.style.insetInlineStart = "16px";
  document.body.appendChild(menu);
  menu.querySelector("button").focus();
  setTimeout(() => document.addEventListener("click", closeMsgMenu, { once: true }), 0);
}

async function openConversation(conv) {
  state.activeConv = conv;
  conv._unread = 0;
  state.activeKeyVersion = 1;
  state.replyTo = null; // لا رد معلّق عبر تبديل المحادثة
  updateReplyBar();
  $("list").classList.add("hidden");
  $("chat").classList.remove("hidden");
  $("back").classList.remove("hidden");
  $("title").textContent = conv.name || "DM";
  $("messages").innerHTML = "";
  $("typing").textContent = "";
  $("search-input").value = "";
  state.searchQuery = "";
  $("emergency-banner").classList.add("hidden");
  // زر الطوارئ متاح للمجموعات والقنوات (بث جماعي كما في Zello) — لا للخاص
  $("emergency-btn").classList.toggle("hidden", !(conv.type === "group" || conv.type === "channel"));
  // زرا المكالمات للخاص فقط (مكالمة 1:1 — WebRTC)
  $("call-btn").classList.toggle("hidden", conv.type !== "dm");
  $("video-call-btn").classList.toggle("hidden", conv.type !== "dm");
  // زر المكالمة الجماعية (WebRTC mesh) للمجموعات والقنوات — يتطلب متصفحاً يدعم الوسائط
  $("group-call-btn").classList.toggle("hidden", !((conv.type === "group" || conv.type === "channel") && gcallSupported()));
  // إدارة الأعضاء/الإشراف للمجموعات والقنوات (درس FireChat)
  $("members-btn").classList.toggle("hidden", conv.type === "dm");
  // لاصقة الرسالة المثبّتة تُقرأ من حقل قاعدة البيانات المُرحّل (pinned_message_id)
  updatePinnedBanner();
  state.socket.emit("join", { conversationId: conv.id });
  $("rotate-key").classList.toggle("hidden", conv.type === "dm");

  state.activeKey = null;
  if (conv.type === "dm") {
    const { members } = await api(`/api/conversations/${conv.id}/members`);
    const peer = members.find(m => m.id !== state.user.id);
    if (peer) {
      conv._peer = peer;
      if (peer.public_key) {
        state.activeKey = await RasanCrypto.deriveShared(state.myKeys.privateKey, peer.public_key);
        // Bridge to the security/identity module (TOFU + safety number + QR)
        window.dispatchEvent(new CustomEvent("rasan:conv-open", { detail: { peerId: String(peer.id), peerPublicKey: peer.public_key, myPublicKey: state.myKeys?.publicKey || null } }));
      }
    } else {
      // محادثة الذات «رسائل محفوظة» (P5): لا طرف ثانٍ — المفتاح يُشتق عبر
      // ECDH مع مفتاحي العام نفسه (سر مشترك ثابت لنفس زوج المفاتيح). الإرسال
      // كان صامتاً هنا بلا مفتاح (خلل حقيقي اكتشفه E2E الأسبوع 2: النقر على
      // الإرسال لا يفعل شيئاً في المحفوظات) — الآن التشفير يعمل كما في DM.
      state.activeKey = await RasanCrypto.deriveShared(state.myKeys.privateKey, state.myKeys.publicKey);
    }
  } else {
    await ensureGroupKey(conv);
    try { const s = await api(`/api/conversations/${conv.id}/key-state`); state.activeKeyVersion = s.current; } catch {}
    // الأدوار لأدوات الإشراف: دوري هنا (owner/admin/member) + قائمة الأعضاء
    // لطابور نافذة الإدارة. فشل الجلب لا يكسر فتح المحادثة (دور افتراضي عضو).
    try {
      const { members } = await api(`/api/conversations/${conv.id}/members`);
      conv._members = members;
      conv._myRole = members.find((m) => m.id === state.user.id)?.role || "member";
    } catch { conv._myRole = "member"; }
  }

  // ترقيم صفحات التاريخ (P6): الخادم يعيد hasMore/oldestId — زر «الأقدم»
  // يظهر فقط إن كان هناك تاريخ قبل ما حُمّل
  const msgsResp = await api(`/api/conversations/${conv.id}/messages`);
  state._oldestId = msgsResp.oldestId ?? (msgsResp.messages[0]?.id ?? null);
  state._hasMore = !!msgsResp.hasMore;
  updateLoadOlder();
  for (const m of msgsResp.messages) {
    if (m.type === "file") {
      const text = await decryptMessage(m);
      try { appendFileMessage(m, JSON.parse(text)); } catch { appendMessage({ ...m, text: "📎 ملف" }); }
    } else {
      const text = await decryptMessage(m);
      appendMessage({ ...m, text });
    }
  }
  // بعد تحميل الرسائل: نص المثبّتة إن كان معرّفها ضمن المحمّلة (E2EE — يُفك محلياً)
  updatePinnedBanner();
  $("msg-input").focus();
  // استعادة المسودة المحلية لهذه المحادثة (P5 — تبقى على الجهاز فقط)
  $("msg-input").value = getDraft(conv.id);
}

// ===== ترقيم صفحات التاريخ (P6 — نمط Telegram/WhatsApp «تحميل الأقدم») =====
// زر أعلى الرسائل يظهر فقط إن كان hasMore — الجلب قبل oldestId ثم إدراج
// الرسائل أعلى القائمة مع حفظ موضع التمرير (لا قفزة مزعجة)
function updateLoadOlder() {
  const btn = $("load-older");
  if (!btn) return;
  btn.classList.toggle("hidden", !(state.activeConv && state._hasMore && state._oldestId));
}

async function loadOlder() {
  if (!state.activeConv || !state._oldestId || state._loadingOlder) return;
  const conv = state.activeConv;
  state._loadingOlder = true;
  const btn = $("load-older");
  if (btn) btn.disabled = true;
  try {
    const resp = await api(`/api/conversations/${conv.id}/messages?before=${state._oldestId}&limit=50`);
    if (state.activeConv?.id !== conv.id) return; // بدّل المحادثة أثناء الجلب
    const box = $("messages");
    const prevHeight = box.scrollHeight;
    for (const m of resp.messages) {
      if (m.type === "file") {
        const text = await decryptMessage(m);
        try { appendFileMessage(m, JSON.parse(text), { prepend: true }); } catch { appendMessage({ ...m, text: "📎 ملف" }, { prepend: true }); }
      } else {
        const text = await decryptMessage(m);
        appendMessage({ ...m, text }, { prepend: true });
      }
    }
    // حفظ موضع التمرير: الارتفاع زاد بقدر المحتوى المُدرج — نزح التمرير بنفس القدر
    box.scrollTop = box.scrollHeight - prevHeight;
    if (resp.messages.length) state._oldestId = resp.messages[0].id;
    state._hasMore = !!resp.hasMore;
    updateLoadOlder();
  } catch (err) { showToast(translateErr(err.message), "error"); }
  finally {
    state._loadingOlder = false;
    if (btn) btn.disabled = false;
    if (state.activeConv?.id === conv.id) updateLoadOlder();
  }
}

async function ensureGroupKey(conv) {
  if (state.activeKey) return;
  try {
    const payload = await api(`/api/conversations/${conv.id}/group-key`);
    if (!payload.wrapped_key) return;
    state.activeKey = await RasanCrypto.unwrapGroupKey(payload, state.myKeys.privateKey, payload.owner_public_key);
    state.activeKeyVersion = payload.key_version;
  } catch (e) { console.error("Failed to unwrap group key:", e); }
}

async function decryptMessage(m) {
  try { if (state.activeKey) return await RasanCrypto.decrypt(state.activeKey, m.ciphertext, m.iv); return "🔒"; } catch { return "🔒"; }
}

function appendMessage(m, opts) {
  const div = document.createElement("div");
  div.className = "msg " + (m.senderId === state.user.id ? "mine" : "other");
  div.dataset.mid = m.id;

  const b = document.createElement("b"); b.textContent = m.senderName;
  const span = document.createElement("span"); span.className = "text"; span.textContent = m.text;
  const edited = document.createElement("em"); edited.className = "edited"; edited.textContent = m.edited_at ? t("edited") : "";
  const small = document.createElement("small"); small.textContent = new Date(m.time).toLocaleTimeString(state.locale, { hour: "2-digit", minute: "2-digit" });

  div.append(b);

  // ذاكرة النصوص المفكوكة (P4): للردود والبحث والمحفوظات — محلية فقط
  if (m.id != null) state._msgCache.set(m.id, { text: m.text || "", senderName: m.senderName || "", time: m.time || 0, type: m.type || "text", conversationId: m.conversationId });
  if (m.reactions) state._reactions.set(m.id, m.reactions);
  if (m.pollVotes) state._pollVotes.set(m.id, m.pollVotes); // P5: أصوات الاستطلاعات من الخادم

  // اقتباس الرد (P4): مرجع المعرف من الخادم + النص من الذاكرة المحلية (E2EE)
  if (m.replyTo != null) {
    const quote = document.createElement("blockquote");
    quote.className = "reply-quote";
    quote.dataset.replyTo = m.replyTo;
    const cached = state._msgCache.get(m.replyTo);
    const qName = document.createElement("b"); qName.textContent = cached?.senderName || "";
    const qText = document.createElement("span"); qText.textContent = cached?.text || t("quoteUnavailable");
    quote.append(qName, qText);
    quote.tabIndex = 0;
    quote.setAttribute("role", "link");
    quote.setAttribute("aria-label", t("replyTo"));
    const jump = () => document.querySelector(`[data-mid="${m.replyTo}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    quote.addEventListener("click", jump);
    quote.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); jump(); } });
    div.appendChild(quote);
  }

  // مشاركة الموقع (P4 — نمط Meshtastic GPS): رقاقة 📍 + رابط OpenStreetMap —
  // بلا تحميل بلاطات من طرف ثالث (الخصوصية: لا أي طلب خارجي). الإحداثيات
  // مشفّرة E2EE في ciphertext الرسالة — الخادم لا يراها.
  if (m.type === "location") {
    try {
      const loc = JSON.parse(m.text);
      const chip = document.createElement("a");
      chip.className = "location-chip";
      chip.href = `https://www.openstreetmap.org/?mlat=${encodeURIComponent(loc.lat)}&mlon=${encodeURIComponent(loc.lng)}#map=16/${encodeURIComponent(loc.lat)}/${encodeURIComponent(loc.lng)}`;
      chip.target = "_blank";
      chip.rel = "noopener noreferrer";
      chip.textContent = `📍 ${t("locationMsg")} (${Number(loc.lat).toFixed(5)}, ${Number(loc.lng).toFixed(5)})`;
      span.replaceWith(chip);
    } catch { span.textContent = "📍"; }
  }

  // استطلاع رأي (P5 — نمط Telegram/Signal): السؤال والخيارات فُكّت محلياً من
  // ciphertext (E2EE) — الخادم يرى فهارس الخيارات فقط (ميتاداتا).
  if (m.type === "poll") {
    try {
      state._pollMeta = state._pollMeta || new Map();
      const meta = JSON.parse(m.text);
      if (!meta || !Array.isArray(meta.options)) throw new Error("bad poll");
      state._pollMeta.set(m.id, { question: String(meta.question || ""), options: meta.options.map(String) });
      span.replaceWith(renderPollCard(m.id));
    } catch { span.textContent = m.text || "📊"; } // النسخة المتفائلة أثناء الإرسال
  }

  div.append(span, edited, small);

  // لاصقة التفاعلات الحية (P4): تُحدّث عبر message:reaction لاحقاً
  if (m.id != null) div.appendChild(renderReactionChips(m.id));

  // مؤشر التسليم لرسائلي: ⏳ في الطابور / ✓ حُفظت على الخادم
  if (m.senderId === state.user.id) {
    if (m.clientId) div.dataset.cid = m.clientId;
    const st = document.createElement("span");
    st.className = "msg-status";
    st.dataset.status = m.pending ? "queued" : "sent";
    st.textContent = m.pending ? "⏳" : "✓";
    st.title = m.pending ? "في الطابور — تُرسل عند عودة الاتصال" : "تم الإرسال";
    div.appendChild(st);
  }

  // قائمة الرسائل متاحة على كل رسالة نصية/صوتية/موقع (P4):
  // الرد/التفاعل/الحفظ للجميع — التعديل والحذف للمرسل — الإشراف للمشرف
  if (m.type !== "file") {
    div.tabIndex = 0;
    div.setAttribute("aria-label", t("msgActionsHint"));
    div.addEventListener("contextmenu", (e) => { e.preventDefault(); showMsgMenu(m, div); });
    div.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); showMsgMenu(m, div); } });
    // إصلاح TDZ: كان المتغير `let t` يظلل دالة الترجمة t() في نفس النطاق فيرمي
    // "Cannot access 't' before initialization" عند رسم أي رسالة — سُمّي touchTimer.
    let touchTimer = null;
    div.addEventListener("touchstart", () => { touchTimer = setTimeout(() => showMsgMenu(m, div), 600); });
    div.addEventListener("touchend", () => clearTimeout(touchTimer));
    div.addEventListener("touchmove", () => clearTimeout(touchTimer));
  }

  applySearchFilter(div, m);
  // prepend (P6 — ترقيم الصفحات): يُدرج أعلى القائمة بلا قفزة تمرير؛
  // المسار العادي يضيف أسفل وينزل للآخر كما كان دائماً
  if (opts?.prepend) {
    $("messages").insertBefore(div, $("messages").firstChild);
  } else {
    $("messages").appendChild(div);
    $("messages").scrollTop = $("messages").scrollHeight;
  }
}

// لاصقات التفاعلات لرسالة: 👍2 ❤️1 — مصدرها state._reactions الحيّة
function renderReactionChips(mid) {
  const row = document.createElement("div");
  row.className = "reaction-chips";
  row.dataset.reactionsFor = mid;
  const list = state._reactions.get(mid) || [];
  const counts = new Map();
  for (const r of list) counts.set(r.emoji, (counts.get(r.emoji) || 0) + 1);
  for (const [emoji, count] of counts) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "reaction-chip";
    chip.textContent = count > 1 ? `${emoji} ${count}` : emoji;
    chip.setAttribute("aria-label", `${emoji} ×${count}`);
    chip.onclick = () => api(`/api/messages/${mid}/reaction`, { method: "PUT", body: JSON.stringify({ emoji }) }).catch((e) => showToast(translateErr(e.message), "error"));
    row.appendChild(chip);
  }
  return row;
}

// حدث حي: تفاعل تغيّر على الخادم — حدّث الذاكرة واللاصقات فوراً
function applyReactionUpdate({ messageId, userId, emoji }) {
  const list = (state._reactions.get(messageId) || []).filter((r) => r.userId !== userId);
  if (emoji) list.push({ emoji, userId });
  if (list.length) state._reactions.set(messageId, list); else state._reactions.delete(messageId);
  const old = document.querySelector(`[data-reactions-for="${messageId}"]`);
  if (old) old.replaceWith(renderReactionChips(messageId));
}

// ===== P5: بطاقة الاستطلاع — خيارات قابلة للنقر بعدّ وأشرطة نسب، صوت واحد
// لكل مستخدم (نفسه = سحب، مختلف = تغيير) — تحديث حي عبر message:poll-vote.
function renderPollCard(mid) {
  const card = document.createElement("div");
  card.className = "poll-card";
  card.dataset.pollFor = mid;
  const meta = (state._pollMeta && state._pollMeta.get(mid)) || null;
  if (!meta) { card.textContent = "📊"; return card; }
  const votes = state._pollVotes.get(mid) || [];
  const counts = meta.options.map((_o, i) => votes.filter((v) => v.optionIndex === i).length);
  const total = votes.length;
  const mineIdx = votes.find((v) => v.userId === state.user.id)?.optionIndex ?? null;

  const q = document.createElement("b");
  q.className = "poll-question";
  q.textContent = meta.question;
  card.appendChild(q);

  meta.options.forEach((opt, i) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "poll-option" + (mineIdx === i ? " mine" : "");
    row.setAttribute("aria-label", `${opt} — ${counts[i]}/${total || 0}`);
    const label = document.createElement("span");
    label.className = "poll-label";
    label.textContent = (mineIdx === i ? "● " : "○ ") + opt;
    const n = document.createElement("span");
    n.className = "poll-count";
    n.textContent = String(counts[i]);
    row.append(label, n);
    row.onclick = () =>
      api(`/api/messages/${mid}/poll-vote`, { method: "PUT", body: JSON.stringify({ optionIndex: i }) })
        .catch((e) => showToast(translateErr(e.message), "error"));
    card.appendChild(row);
  });

  const foot = document.createElement("small");
  foot.className = "poll-total";
  foot.textContent = `${t("pollVotes")}: ${total}`;
  card.appendChild(foot);
  return card;
}

// حدث حي: صوت استطلاع تغيّر على الخادم — أعد رسم البطاقة فوراً بلا إعادة جلب
function applyPollVoteUpdate({ messageId, userId, optionIndex }) {
  const list = (state._pollVotes.get(messageId) || []).filter((v) => v.userId !== userId);
  if (optionIndex != null) list.push({ userId, optionIndex });
  if (list.length) state._pollVotes.set(messageId, list); else state._pollVotes.delete(messageId);
  const old = document.querySelector(`[data-poll-for="${messageId}"]`);
  if (old && state._pollMeta?.has(messageId)) old.replaceWith(renderPollCard(messageId));
}

function showMsgMenu(m, msgEl) {
  closeMsgMenu();
  const menu = document.createElement("div");
  menu.className = "msg-menu";
  menu.dataset.msgMenu = "1";
  menu.setAttribute("role", "menu");

  const mine = m.senderId === state.user.id;
  const items = [];

  // شريط التفاعلات (P4 — نمط WhatsApp/Slack): ثمانية إيموجي من القائمة البيضاء
  // للخادم؛ الإيموجي ميتاداتا بلا محتوى فلا يلمس E2EE. ضغط إيموجي موجود مني = سحب.
  const reactions = document.createElement("div");
  reactions.className = "msg-reactions";
  const mineEmoji = (state._reactions.get(m.id) || []).find((r) => r.userId === state.user.id)?.emoji || null;
  for (const emoji of REACTIONS) {
    const rb = document.createElement("button");
    rb.type = "button";
    rb.className = "msg-reaction-btn" + (mineEmoji === emoji ? " mine" : "");
    rb.textContent = emoji;
    rb.setAttribute("aria-label", `${t("react")} ${emoji}`);
    rb.onclick = () => { closeMsgMenu(); api(`/api/messages/${m.id}/reaction`, { method: "PUT", body: JSON.stringify({ emoji }) }).catch((e) => showToast(translateErr(e.message), "error")); };
    reactions.appendChild(rb);
  }
  menu.appendChild(reactions);

  // الرد (P4 — عالمي): يعبّئ شريط الرد فوق حقل الكتابة ويرسل مرجع المعرف فقط
  if (m.id != null) {
    const reply = document.createElement("button");
    reply.type = "button";
    reply.className = "msg-menu-item";
    reply.textContent = "↩ " + t("reply");
    reply.onclick = () => { closeMsgMenu(); state.replyTo = { id: m.id, text: m.text || "", senderName: m.senderName || "" }; updateReplyBar(); $("msg-input").focus(); };
    items.push(reply);
    // حفظ ⭐ (P4 — نمط Telegram): قائمة محفوظات محلية على الجهاز (E2EE آمن)
    const star = document.createElement("button");
    star.type = "button";
    star.className = "msg-menu-item";
    star.textContent = isStarred(m.id) ? "☆ " + t("unstar") : "⭐ " + t("star");
    star.onclick = () => { closeMsgMenu(); toggleStar(m); showToast(isStarred(m.id) ? "⭐ " + t("starredToast") : t("unstarredToast"), "info"); };
    items.push(star);
  }

  // رسائلي: تعديل + حذف (عبر socket كما كان). رسالة غيري ومُتاح لي الإشراف:
  // حذف إشرافي (حذف ناعم REST) + تثبيت. رسائل الملفات لا تُعدّل.
  if (mine && m.type !== "file") {
    const edit = document.createElement("button");
    edit.className = "msg-menu-item";
    edit.textContent = "✏ " + t("editMsg");
    edit.onclick = () => { closeMsgMenu(); editMessage(m); };
    items.push(edit);
    const del = document.createElement("button");
    del.className = "msg-menu-item msg-menu-danger";
    del.textContent = "🗑 " + t("deleteMsg");
    del.onclick = () => { closeMsgMenu(); if (confirm(t("deleteMsgConfirm"))) state.socket.emit("message:delete", { messageId: m.id }); };
    items.push(del);
  } else if (!mine && canModerate()) {
    const del = document.createElement("button");
    del.className = "msg-menu-item msg-menu-danger";
    del.textContent = "🗑 " + t("modDeleteMsg");
    del.onclick = async () => {
      closeMsgMenu();
      if (!confirm(t("deleteMsgConfirm"))) return;
      try { await api(`/api/conversations/${state.activeConv.id}/messages/${m.id}`, { method: "DELETE" }); }
      catch (e) { showToast(translateErr(e.message), "error"); }
    };
    items.push(del);
  }
  // التثبيت متاح للمشرفين على أي رسالة (منها رسائلهم)
  if (canModerate()) {
    const pin = document.createElement("button");
    pin.className = "msg-menu-item";
    pin.textContent = "📌 " + t("pinMsg");
    pin.onclick = async () => {
      closeMsgMenu();
      try { await api(`/api/conversations/${state.activeConv.id}/pin`, { method: "PUT", body: JSON.stringify({ messageId: m.id }) }); }
      catch (e) { showToast(translateErr(e.message), "error"); }
    };
    items.push(pin);
  }
  if (!items.length) return;
  for (const it of items) menu.append(it);
  const rect = msgEl.getBoundingClientRect();
  menu.style.top = Math.min(rect.bottom + 4, window.innerHeight - 120) + "px";
  menu.style.insetInlineStart = "16px";
  document.body.appendChild(menu);
  items[0].focus();
  setTimeout(() => document.addEventListener("click", closeMsgMenu, { once: true }), 0);
}

function closeMsgMenu() { document.querySelectorAll("[data-msg-menu]").forEach(e => e.remove()); }

async function editMessage(m) {
  const current = document.querySelector(`[data-mid="${m.id}"] .text`)?.textContent || "";
  const newText = await textPrompt({ title: t("editMsg"), initial: current });
  if (newText === null || newText === current || !newText.trim()) return;
  if (newText.length > 2000) return showToast(t("maxChars"), "error");
  if (!state.activeKey) return;
  const { ciphertext, iv } = await RasanCrypto.encrypt(state.activeKey, newText.trim());
  state.socket.emit("message:edit", { messageId: m.id, ciphertext, iv });
}

// ===== Sending =====
$("send-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("msg-input").value.trim();
  if (!text || !state.activeKey || !state.activeConv) return;
  const { ciphertext, iv } = await RasanCrypto.encrypt(state.activeKey, text);
  sendOrQueue({
    conversationId: state.activeConv.id, ciphertext, iv, type: "text", ephemeral_ttl: 0,
    key_version: state.activeConv.type === "dm" ? 1 : (state.activeKeyVersion || 1),
    replyTo: state.replyTo?.id ?? null, // مرجع المعرف فقط — النص المقتبس محلي/مشفر
  }, { preview: text, pendingRender: true });
  $("msg-input").value = "";
  clearDraft(state.activeConv.id); // المسودة أُرسلت — امسحها (P5)
  state.replyTo = null;
  updateReplyBar();
});

// حفظ المسودة تلقائياً أثناء الكتابة (P5) — مؤجّل 300ms ومحلي فقط (E2EE آمن)
let _draftTimer = null;
$("msg-input").addEventListener("input", (e) => {
  if (!state.activeConv) return;
  const val = e.target.value, cid = state.activeConv.id;
  clearTimeout(_draftTimer);
  _draftTimer = setTimeout(() => saveDraft(cid, val), 300);
});

// ===== شريط الرد (P4): معاينة مقتبسة فوق حقل الكتابة + زر إلغاء =====
function updateReplyBar() {
  const bar = $("reply-bar");
  if (!bar) return;
  if (state.replyTo) {
    $("reply-preview").textContent = `${state.replyTo.senderName}: ${(state.replyTo.text || "").slice(0, 80)}`;
    bar.classList.remove("hidden");
  } else {
    bar.classList.add("hidden");
    $("reply-preview").textContent = "";
  }
}
$("reply-cancel")?.addEventListener("click", () => { state.replyTo = null; updateReplyBar(); });

// ===== مشاركة الموقع (P4 — نمط Meshtastic GPS): إحداثيات مشفرة E2EE
// نوع location يمر عبر الخادم كما هو — العرض رقاقة + رابط OSM محلياً
$("loc-btn")?.addEventListener("click", () => {
  if (!state.activeKey || !state.activeConv) return;
  if (!navigator.geolocation) return showToast(t("locUnsupported"), "error");
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const loc = { lat: +pos.coords.latitude.toFixed(6), lng: +pos.coords.longitude.toFixed(6) };
      const { ciphertext, iv } = await RasanCrypto.encrypt(state.activeKey, JSON.stringify(loc));
      sendOrQueue({
        conversationId: state.activeConv.id, ciphertext, iv, type: "location", ephemeral_ttl: 0,
        key_version: state.activeConv.type === "dm" ? 1 : (state.activeKeyVersion || 1),
      }, { preview: `📍 ${loc.lat}, ${loc.lng}`, pendingRender: true });
    },
    () => showToast(t("locDenied"), "error"),
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
  );
});

// ===== استطلاعات الرأي (P5 — نمط Telegram/Signal): مؤلّف الاستطلاع — السؤال
// والخيارات تُشفّر كصندوق واحد E2EE قبل الإرسال؛ الخادم يرى فهارس فقط.
function addPollOptionInput() {
  const box = $("poll-options");
  if (box.children.length >= 10) return; // سقف الخادم: option_index ≤ 9
  const input = document.createElement("input");
  input.className = "poll-option-input";
  input.placeholder = `${t("pollOptionPh")} ${box.children.length + 1}`;
  input.maxLength = 120;
  input.autocomplete = "off";
  box.appendChild(input);
}
function resetPollForm() {
  $("poll-question").value = "";
  $("poll-options").innerHTML = "";
  addPollOptionInput(); addPollOptionInput(); // خياران مبدئيان (Telegram)
}
$("poll-btn")?.addEventListener("click", () => {
  if (!state.activeKey || !state.activeConv) return;
  resetPollForm();
  openModal("poll-modal");
});
$("poll-add-option")?.addEventListener("click", addPollOptionInput);
$("close-poll")?.addEventListener("click", () => closeModal("poll-modal"));
$("poll-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const question = $("poll-question").value.trim();
  const options = [...$("poll-options").children].map((i) => i.value.trim()).filter(Boolean);
  if (!question || options.length < 2) return showToast(t("pollNeedsMore"), "error");
  const { ciphertext, iv } = await RasanCrypto.encrypt(state.activeKey, JSON.stringify({ kind: "poll", question, options }));
  sendOrQueue({
    conversationId: state.activeConv.id, ciphertext, iv, type: "poll", ephemeral_ttl: 0,
    key_version: state.activeConv.type === "dm" ? 1 : (state.activeKeyVersion || 1),
  }, { preview: `📊 ${question}`, pendingRender: true });
  closeModal("poll-modal");
});

// ===== رسائل محفوظة لنفسي (P5 — نمط Telegram Saved Messages): مساحة شخصية
// مشفرة DM بعضو واحد — مُكرِرة من الخادم: الاستدعاء المتكرر يعيد نفس المحادثة.
$("saved-btn")?.addEventListener("click", async () => {
  try {
    const { id } = await api("/api/conversations/self", { method: "POST" });
    await loadConversations();
    const conv = state.convs.find((c) => c.id === id);
    if (conv) { openConversation(conv); showToast(t("savedToast"), "info"); }
  } catch (e) { showToast(translateErr(e.message), "error"); }
});

// ===== البحث المحلي (P4 — نمط Signal/Telegram): يبحث في النصوص المفكوكة
// المحلية فقط — الخادم لا يرى ولا يبحث شيئاً (E2EE حقيقي)
$("search-input")?.addEventListener("input", (e) => {
  state.searchQuery = e.target.value.trim().toLowerCase();
  let matches = 0, total = 0;
  for (const div of $("messages").querySelectorAll(".msg")) {
    total++;
    const mid = Number(div.dataset.mid);
    const cached = state._msgCache.get(mid);
    const hay = (cached?.text || div.querySelector(".text")?.textContent || "").toLowerCase();
    const hit = !state.searchQuery || hay.includes(state.searchQuery);
    div.classList.toggle("search-hidden", !hit);
    if (hit && state.searchQuery) matches++;
  }
  $("search-count").textContent = state.searchQuery ? `${matches}/${total}` : "";
});

// فلترة رسالة واحدة حسب البحث الجاري (تُستدعى من appendMessage)
function applySearchFilter(div, m) {
  if (!state.searchQuery) return;
  const hay = (m.text || "").toLowerCase();
  div.classList.toggle("search-hidden", !hay.includes(state.searchQuery));
}

// ===== المحفوظات (P4 — نمط Telegram): قائمة محلية على الجهاز
$("starred-btn")?.addEventListener("click", () => { openModal("starred-modal"); renderStarred(); });
$("close-starred")?.addEventListener("click", () => closeModal("starred-modal"));

// ===== قائمة حظري (P4): تُحمّل عند الدخول وتغذي أزرار الحظر في نافذة الأعضاء
async function loadBlocks() {
  try {
    const { blocks } = await api("/api/users/blocks");
    state._blocked = new Set(blocks.map((b) => b.userId));
  } catch { state._blocked = new Set(); }
}
function renderStarred() {
  const ul = $("starred-list");
  ul.innerHTML = "";
  if (!state.starred.length) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = t("noStarred");
    ul.appendChild(p);
    return;
  }
  for (const s of [...state.starred].sort((a, b) => b.time - a.time)) {
    const li = document.createElement("li");
    li.className = "starred-item";
    li.tabIndex = 0;
    const conv = state.convs.find((c) => c.id === s.convId);
    const name = document.createElement("b");
    name.textContent = `${s.senderName} · ${conv?.name || "DM #" + s.convId}`;
    const txt = document.createElement("span");
    txt.textContent = s.text.slice(0, 120);
    const jump = document.createElement("button");
    jump.type = "button";
    jump.className = "icon";
    jump.textContent = "⤴";
    jump.setAttribute("aria-label", t("jumpToMsg"));
    jump.onclick = async () => {
      closeModal("starred-modal");
      if (state.activeConv?.id !== s.convId) {
        const conv = state.convs.find((c) => c.id === s.convId);
        if (!conv) return;
        await openConversation(conv);
      }
      document.querySelector(`[data-mid="${s.mid}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    };
    const unstar = document.createElement("button");
    unstar.type = "button";
    unstar.className = "icon";
    unstar.textContent = "☆";
    unstar.setAttribute("aria-label", t("unstar"));
    unstar.onclick = () => { toggleStar({ id: s.mid, conversationId: s.convId, text: s.text, senderName: s.senderName, time: s.time }); renderStarred(); };
    li.append(name, txt, jump, unstar);
    li.addEventListener("keydown", (e) => { if (e.key === "Enter") jump.onclick(); });
    ul.appendChild(li);
  }
}

let typingTimer = null;
$("msg-input").addEventListener("input", () => {
  if (!state.activeConv) return;
  state.socket.emit("typing", { conversationId: state.activeConv.id, isTyping: true });
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => state.socket.emit("typing", { conversationId: state.activeConv.id, isTyping: false }), 1500);
});

// ===== Attach file =====
$("attach").addEventListener("click", () => $("file-input").click());
$("file-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  $("file-input").value = "";
  if (!state.activeKey) return showToast(t("keyNotReady"), "error");
  if (file.size > 30 * 1024 * 1024) return showToast(t("maxFileSize"), "error");
  try {
    const buf = await file.arrayBuffer();
    await uploadAndSendAttachment(buf, {
      filename: file.name,
      mime: file.type || "application/octet-stream",
      size: file.size,
    }, file.name);
  } catch (err) {
    console.error(err);
    showToast(t("uploadFailed") + err.message, "error");
    $("upload-status").classList.add("hidden");
  }
});

/** التشفير + الرفع + الإرسال — مسار مشترك بين المرفقات والمذكرات الصوتية. */
async function uploadAndSendAttachment(buf, meta, label) {
  if (!state.activeKey || !state.activeConv) throw new Error("no key");
  try {
    $("upload-status").classList.remove("hidden");
    $("upload-label").textContent = `تشفير ${label}...`;
    $("upload-progress").style.width = "5%";

    const { ciphertext, iv: fileIv } = await RasanCrypto.encryptFile(state.activeKey, buf);

    $("upload-label").textContent = `رفع ${label}...`;
    $("upload-progress").style.width = "20%";

    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/attachments?conversationId=${state.activeConv.id}`);
    xhr.setRequestHeader("Authorization", "Bearer " + state.token);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (ev) => { if (ev.lengthComputable) $("upload-progress").style.width = (20 + Math.round((ev.loaded / ev.total) * 70)) + "%"; };

    const attachmentId = await new Promise((resolve, reject) => {
      xhr.onload = () => { try { const data = JSON.parse(xhr.responseText); if (xhr.status >= 200 && xhr.status < 300) resolve(data.id); else reject(new Error(data.error || "upload failed")); } catch { reject(new Error("bad response")); } };
      xhr.onerror = () => reject(new Error("network error"));
      xhr.send(ciphertext);
    });

    $("upload-label").textContent = "إرسال...";
    $("upload-progress").style.width = "95%";

    const fullMeta = { ...meta, attachmentId, fileIv };
    const { ciphertext: msgCt, iv: msgIv } = await RasanCrypto.encrypt(state.activeKey, JSON.stringify(fullMeta));
    sendOrQueue({
      conversationId: state.activeConv.id, ciphertext: msgCt, iv: msgIv,
      type: "file", attachmentId,
      key_version: state.activeConv.type === "dm" ? 1 : (state.activeKeyVersion || 1),
    }, { preview: meta.kind === "voice" ? "🎤 مذكرة صوتية" : "📎 ملف", pendingRender: true });

    $("upload-progress").style.width = "100%";
    setTimeout(() => $("upload-status").classList.add("hidden"), 400);
  } catch (err) {
    $("upload-status").classList.add("hidden");
    throw err;
  }
}

// ===== المذكرات الصوتية (voice notes — من بحث Zello/واتساب) =====
// تسجيل بالمايكروفون → تشفير → رفع عبر مسار المرفقات → رسالة kind:"voice"
// تُشغّل داخل المحادثة بعنصر audio قياسي (يدعم التشغيل خارج سياق الكتابة).
let mediaRecorder = null, recChunks = [], recTimer = null, recStart = 0, recStream = null;
const VOICE_MAX_MS = 120 * 1000; // حد أقصى دقيقتان كالمذكرات الصوتية المعتادة

$("mic").addEventListener("click", startRecording);

// startRecording(opts) — opts.ptt: يُستدعى من وضع للّكة (PTT).
// ترجع true إذا بدأ التسجيل فعلاً — وfalse عند الرفض/الإلغاء المبكر
// (مثلاً أُفلت زر للّكة قبل جهوزية المايك — فلا يبقى تسجيل يتيم).

// startRecording(opts) — opts.ptt: يُستدعى من وضع للّكة (PTT).
// ترجع true إذا بدأ التسجيل فعلاً — وfalse عند الرفض/الإلغاء المبكر
// (مثلاً أُفلت زر للّكة قبل جهوزية المايك — فلا يبقى تسجيل يتيم).

async function startRecording(opts = {}) {
  if (!state.activeConv) return false;
  if (!state.activeKey) { showToast(t("keyNotReady"), "error"); return false; }
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    showToast("التسجيل الصوتي غير مدعوم في هذا المتصفح", "error");
    return false;
  }
  try {
    recStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch { return showToast("تعذر الوصول إلى الميكروفون", "error"); }

  // وضع للّكة (PTT): أُفلت الزر قبل جهوزية المايك؟ ألغِ فوراً وبلا تسجيل
  if (opts?.ptt === true && !pttState.holding) {
    recStream.getTracks().forEach((tr) => tr.stop());
    recStream = null;
    return false;
  }

  const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find(m => {
    try { return MediaRecorder.isTypeSupported?.(m); } catch { return false; }
  });
  try {
    mediaRecorder = new MediaRecorder(recStream, mime ? { mimeType: mime } : undefined);
  } catch { recStream.getTracks().forEach(tr => tr.stop()); return showToast("التسجيل الصوتي غير مدعوم", "error"); }

  recChunks = [];
  mediaRecorder.ondataavailable = (e) => { if (e.data?.size) recChunks.push(e.data); };
  mediaRecorder.start(250);
  recStart = Date.now();

  $("send-form").classList.add("hidden");
  $("recording-bar").classList.remove("hidden");
  $("rec-timer").textContent = "0:00";
  recTimer = setInterval(() => {
    const s = Math.floor((Date.now() - recStart) / 1000);
    $("rec-timer").textContent = Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
    if (Date.now() - recStart >= VOICE_MAX_MS) sendVoiceNote(); // توقف تلقائي عند الحد
  }, 250);
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
  recStream?.getTracks().forEach(tr => tr.stop());
  recStream = null;
  clearInterval(recTimer);
  $("recording-bar").classList.add("hidden");
  // في وضع للّكة يبقى شريط الزر الكبير ظاهراً — لا نُعيد حقل الكتابة
  if (typeof pttState !== "undefined" && pttState.mode) $("send-form").classList.add("hidden");
  else $("send-form").classList.remove("hidden");
}

$("rec-cancel").addEventListener("click", () => { stopRecording(); recChunks = []; });
$("rec-send").addEventListener("click", sendVoiceNote);

// ===== وضع للّكة (PTT — من بحث الميزات: نمط Zello/WhatsApp Walkie-Talkie) =====
// زر "استمرار الضغط للتحدث": ضغط = تسجيل، إفلات = إرسال مشفّر فوري عبر مسار
// المذكرات الصوتية نفسه (نفس التشفير E2EE ونفس المرفقات). سحب خارج الزر =
// إلغاء. الحد الأدنى 800ms يمنع اللمسات العابرة من إرسال مذكرات فارغة.
const pttState = { mode: localStorage.getItem("rasan_ptt_mode") === "on", holding: false, startedAt: 0 };
const PTT_MIN_MS = 800;

function applyPttMode() {
  // في وضع للّكة يُستبدل حقل الكتابة بأكبُر زر ضغط-مستمر
  $("send-form").classList.toggle("hidden", pttState.mode);
  $("ptt-bar").classList.toggle("hidden", !pttState.mode);
  $("ptt-toggle").setAttribute("aria-pressed", pttState.mode ? "true" : "false");
  $("ptt-toggle").textContent = pttState.mode ? "🗣 ✓" : "🗣";
}

$("ptt-toggle").addEventListener("click", () => {
  pttState.mode = !pttState.mode;
  localStorage.setItem("rasan_ptt_mode", pttState.mode ? "on" : "off");
  applyPttMode();
  showToast(pttState.mode ? t("pttOn") : t("pttOff"), "info");
});

async function pttStart() {
  if (pttState.holding || !state.activeConv) return;
  pttState.holding = true;
  pttState.startedAt = Date.now();
  $("ptt-btn").classList.add("holding");
  const ok = await startRecording({ ptt: true });
  if (!ok) { pttState.holding = false; $("ptt-btn").classList.remove("holding"); }
}

function pttStop({ send = true } = {}) {
  if (!pttState.holding) return;
  pttState.holding = false;
  $("ptt-btn").classList.remove("holding");
  const heldMs = Date.now() - pttState.startedAt;
  const recording = mediaRecorder && mediaRecorder.state !== "inactive";
  if (!recording) return;
  if (send && heldMs >= PTT_MIN_MS) sendVoiceNote(); // إفلات طويل كفاية → إرسال مشفّر
  else { stopRecording(); recChunks = []; if (heldMs < PTT_MIN_MS) showToast(t("pttTooShort"), "info"); }
}

function pttCancel() { pttStop({ send: false }); }

$("ptt-btn").addEventListener("pointerdown", (e) => { e.preventDefault(); pttStart(); });
$("ptt-btn").addEventListener("pointerup", (e) => { e.preventDefault(); pttStop(); });
$("ptt-btn").addEventListener("pointerleave", pttCancel);  // سحب خارج الزر = إلغاء
$("ptt-btn").addEventListener("pointercancel", pttCancel);
$("ptt-btn").addEventListener("contextmenu", (e) => e.preventDefault()); // ضغط طويل على الجوال لا يفتح القائمة
// إتاحة لوحة المفاتيح: ضغط مفتاح = تسجيل، إفلاته = إرسال (بلا تكرار auto-repeat)
$("ptt-btn").addEventListener("keydown", (e) => { if ((e.key === " " || e.key === "Enter") && !e.repeat) { e.preventDefault(); pttStart(); } });
$("ptt-btn").addEventListener("keyup", (e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); pttStop(); } });

async function sendVoiceNote() {
  if (!mediaRecorder || mediaRecorder.state === "inactive") return;
  const durationMs = Date.now() - recStart;
  const mime = mediaRecorder.mimeType || "audio/webm";
  stopRecording();
  if (!recChunks.length) { recChunks = []; return; }
  const blob = new Blob(recChunks, { type: mime });
  recChunks = [];
  if (blob.size > 30 * 1024 * 1024) return showToast(t("maxFileSize"), "error");
  const secs = Math.max(1, Math.round(durationMs / 1000));
  const ext = mime.includes("mp4") ? "m4a" : "webm";
  try {
    const buf = await blob.arrayBuffer();
    await uploadAndSendAttachment(buf, {
      kind: "voice",
      filename: `voice-note.${ext}`,
      mime: mime.split(";")[0],
      size: blob.size,
      durationMs,
    }, "المذكرة الصوتية");
  } catch (err) {
    console.error(err);
    showToast(t("uploadFailed") + err.message, "error");
  }
}

// ===== New DM =====
async function createDM(username, errEl) {
  try {
    const { user: peer } = await api(`/api/auth/users/${encodeURIComponent(username.trim())}`);
    if (!peer.public_key) throw new Error(t("noPeerKey"));
    const { id } = await api("/api/conversations", { method: "POST", body: JSON.stringify({ type: "dm", members: [username.trim()] }) });
    state.activeKey = await RasanCrypto.deriveShared(state.myKeys.privateKey, peer.public_key);
    await loadConversations();
    const conv = state.convs.find(c => c.id === id);
    if (conv) { conv._peer = peer; closeModal("dm-modal"); openConversation(conv); }
  } catch (err) {
    if (errEl) errEl.textContent = translateErr(err.message);
    else showToast(translateErr(err.message), "error");
  }
}

// ===== New chat: choice menu (replaces window.prompt) =====
$("new-chat").addEventListener("click", () => openModal("new-chat-modal"));
$("new-group").addEventListener("click", () => openModal("group-modal"));
$("choice-dm").addEventListener("click", () => { closeModal("new-chat-modal"); $("dm-username").value = ""; $("dm-err").textContent = ""; openModal("dm-modal"); });
$("choice-group").addEventListener("click", () => { closeModal("new-chat-modal"); $("group-err").textContent = ""; openModal("group-modal"); });
$("close-new-chat").addEventListener("click", () => closeModal("new-chat-modal"));
$("close-dm").addEventListener("click", () => closeModal("dm-modal"));
$("create-dm").addEventListener("click", () => {
  const username = $("dm-username").value.trim();
  if (!username) { $("dm-err").textContent = t("dmRequired"); return; }
  createDM(username, $("dm-err"));
});

$("close-group").addEventListener("click", () => closeModal("group-modal"));
$("create-group").addEventListener("click", async () => {
  const name = $("group-name").value.trim();
  const desc = $("group-desc").value.trim();
  const members = $("group-members").value.split(",").map(s => s.trim()).filter(Boolean);
  const type = $("group-type").value;
  if (!name) { $("group-err").textContent = t("groupNameRequired"); return; }
  $("group-err").textContent = "";
  try {
    const { id } = await api("/api/conversations", { method: "POST", body: JSON.stringify({ type, name, description: desc, members: [] }) });
    const added = [];
    const failed = [];
    for (const uname of members) {
      try { const r = await api(`/api/conversations/${id}/members`, { method: "POST", body: JSON.stringify({ username: uname }) }); added.push(r.member); } catch { failed.push(uname); }
    }
    const groupKey = await RasanCrypto.generateGroupKey();
    const entries = [];
    const selfWrapped = await RasanCrypto.wrapGroupKeyForMember(groupKey, state.myKeys.privateKey, state.myKeys.publicKey);
    entries.push({ userId: state.user.id, ...selfWrapped });
    for (const m of added) {
      if (!m.public_key) continue;
      const wrapped = await RasanCrypto.wrapGroupKeyForMember(groupKey, state.myKeys.privateKey, m.public_key);
      entries.push({ userId: m.id, ...wrapped });
    }
    await api(`/api/conversations/${id}/group-key/bulk`, { method: "POST", body: JSON.stringify({ entries, key_version: 1 }) });
    await loadConversations();
    closeModal("group-modal");
    const conv = state.convs.find(c => c.id === id);
    if (conv) { state.activeKey = groupKey; state.activeKeyVersion = 1; openConversation(conv); }
    if (failed.length) showToast(t("membersNotFound") + " " + failed.join(", "), "error");
  } catch (err) { $("group-err").textContent = translateErr(err.message); }
});

// ===== Key rotation =====
async function rotateGroupKey(conv) {
  if (!state.myKeys) throw new Error("no local keypair");
  if (conv.type === "dm") return;
  const { members } = await api(`/api/conversations/${conv.id}/members`);
  const newGroupKey = await RasanCrypto.generateGroupKey();
  const entries = [];
  for (const m of members) {
    if (!m.public_key) continue;
    const wrapped = await RasanCrypto.wrapGroupKeyForMember(newGroupKey, state.myKeys.privateKey, m.public_key);
    entries.push({ userId: m.id, ...wrapped });
  }
  const ks = await api(`/api/conversations/${conv.id}/key-state`);
  const newVersion = ks.current + 1;
  await api(`/api/conversations/${conv.id}/group-key/bulk`, { method: "POST", body: JSON.stringify({ entries, key_version: newVersion }) });
  if (state.activeConv?.id === conv.id) { state.activeKey = newGroupKey; state.activeKeyVersion = newVersion; }
  return newVersion;
}

// ===== إنذار الطوارئ (من بحث Zello — بث فوري لكل الأعضاء) =====
let emergencyTimer = null;
$("emergency-btn").addEventListener("click", async () => {
  if (!state.activeConv) return;
  if (!confirm("إطلاق إنذار طوارئ لكل أعضاء هذه المحادثة؟")) return;
  try {
    await api(`/api/conversations/${state.activeConv.id}/emergency`, { method: "POST", body: JSON.stringify({}) });
    showToast("تم إطلاق الإنذار لكل الأعضاء", "success");
  } catch (err) {
    if (String(err.message).includes("cooldown")) showToast("أرسلت إنذاراً مؤخراً — انتظر دقيقة", "error");
    else showToast(translateErr(err.message), "error");
  }
});

$("emergency-dismiss").addEventListener("click", () => {
  $("emergency-banner").classList.add("hidden");
  clearTimeout(emergencyTimer);
});

function showEmergencyBanner(byName) {
  $("emergency-text").textContent = `إنذار طوارئ من ${byName}`;
  $("emergency-banner").classList.remove("hidden");
  clearTimeout(emergencyTimer);
  emergencyTimer = setTimeout(() => $("emergency-banner").classList.add("hidden"), 30000);
}

// زر «تحميل الأقدم» (P6 — ترقيم صفحات التاريخ)
$("load-older")?.addEventListener("click", loadOlder);

// ===== Back / Logout =====
$("back").addEventListener("click", () => {
  state.activeConv = null; state.activeKey = null;
  $("chat").classList.add("hidden"); $("list").classList.remove("hidden");
  $("back").classList.add("hidden"); $("title").textContent = "رسن";
  // أزرار المحادثة (طوارئ/مكالمة/إشراف) لا معنى لها خارج محادثة مفتوحة
  $("call-btn").classList.add("hidden");
  $("video-call-btn").classList.add("hidden");
  $("group-call-btn").classList.add("hidden");
  $("members-btn").classList.add("hidden");
  $("emergency-btn").classList.add("hidden");
  $("pinned-banner").classList.add("hidden");
  $("load-older")?.classList.add("hidden"); // P6: زر الأقدم لا معنى له خارج محادثة
  window.dispatchEvent(new CustomEvent("rasan:conv-close"));
});

$("logout").addEventListener("click", () => { localStorage.removeItem("rasan_token"); location.reload(); });

// ===== Rotate key button =====
$("rotate-key").addEventListener("click", async () => {
  if (!state.activeConv || state.activeConv.type === "dm") return;
  if (!confirm(t("rotateConfirm"))) return;
  try { const v = await rotateGroupKey(state.activeConv); showToast(t("rotatedTo") + " " + v, "success"); } catch (e) { showToast(translateErr(e.message), "error"); }
});

// ===== Stories =====
$("stories-btn").addEventListener("click", async () => { openModal("stories"); await loadStories(); });
$("close-stories").addEventListener("click", () => closeModal("stories"));
async function loadStories() {
  const { stories } = await api("/api/stories");
  const list = $("stories-list");
  list.innerHTML = "";
  for (const s of stories) {
    const div = document.createElement("div");
    div.className = "story-item";
    div.innerHTML = `<b>${escapeHtml(s.username)}</b><p>🔒 (encrypted)</p><small>${new Date(s.createdAt).toLocaleString()}</small>`;
    div.addEventListener("click", () => api(`/api/stories/${s.id}/view`, { method: "POST" }).catch(() => {}));
    list.appendChild(div);
  }
}
$("story-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("story-text").value.trim();
  if (!text) return;
  let selfKey = await idbGet("selfStoryKey");
  if (!selfKey) { const k = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]); selfKey = await RasanCrypto.exportAesKey(k); await idbPut("selfStoryKey", selfKey); }
  const key = await RasanCrypto.importAesKey(selfKey);
  const { ciphertext, iv } = await RasanCrypto.encrypt(key, text);
  await api("/api/stories", { method: "POST", body: JSON.stringify({ ciphertext, iv, type: "text" }) });
  $("story-text").value = "";
  await loadStories();
});

// ===== File message rendering =====
function appendFileMessage(m, meta, opts) {
  const div = document.createElement("div");
  div.className = "msg " + (m.senderId === state.user.id ? "mine" : "other");
  div.dataset.mid = m.id;
  if (m.clientId && m.senderId === state.user.id) div.dataset.cid = m.clientId;

  const b = document.createElement("b"); b.textContent = m.senderName;
  const isVoice = meta.kind === "voice" || (meta.mime || "").startsWith("audio/");
  const dur = meta.durationMs ? ` — ${Math.floor(meta.durationMs / 60000)}:${String(Math.round((meta.durationMs % 60000) / 1000)).padStart(2, "0")}` : "";
  const att = document.createElement("div"); att.className = "attachment";
  att.innerHTML = `<div class="file-card"><span class="icon">${isVoice ? "🎤" : "⏳"}</span><div class="meta"><b>${isVoice ? "مذكرة صوتية" : escapeHtml(meta.filename)}</b><small>${formatSize(meta.size)}${isVoice ? dur : " — جاري التحميل..."}</small></div></div>`;
  const small = document.createElement("small"); small.textContent = new Date(m.time).toLocaleTimeString(state.locale, { hour: "2-digit", minute: "2-digit" });

  div.append(b, att, small);
  if (opts?.prepend) {
    $("messages").insertBefore(div, $("messages").firstChild);
  } else {
    $("messages").appendChild(div);
    $("messages").scrollTop = $("messages").scrollHeight;
  }

  loadAndDisplayAttachment(meta, att).catch(() => {
    att.innerHTML = `<div class="file-card"><span class="icon">❌</span><div class="meta"><b>${escapeHtml(meta.filename)}</b><small>فشل التحميل</small></div></div>`;
  });
}

async function loadAndDisplayAttachment(meta, container) {
  const res = await fetch(`/api/attachments/${meta.attachmentId}`, { headers: { Authorization: "Bearer " + state.token } });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const ctBuf = await res.arrayBuffer();
  const ptBuf = await RasanCrypto.decryptFile(state.activeKey, ctBuf, meta.fileIv);
  const blob = new Blob([ptBuf], { type: meta.mime });
  const url = URL.createObjectURL(blob);
  container.innerHTML = "";
  if (meta.mime.startsWith("image/")) {
    const img = document.createElement("img"); img.src = url; img.alt = meta.filename; img.loading = "lazy"; img.decoding = "async"; img.addEventListener("click", () => window.open(url, "_blank")); container.appendChild(img);
  } else if (meta.mime.startsWith("video/")) {
    const v = document.createElement("video"); v.src = url; v.controls = true; v.preload = "metadata"; container.appendChild(v);
  } else if (meta.mime.startsWith("audio/")) {
    const a = document.createElement("audio"); a.src = url; a.controls = true; a.preload = "none"; container.appendChild(a);
  } else {
    const card = document.createElement("a"); card.className = "file-card"; card.href = url; card.download = meta.filename;
    card.innerHTML = `<span class="icon">📄</span><div class="meta"><b>${escapeHtml(meta.filename)}</b><small>${formatSize(meta.size)} — اضغط للتحميل</small></div>`;
    container.appendChild(card);
  }
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }

// ===== المكالمات الصوتية/المرئية (WebRTC — من بحث الميزات P1: نمط Meshenger/Zello) =====
// الوسائط تسير طرف-لطرف مباشرة مشفّرة DTLS-SRTP — الخادم موجّه إشارات فقط
// (SDP/ICE بحجم محدود ومع اقتران مُتحقّق منه). بلا تخزين ولا سجل.
const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];
const RING_TIMEOUT_MS = 45000;
let call = null;           // حالة المكالمة الحالية (null = لا مكالمة)
let callTimer = null;      // مؤقّت عرض المدة
let ringingTimeout = null; // مهلة الرنين قبل الإلغاء التلقائي

function callSupported() {
  return typeof RTCPeerConnection !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
}

function teardownCall() {
  clearTimeout(ringingTimeout); ringingTimeout = null;
  clearInterval(callTimer); callTimer = null;
  if (call?.local) { try { call.local.getTracks().forEach((tr) => tr.stop()); } catch {} }
  if (call?.pc) { try { call.pc.close(); } catch {} }
  call = null;
  $("remote-video").srcObject = null;
  $("local-video").srcObject = null;
  $("call-overlay").classList.add("hidden");
  $("call-overlay").classList.remove("has-video");
  $("call-mic").textContent = "🎙";
  $("call-cam").textContent = "🎥";
}

function callShowUI({ title, status, mode }) {
  // mode: incoming (عرض وارد) | outgoing (يرن) | active (في مكالمة)
  $("call-title").textContent = title;
  $("call-status").textContent = status;
  $("call-overlay").classList.remove("hidden");
  $("call-accept").classList.toggle("hidden", mode !== "incoming");
  $("call-reject").classList.toggle("hidden", mode === "outgoing");
  $("call-hangup").classList.toggle("hidden", mode === "incoming");
  $("call-mic").classList.toggle("hidden", mode === "incoming");
  $("call-cam").classList.toggle("hidden", mode === "incoming" || !(call && call.video));
  const showVideo = mode === "active" && call && call.video;
  $("remote-video").classList.toggle("hidden", !showVideo);
  $("local-video").classList.toggle("hidden", !showVideo);
  $("call-overlay").classList.toggle("has-video", !!showVideo);
}

function startCallTimer() {
  if (!call || call.startedAt) return;
  call.startedAt = Date.now();
  callTimer = setInterval(() => {
    if (!call?.startedAt) return;
    const s = Math.floor((Date.now() - call.startedAt) / 1000);
    $("call-status").textContent = Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }, 1000);
}

function createPC() {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  call.pc = pc;
  pc.onicecandidate = (e) => {
    if (e.candidate && call && state.socket) state.socket.emit("call:ice", { toUserId: call.peerId, candidate: JSON.stringify(e.candidate) });
  };
  pc.ontrack = (e) => {
    if (!call) return;
    $("remote-video").srcObject = e.streams[0] || new MediaStream([e.track]);
  };
  pc.onconnectionstatechange = () => {
    if (!call || call.pc !== pc) return;
    if (pc.connectionState === "connected") startCallTimer();
    if (["failed", "disconnected", "closed"].includes(pc.connectionState)) {
      const wasActive = call.startedAt > 0;
      teardownCall();
      if (wasActive) showToast(t("callEnded"), "info");
    }
  };
  return pc;
}

async function flushPendingIce() {
  if (!call?.pc) return;
  const list = call.pendingIce.splice(0);
  for (const c of list) { try { await call.pc.addIceCandidate(JSON.parse(c)); } catch {} }
}

async function startCall(video) {
  const conv = state.activeConv;
  if (!conv || conv.type !== "dm" || !conv._peer) return;
  if (call) { showToast(t("callBusySelf"), "error"); return; }
  if (!callSupported()) { showToast(t("callUnsupported"), "error"); return; }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: video ? { width: 640 } : false });
  } catch { showToast(t("callPermissionDenied"), "error"); return; }
  call = { role: "caller", peerId: conv._peer.id, peerName: conv._peer.username || conv.name || "DM", convId: conv.id, video: !!video, local: stream, pc: null, startedAt: 0, pendingIce: [], muted: false, camOn: !!video };
  callShowUI({ title: call.peerName, status: t("ringing"), mode: "outgoing" });
  try {
    const pc = createPC();
    stream.getTracks().forEach((tr) => pc.addTrack(tr, stream));
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    state.socket.emit("call:offer", { conversationId: conv.id, toUserId: call.peerId, sdp: JSON.stringify(pc.localDescription), video: !!video });
  } catch { showToast(t("callFailed"), "error"); teardownCall(); return; }
  ringingTimeout = setTimeout(() => {
    if (call && !call.startedAt) { teardownCall(); showToast(t("callNoAnswer"), "info"); }
  }, RING_TIMEOUT_MS);
}

/** ربط أحداث إشارات المكالمات على مقبس حيّ — يُستدعى من connectSocket. */
function bindCallEvents() {
  state.socket.on("call:offer", ({ from, fromName, conversationId, sdp, video }) => {
    if (call) return; // الخادم يمنع الانشغال المزدوج — حماية مزدوجة هنا
    if (!callSupported()) { state.socket.emit("call:reject", { toUserId: from }); return; }
    call = { role: "callee", peerId: from, peerName: fromName, convId: conversationId, video: !!video, local: null, pc: null, startedAt: 0, pendingIce: [], offer: sdp, muted: false, camOn: false };
    callShowUI({ title: fromName, status: video ? t("incomingVideoCall") : t("incomingCall"), mode: "incoming" });
    ringingTimeout = setTimeout(() => {
      if (call && !call.startedAt) { state.socket.emit("call:reject", { toUserId: call.peerId }); teardownCall(); }
    }, RING_TIMEOUT_MS);
  });

  state.socket.on("call:answer", async ({ from, sdp }) => {
    if (!call || call.role !== "caller" || call.peerId !== from) return;
    clearTimeout(ringingTimeout);
    try {
      await call.pc.setRemoteDescription(JSON.parse(sdp));
      await flushPendingIce();
      $("call-status").textContent = t("connecting");
    } catch { showToast(t("callFailed"), "error"); state.socket.emit("call:end", { toUserId: from }); teardownCall(); }
  });

  state.socket.on("call:ice", async ({ from, candidate }) => {
    if (!call || call.peerId !== from || typeof candidate !== "string") return;
    // قد تصل المرشحات قبل جهوزية الوصف البعيد — تُخزّن مؤقتاً ثم تُفرَّغ
    if (!call.pc || !call.pc.remoteDescription) { call.pendingIce.push(candidate); return; }
    try { await call.pc.addIceCandidate(JSON.parse(candidate)); } catch {}
  });

  state.socket.on("call:reject", ({ from }) => {
    if (!call || call.peerId !== from) return;
    teardownCall();
    showToast(t("callRejected"), "info");
  });

  state.socket.on("call:end", ({ from, reason }) => {
    if (!call || call.peerId !== from) return;
    teardownCall();
    showToast(reason === "disconnect" ? t("callDisconnected") : t("callEnded"), "info");
  });

  state.socket.on("call:busy", () => {
    if (!call || call.role !== "caller" || call.startedAt) return;
    teardownCall();
    showToast(t("callBusy"), "error");
  });

  state.socket.on("call:unavailable", () => {
    if (!call || call.role !== "caller" || call.startedAt) return;
    teardownCall();
    showToast(t("callUnavailable"), "error");
  });

  state.socket.on("call:error", ({ reason }) => {
    if (!call || call.role !== "caller" || call.startedAt) return;
    teardownCall();
    showToast(reason === "forbidden" ? t("callForbidden") : t("callFailed"), "error");
  });
}

// أزرار طبقة المكالمة (عناصر ثابتة في الصفحة — تُربط مرة واحدة)
$("call-btn").addEventListener("click", () => startCall(false));
$("video-call-btn").addEventListener("click", () => startCall(true));
$("call-hangup").addEventListener("click", () => {
  // المكالمة الجماعية أولاً — المساران لا يتشاركان حالة أبداً (الخادم يمنع الازدواج)
  if (gcall) { teardownGroupCall(); return; }
  if (call && state.socket) state.socket.emit("call:end", { toUserId: call.peerId });
  teardownCall();
});
$("call-reject").addEventListener("click", () => {
  // رفض مكالمة جماعية واردة = تجاهل فقط (لا حالة تُرفض لدى الخادم)
  if (gcallIncoming) { gcallIncoming = null; teardownGroupCall(false); return; }
  if (call && state.socket) state.socket.emit("call:reject", { toUserId: call.peerId });
  teardownCall();
});
$("call-accept").addEventListener("click", async () => {
  // قبول مكالمة جماعية واردة = انضمام للغرفة القائمة (server/groupcalls.js)
  if (!call && gcallIncoming) { const c = gcallIncoming; gcallIncoming = null; await joinGroupCall(c); return; }
  if (!call || call.role !== "callee") return;
  clearTimeout(ringingTimeout);
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: call.video ? { width: 640 } : false });
    call.local = stream;
    const pc = createPC();
    stream.getTracks().forEach((tr) => pc.addTrack(tr, stream));
    await pc.setRemoteDescription(JSON.parse(call.offer));
    const ans = await pc.createAnswer();
    await pc.setLocalDescription(ans);
    state.socket.emit("call:answer", { toUserId: call.peerId, sdp: JSON.stringify(pc.localDescription) });
    await flushPendingIce();
    callShowUI({ title: call.peerName, status: t("connecting"), mode: "active" });
  } catch { showToast(t("callFailed"), "error"); if (state.socket && call) state.socket.emit("call:end", { toUserId: call.peerId }); teardownCall(); }
});
$("call-mic").addEventListener("click", () => {
  // كتم في المكالمة الجماعية يعمل على مسار الوسائط الجماعي
  const local = call?.local || gcall?.local;
  if (!local) return;
  const mutedNow = call ? !call.muted : !gcall.muted;
  if (call) call.muted = !call.muted; else gcall.muted = !gcall.muted;
  local.getAudioTracks().forEach((tr) => { tr.enabled = !(call ? call.muted : gcall.muted); });
  $("call-mic").textContent = mutedNow ? "🔇" : "🎙";
  $("call-mic").setAttribute("aria-label", mutedNow ? t("micOff") : t("micOn"));
});
$("call-cam").addEventListener("click", () => {
  if (!call?.local) return;
  call.camOn = !call.camOn;
  call.local.getVideoTracks().forEach((tr) => { tr.enabled = call.camOn; });
  $("call-cam").textContent = call.camOn ? "🎥" : "🚫";
});
window.addEventListener("pagehide", () => {
  if (call && state.socket) state.socket.emit("call:end", { toUserId: call.peerId });
  if (gcall && state.socket) state.socket.emit("groupcall:leave", { conversationId: gcall.convId });
});

// ===== المكالمات الجماعية (WebRTC mesh — للمجموعات والقنوات؛ يكمل بحث الميزات P1) =====
// كل مشارك يربط اتصالاً مباشراً مع كل مشارك (mesh حتى 8). الوسائط طرف-لطرف
// مشفّرة DTLS-SRTP — الخادم موجّه إشارات فقط (server/groupcalls.js). قاعدة
// بلا-تضارب: **المنضمّ الأحدث يرسل العروض** لكل القائمين — فلا يرسل اثنان
// عرضاً لبعضهما أبداً. صوت فقط — الفيديو الجماعي يتطلب SFU ولم يدخل النطاق.
let gcall = null;          // حالة المكالمة الجماعية الحالية (null = لا مكالمة)
let gcallIncoming = null;  // حالة "مكالمة جماعية جارية" المعروضة للانضمام
let gcallIgnored = null;   // { conversationId, startedAt } — مكالمة تجاهلتها فلا تعرض ثانية
let gcallTimer = null;     // مؤقّت مدة المكالمة

function gcallSupported() {
  return typeof RTCPeerConnection !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
}

/** نظّف كل أثر المكالمة الجماعية محلياً — notify=false عند الانقطاع بالفعل. */
function teardownGroupCall(notify = true) {
  clearInterval(gcallTimer); gcallTimer = null;
  if (gcall) {
    if (notify && state.socket?.connected) state.socket.emit("groupcall:leave", { conversationId: gcall.convId });
    for (const pc of gcall.pcs.values()) { try { pc.close(); } catch {} }
    if (gcall.local) { try { gcall.local.getTracks().forEach((tr) => tr.stop()); } catch {} }
  }
  gcall = null; gcallIncoming = null;
  document.querySelectorAll("audio[data-gcall-audio]").forEach((el) => el.remove());
  $("call-participants").classList.add("hidden");
  $("call-participants").innerHTML = "";
  // لا نخفي الطبقة إن كانت تعرض مكالمة ثنائية قائمة (المساران منفصلان)
  if (!call) $("call-overlay").classList.add("hidden");
  $("call-mic").textContent = "🎙";
}

/** واجهة طبقة المكالمة الجماعية — نفس عناصر طبقة الثنائية + قائمة المشاركين. */
function gcallShowUI({ title, status, mode }) {
  // mode: incoming (عرض للانضمام) | active (في المكالمة)
  $("call-title").textContent = title;
  $("call-status").textContent = status;
  $("call-overlay").classList.remove("hidden");
  $("call-overlay").classList.remove("has-video");
  $("remote-video").classList.add("hidden");
  $("local-video").classList.add("hidden");
  $("call-accept").classList.toggle("hidden", mode !== "incoming");
  $("call-reject").classList.toggle("hidden", mode !== "incoming");
  $("call-hangup").classList.toggle("hidden", mode === "incoming");
  $("call-mic").classList.toggle("hidden", mode === "incoming");
  $("call-cam").classList.add("hidden");
  $("call-participants").classList.toggle("hidden", mode !== "active");
}

function renderParticipants(participants) {
  const ul = $("call-participants");
  ul.innerHTML = "";
  for (const p of participants) {
    const li = document.createElement("li");
    li.textContent = p.userId === state.user.id ? `${p.name} (${t("you")})` : p.name;
    ul.appendChild(li);
  }
}

/** اتصال مباشر واحد مع مشارك — offerer: أنا (المنضم الأحدث) أو answerer. */
function getOrCreatePeerPC(peerId, { offerer }) {
  let pc = gcall.pcs.get(peerId);
  if (pc) return pc;
  pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  gcall.pcs.set(peerId, pc);
  gcall.local.getTracks().forEach((tr) => pc.addTrack(tr, gcall.local));
  pc.onicecandidate = (e) => {
    if (e.candidate && gcall && state.socket)
      state.socket.emit("gcall:ice", { conversationId: gcall.convId, toUserId: peerId, candidate: JSON.stringify(e.candidate) });
  };
  pc.ontrack = (e) => {
    // عنصر صوت لكل مشارك — يُنظف كله في teardownGroupCall
    let audio = document.querySelector(`audio[data-gcall-audio="${peerId}"]`);
    if (!audio) {
      audio = document.createElement("audio");
      audio.autoplay = true;
      audio.dataset.gcallAudio = String(peerId);
      document.body.appendChild(audio);
    }
    audio.srcObject = e.streams[0] || new MediaStream([e.track]);
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed") { try { pc.close(); } catch {} gcall?.pcs.delete(peerId); }
  };
  return pc;
}

/** المنضم الأحدث: يرسل عرضاً لكل مشارك قائم (قاعدة بلا-تضارب). */
async function offerToPeer(peer) {
  const pc = getOrCreatePeerPC(peer.userId, { offerer: true });
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  state.socket.emit("gcall:offer", { conversationId: gcall.convId, toUserId: peer.userId, sdp: JSON.stringify(pc.localDescription) });
}

async function startGroupCall() {
  const conv = state.activeConv;
  if (!conv || conv.type === "dm") return;
  if (gcall) { showToast(t("callBusySelf"), "error"); return; }
  if (call) { showToast(t("callBusySelf"), "error"); return; } // في مكالمة ثنائية
  if (!gcallSupported()) { showToast(t("callUnsupported"), "error"); return; }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch { showToast(t("callPermissionDenied"), "error"); return; }
  gcall = { convId: conv.id, local: stream, pcs: new Map(), muted: false, startedAt: 0, participants: [] };
  gcallIgnored = null; // أنت بدأت المكالمة — لا تجاهل لحالتها
  gcallShowUI({ title: conv.name || t("groupCall"), status: t("gcallJoining"), mode: "active" });
  state.socket.emit("groupcall:start", { conversationId: conv.id });
}

/** انضمام لمكالمة جماعية جارية (زر الانضمام/القبول). */
async function joinGroupCall(incoming) {
  const conv = state.activeConv;
  if (gcall || call || !gcallSupported()) { showToast(t("callBusySelf"), "error"); return; }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch { showToast(t("callPermissionDenied"), "error"); return; }
  gcall = { convId: incoming.conversationId, local: stream, pcs: new Map(), muted: false, startedAt: 0, participants: incoming.participants || [] };
  gcallShowUI({ title: conv?.name || t("groupCall"), status: t("gcallJoining"), mode: "active" });
  renderParticipants(gcall.participants);
  state.socket.emit("groupcall:start", { conversationId: incoming.conversationId });
}

/** ربط أحداث إشارات المكالمة الجماعية — يُستدعى من connectSocket. */
function bindGroupCallEvents() {
  // تأكيد الخادم لانضمامي: قائمة المشاركين القائمين — أنا أعرض عليهم جميعاً
  state.socket.on("groupcall:joined", async ({ conversationId, peers, startedAt }) => {
    if (!gcall || gcall.convId !== conversationId) return;
    gcall.startedAt = startedAt || Date.now();
    gcall.participants = [{ userId: state.user.id, name: state.user.username }, ...peers];
    renderParticipants(gcall.participants);
    $("call-status").textContent = t("connecting");
    clearInterval(gcallTimer);
    gcallTimer = setInterval(() => {
      if (!gcall?.startedAt) return;
      const s = Math.floor((Date.now() - gcall.startedAt) / 1000);
      $("call-status").textContent = Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
    }, 1000);
    for (const peer of peers) {
      try { await offerToPeer(peer); } catch (e) { console.error("gcall offer failed:", e); }
    }
  });

  // حالة الغرفة تغيّرت (انضمام/خروج/انتهاء) — لكل من في الغرفة وللرنين
  state.socket.on("groupcall:state", ({ conversationId, participants, startedBy, startedAt }) => {
    // 1) أنا في هذه المكالمة: حدّث القائمة، وانتهِ إن لم أعد موجوداً
    if (gcall && gcall.convId === conversationId) {
      gcall.participants = participants;
      renderParticipants(participants);
      if (!participants.some((p) => p.userId === state.user.id)) {
        teardownGroupCall(false);
        showToast(t("gcallEnded"), "info");
      }
      return;
    }
    // 2) أنا لست فيها: رنين إن كانت في المحادثة المفتوحة (ما لم أتجاهلها)
    const me = state.activeConv;
    if (me?.id === conversationId && !call && !gcall && gcallSupported() && participants.length > 0) {
      if (gcallIgnored && gcallIgnored.conversationId === conversationId && gcallIgnored.startedAt === startedAt) return;
      gcallIncoming = { conversationId, participants, startedBy, startedAt };
      gcallShowUI({ title: me.name || t("groupCall"), status: `${t("gcallIncoming")} (${participants.length})`, mode: "incoming" });
    } else if (gcallIncoming?.conversationId === conversationId && participants.length === 0) {
      // انتهت المكالمة التي كانت ترن — ارفع العرض
      gcallIncoming = null;
      if (!call && !gcall) $("call-overlay").classList.add("hidden");
    }
  });

  // عرض من مشارك قائم إليّ (المنضم الأحدث أنا؟ لا — عرض يعني أنّه منضم أحدث مني)
  state.socket.on("gcall:offer", async ({ from, conversationId, sdp }) => {
    if (!gcall || gcall.convId !== conversationId) return; // لا مكالمة — تجاهل
    try {
      const pc = getOrCreatePeerPC(from, { offerer: false });
      await pc.setRemoteDescription(JSON.parse(sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      state.socket.emit("gcall:answer", { conversationId, toUserId: from, sdp: JSON.stringify(pc.localDescription) });
    } catch (e) { console.error("gcall answer failed:", e); }
  });

  state.socket.on("gcall:answer", async ({ from, sdp }) => {
    const pc = gcall?.pcs.get(from);
    if (!pc) return;
    try {
      await pc.setRemoteDescription(JSON.parse(sdp));
      // فرّغ مرشحات ICE الواردة قبل جهوزية الوصف البعيد
      const pending = gcall.icePending?.get(from) || [];
      for (const c of pending) { try { await pc.addIceCandidate(JSON.parse(c)); } catch {} }
      if (gcall.icePending) gcall.icePending.delete(from);
    } catch (e) { console.error("gcall remote desc failed:", e); }
  });

  state.socket.on("gcall:ice", async ({ from, candidate }) => {
    if (!gcall || typeof candidate !== "string") return;
    const pc = gcall.pcs.get(from);
    if (!pc || !pc.remoteDescription) {
      if (!gcall.icePending) gcall.icePending = new Map();
      if (!gcall.icePending.has(from)) gcall.icePending.set(from, []);
      gcall.icePending.get(from).push(candidate);
      return;
    }
    try { await pc.addIceCandidate(JSON.parse(candidate)); } catch {}
  });

  state.socket.on("groupcall:full", () => {
    teardownGroupCall(false);
    showToast(t("gcallFull"), "error");
  });
  state.socket.on("groupcall:error", ({ reason }) => {
    teardownGroupCall(false);
    showToast(reason === "forbidden" ? t("callForbidden") : t("callFailed"), "error");
  });
}

$("group-call-btn").addEventListener("click", startGroupCall);

// ===== أدوات الإشراف (درس FireChat — بحث الميزات §6: قنوات بلا إشراف لا تدوم) =====
// دوري في المحادثة الحالية: owner/admin يحصلان على قائمة الأعضاء والحذف
// الإشرافي والتثبيت والحظر. الأدوار تُجلب عند فتح المحادثة (openConversation).
function canModerate() {
  const conv = state.activeConv;
  if (!conv || conv.type === "dm") return false;
  return ["owner", "admin"].includes(conv._myRole);
}

/** لاصقة الرسالة المثبّتة — تُظهر نصها إن كان مشفراً متاحاً (E2EE: الخادم لا يرى النص). */
function updatePinnedBanner() {
  const conv = state.activeConv;
  const pinnedId = conv?.pinned_message_id;
  if (!conv || conv.type === "dm" || !pinnedId) {
    $("pinned-banner").classList.add("hidden");
    return;
  }
  $("pinned-banner").classList.remove("hidden");
  $("pinned-unpin").classList.toggle("hidden", !canModerate());
  const el = document.querySelector(`[data-mid="${pinnedId}"] .text`);
  $("pinned-text").textContent = el ? el.textContent : t("pinnedMsg");
}

$("pinned-jump").addEventListener("click", () => {
  const id = state.activeConv?.pinned_message_id;
  if (!id) return;
  const el = document.querySelector(`[data-mid="${id}"]`);
  if (el) { el.scrollIntoView({ behavior: "smooth", block: "center" }); el.style.outline = "2px solid var(--accent)"; setTimeout(() => (el.style.outline = ""), 1500); }
});

$("pinned-unpin").addEventListener("click", async () => {
  if (!canModerate() || !state.activeConv) return;
  try { await api(`/api/conversations/${state.activeConv.id}/pin`, { method: "DELETE" }); }
  catch (e) { showToast(translateErr(e.message), "error"); }
});

// ===== نافذة إدارة الأعضاء =====
$("members-btn").addEventListener("click", async () => {
  if (!state.activeConv || state.activeConv.type === "dm") return;
  openModal("members-modal");
  try {
    const { members } = await api(`/api/conversations/${state.activeConv.id}/members`);
    state.activeConv._members = members;
    state.activeConv._myRole = members.find((m) => m.id === state.user.id)?.role || "member";
  } catch {}
  await renderMembersLists();
});
$("close-members").addEventListener("click", () => closeModal("members-modal"));

async function renderMembersLists() {
  const conv = state.activeConv;
  if (!conv) return;
  const list = $("members-list");
  const bansUl = $("bans-list");
  list.innerHTML = "";
  $("bans-title").classList.add("hidden");
  bansUl.innerHTML = "";
  const roleLabel = (r) => (r === "owner" ? t("roleOwner") : r === "admin" ? t("roleAdmin") : t("roleMember"));
  const admin = canModerate();
  const owner = conv._myRole === "owner";

  for (const m of conv._members || []) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.className = "m-name";
    name.textContent = m.username;
    const badge = document.createElement("span");
    badge.className = "m-role " + m.role;
    badge.textContent = roleLabel(m.role);
    li.append(name, badge);

    // حظر شخصي (P4): متاح لكل عضو على غير نفسه — يمنع DM جديدة وإضافته
    // للمجموعات من حسابي ويصمت DM القائمة (بوابات الخادم في interactions.js)
    {
      const blockBtn = document.createElement("button");
      blockBtn.type = "button";
      const blocked = state._blocked?.has(m.id);
      blockBtn.textContent = blocked ? "♻" : "🚫";
      blockBtn.title = blocked ? t("unblockUser") : t("blockUser");
      blockBtn.setAttribute("aria-label", blockBtn.title);
      blockBtn.onclick = async () => {
        try {
          if (blocked) await api(`/api/users/${m.id}/block`, { method: "DELETE" });
          else {
            if (!confirm(t("blockConfirm"))) return;
            await api(`/api/users/${m.id}/block`, { method: "POST" });
          }
          await loadBlocks();
          renderMembersLists();
        } catch (e) { $("members-err").textContent = translateErr(e.message); }
      };
      li.appendChild(blockBtn);
    }

    if (admin && m.id !== state.user.id && m.role !== "owner") {
      const actions = document.createElement("span");
      actions.className = "m-actions";
      // المالك وحده يغيّر الأدوار (server/moderation.js)
      if (owner) {
        const promote = document.createElement("button");
        promote.type = "button";
        promote.textContent = m.role === "admin" ? "⬇" : "⬆";
        promote.title = m.role === "admin" ? t("demote") : t("promote");
        promote.setAttribute("aria-label", promote.title);
        promote.onclick = async () => {
          try {
            await api(`/api/conversations/${conv.id}/members/${m.id}/role`, { method: "PUT", body: JSON.stringify({ role: m.role === "admin" ? "member" : "admin" }) });
          } catch (e) { $("members-err").textContent = translateErr(e.message); }
        };
        actions.appendChild(promote);
      }
      const kick = document.createElement("button");
      kick.type = "button";
      kick.textContent = "✖";
      kick.title = t("kickMember");
      kick.setAttribute("aria-label", t("kickMember"));
      kick.onclick = async () => {
        if (!confirm(t("kickConfirm"))) return;
        try { await api(`/api/conversations/${conv.id}/members/${m.id}`, { method: "DELETE" }); }
        catch (e) { $("members-err").textContent = translateErr(e.message); }
      };
      actions.appendChild(kick);
      const ban = document.createElement("button");
      ban.type = "button";
      ban.textContent = "⛔";
      ban.title = t("banMember");
      ban.setAttribute("aria-label", t("banMember"));
      ban.onclick = async () => {
        if (!confirm(t("banConfirm"))) return;
        try { await api(`/api/conversations/${conv.id}/bans`, { method: "POST", body: JSON.stringify({ username: m.username }) }); }
        catch (e) { $("members-err").textContent = translateErr(e.message); }
      };
      actions.appendChild(ban);
      li.appendChild(actions);
    }
    list.appendChild(li);
  }

  if (admin) {
    try {
      const { bans } = await api(`/api/conversations/${conv.id}/bans`);
      if (bans.length) {
        $("bans-title").classList.remove("hidden");
        for (const b of bans) {
          const li = document.createElement("li");
          const name = document.createElement("span");
          name.className = "m-name";
          name.textContent = b.username;
          const unban = document.createElement("button");
          unban.type = "button";
          unban.textContent = "♻";
          unban.title = t("unbanMember");
          unban.setAttribute("aria-label", t("unbanMember"));
          unban.onclick = async () => {
            try { await api(`/api/conversations/${conv.id}/bans/${b.userId}`, { method: "DELETE" }); }
            catch (e) { $("members-err").textContent = translateErr(e.message); }
          };
          li.append(name, unban);
          bansUl.appendChild(li);
        }
      }
    } catch {} // عضو عادي — بلا قائمة حظر
  }
}

// إضافة عضو من نافذة الإدارة (نفس نقطة POST members في server.js + فحص الحظر)
$("member-add-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!state.activeConv || !canModerate()) return;
  const username = $("member-add-input").value.trim();
  $("members-err").textContent = "";
  if (!username) return;
  try {
    await api(`/api/conversations/${state.activeConv.id}/members`, { method: "POST", body: JSON.stringify({ username }) });
    $("member-add-input").value = "";
    const { members } = await api(`/api/conversations/${state.activeConv.id}/members`);
    state.activeConv._members = members;
    renderMembersLists();
  } catch (err) {
    const msg = String(err.message);
    if (msg.includes("banned")) $("members-err").textContent = t("bannedErr");
    else if (msg.includes("blocked_by_user")) $("members-err").textContent = t("blockedByUser");
    else if (msg.includes("you_blocked_user")) $("members-err").textContent = t("youBlockedUser");
    else $("members-err").textContent = translateErr(msg);
  }
});

// ===== Boot =====
(async function boot() {
  if (!state.token) return;
  applyPttMode(); // استعادة وضع للّكة المحفوظ قبل أي فتح محادثة
  loadOutbox();
  try {
    const { user } = await api("/api/auth/me");
    state.user = user;
    state.myKeys = await idbGet("myKeypair");
    if (state.myKeys) return enterApp();
    // مفاتيح مفقودة والتوكن حي (P7): زائر التجربة يولّد مفاتيحاً جديدة ويرفع
    // مفتاحه العام تلقائياً — فالسندرة (محو IndexedDB) لا تُخرجه من التجربة.
    // الحساب الدائم بلا مفاتيح يحصل على مسار الاستعادة المعتاد (رمز الاستعادة)
    // أو بداية بلا ماضٍ — نفس عقد مسار الدخول القائم.
    if (user.is_demo) {
      state.myKeys = await RasanCrypto.genKeypair();
      await idbPut("myKeypair", state.myKeys);
      await api("/api/auth/update-public-key", { method: "POST", body: JSON.stringify({ publicKey: state.myKeys.publicKey }) }).catch(() => {});
      return enterApp();
    }
    await promptRestore();
    if (state.myKeys) await enterApp();
  } catch { localStorage.removeItem("rasan_token"); }
})();

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
