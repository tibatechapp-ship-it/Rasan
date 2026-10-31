const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { Server } = require("socket.io");
const { db, DATA_DIR, UPLOAD_DIR } = require("./db");
const { router: authRouter, verifyToken, authRequired, signToken } = require("./auth");
const security = require("./security");
const push = require("./push");
const notifications = require("./notifications");
// مسح الذعر + وضع الإضطرار (P2 #11 — نمط Briar): حذف الحساب وكل أثره عن بُعد
const panic = require("./panic");
// أدوات الإشراف (درس FireChat في بحث الميزات §6): حظر/ترقية/تثبيت/حذف رسائل
const moderation = require("./moderation");
// المكالمات الجماعية (WebRTC mesh — يكمل P1: مكالمات المجموعات متعددة الأطراف)
const groupcalls = require("./groupcalls");
// بوابة LoRa الاختيارية (P2 #10 — نمط Meshtastic): معطلة بلا LORA_MQTT_URL
const loraGateway = require("./lora-gateway");
// صلة (sila) — مساحة الـ Mesh المحلية المنفصلة (بلا DB ولا مصادقة؛ راجع server/sila-mesh.js)
const silaMesh = require("./sila-mesh");
// التفاعلات والحظر والردود (P4 — بحث الميزات): إيموجي/حظر/ردود
const interactions = require("./interactions");
// خصوصية المحادثة (P6 — مراجعة المنافسين): مؤقت متلاشية للمحادثة + طلبات الرسائل
const privacy = require("./privacy");
// المسح الدوري للرسائل المتلاشية (P6 — إصلاح: المؤقتات تموت بإعادة التشغيل)
const ephemeral = require("./ephemeral");
// صفحة التجربة العامة (P7 — أسبوع 2 من خارطة المنتَجة): حسابات زوار + مسح دوري
const demo = require("./demo");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" }, maxHttpBufferSize: 1e6, pingTimeout: 30000 });

app.set("trust proxy", 1);
app.use(security.securityHeaders);
app.use(security.requireJson);
app.use(express.json({ limit: "64kb" }));
app.use(express.static(path.join(__dirname, "..", "web"), { maxAge: "1h" }));
// عميل صلة الثابت على /sila — نموذج أولي مستقل بلا بناء (Vite غير مطلوب هنا)
app.use("/sila", express.static(path.join(__dirname, "..", "sila"), { maxAge: "1h", dotfiles: "ignore" }));

app.use("/api/auth/login", security.authLimiter);
app.use("/api/auth/register", security.authLimiter);
app.use("/api/", security.apiLimiter);
app.use("/api/attachments", security.uploadLimiter);
app.use("/api/auth", authRouter);
app.use("/api", notifications.createRouter({ authRequired }));
app.use("/api", panic.createRouter({ authRequired, io }));
app.use("/api", moderation.createRouter({ authRequired, io }));
app.use("/api", interactions.createRouter({ authRequired, io }));
app.use("/api", privacy.createRouter({ authRequired, io })); // P6: ttl + accept/decline
app.use("/api", demo.createRouter({ signToken, io })); // P7: جلسة الزائر + حالة الصفحة

const upload = multer({ dest: UPLOAD_DIR, limits: { fileSize: 30 * 1024 * 1024 } });

push.init();
silaMesh.init(io); // مساحة /sila على Socket.IO — نقل حقيقي بين الأجهزة لصلة
// بوابة LoRa (Meshtastic MQTT) — معطلة ما لم تُضبط LORA_MQTT_URL؛ انقطاعها
// لا يؤثر إطلاقاً على صلة أو رسن (فشل هادئ بطبيعته).
loraGateway.init(io, silaMesh);

// P6 — مسح المتلاشية عند الإقلاع: أي رسالة تجاوزت مؤقتها أثناء التوقف تُمحى
// فوراً قبل استقبال أي اتصال (الوعد يعود ساريًا حتى بعد انقطاع طويل).
ephemeral.sweepEphemeral({ io });
// P7 — التجربة العامة عند الإقلاع: زرع حسابات الزوار + مسح قسري (بيانات
// الزوار لا تعبر حداً لإقلاع الخادم — «امسح» وعد بلا استثناء، والسحابة
// المؤقتة على Render تعيد التشغيل كثيراً فتخرج نظيفة دائماً).
if (demo.demoEnabled()) {
  demo.ensureDemoAccounts();
  demo.sweepDemo({ io, force: true });
}

// Deployment identity. Render exports the commit it is serving, so a post-deploy
// check can prove that the LIVE process runs the code which just landed — a 200
// from a stale container proves nothing about the deploy.
const COMMIT = (process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || "").slice(0, 7);
const VERSION = require("./package.json").version;

app.get("/health", (_q, res) =>
  res.json({ ok: true, uptime: process.uptime(), version: VERSION, commit: COMMIT })
);
// صفحة التجربة العامة (P7 — أسبوع 2): /demo صريح لأن express.static لا يقدّم
// demo.html للـURL بلا امتداد — والرابط القصير جزء من الوعد («افتح» بنقرة).
app.get("/demo", (_req, res) =>
  res.sendFile(path.join(__dirname, "..", "web", "demo.html"))
);
app.get("/api/stats", (req, res) => {
  const key = req.query.key;
  if (key !== process.env.STATS_KEY) return res.status(403).json({ error: "forbidden" });
  const users = db.prepare("SELECT COUNT(*) c FROM users").get().c;
  const convs = db.prepare("SELECT COUNT(*) c FROM conversations").get().c;
  const msgs = db.prepare("SELECT COUNT(*) c FROM messages").get().c;
  const last24h = db.prepare("SELECT COUNT(*) c FROM messages WHERE time > ?").get(Date.now() - 86400000).c;
  res.json({ users, convs, msgs, last24h });
});

// ===== Socket.IO auth =====
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error("unauthorized"));
  const p = verifyToken(token);
  if (!p) return next(new Error("unauthorized"));
  const user = db.prepare("SELECT id, username, public_key FROM users WHERE id = ?").get(p.sub);
  if (!user) return next(new Error("unauthorized"));
  socket.user = user;
  socket._msgCount = 0;
  socket._msgWindow = Date.now();
  next();
});

const presence = new Map();
function broadcastPresence(userId, online) {
  const convs = db.prepare("SELECT conversation_id FROM conversation_members WHERE user_id = ?").all(userId);
  for (const c of convs) io.to("conv:" + c.conversation_id).emit("presence", { userId, online });
}

function checkSocketRate(socket) {
  const now = Date.now();
  if (now - socket._msgWindow > 10000) { socket._msgWindow = now; socket._msgCount = 0; }
  socket._msgCount++;
  if (socket._msgCount > 20) { socket.emit("message:rejected", { reason: "rate_limit" }); return false; }
  return true;
}

io.on("connection", (socket) => {
  const uid = socket.user.id;
  if (!presence.has(uid)) presence.set(uid, new Set());
  presence.get(uid).add(socket.id);
  broadcastPresence(uid, true);

  const convs = db.prepare("SELECT conversation_id FROM conversation_members WHERE user_id = ?").all(uid);
  for (const c of convs) socket.join("conv:" + c.conversation_id);

  socket.on("join", ({ conversationId }) => {
    const m = db.prepare("SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?").get(conversationId, uid);
    if (m) socket.join("conv:" + conversationId);
  });

  socket.on("message", (payload) => {
    if (!checkSocketRate(socket)) return;
    const { conversationId, ciphertext, iv, type, ephemeral_ttl, key_version, attachmentId, clientId } = payload || {};
    if (!conversationId || !ciphertext || !iv) return;

    const m = db.prepare("SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?").get(conversationId, uid);
    if (!m) return;

    const conv = db.prepare("SELECT type, current_key_version, ttl_seconds, dm_accepted, owner_id FROM conversations WHERE id = ?").get(conversationId);
    if (!conv) return;

    // طلبات الرسائل (P6 — نمط WhatsApp): الردّ على طلبٍ يقبله تلقائياً — صاحب
    // الطلب (المدعو) يرسل فيصير البدء مقبولاً ويُبث conv:accepted للغرفة.
    // قيمة wasPending تُسجل قبل التحديث لقمع الدفع لاحقاً (بلا إشعارات مزعجة
    // في الطلبات غير المقبولة — عقد الأمان الأساسي لهذه الميزة).
    const wasPending = conv.type === "dm" && !conv.dm_accepted;
    if (wasPending) {
      db.prepare("UPDATE conversations SET dm_accepted = 1 WHERE id = ?").run(conversationId);
      io.to("conv:" + conversationId).emit("conv:accepted", { conversationId, by: uid });
    }

    // بوابة الحظر في رسائل DM القائمة (P4): حجب ثنائي الاتجاه يصمت المحادثة
    // القائمة كذلك — الرفض بعقد صريح يعرضه العميل (نمط WhatsApp/Telegram).
    if (conv.type === "dm") {
      const other = db.prepare("SELECT user_id FROM conversation_members WHERE conversation_id = ? AND user_id != ?").get(conversationId, uid);
      if (other && interactions.isBlockedBetween(uid, other.user_id)) {
        socket.emit("message:rejected", { conversationId, reason: "blocked" });
        return;
      }
    }

    // الردود (P4): مرجع معرّف فقط — النص المقتبس داخل ciphertext العميل (E2EE).
    // التحقق: الهدف موجود في نفس المحادثة وغير محذوف — وإلا رفض صريح.
    let replyTo = null;
    if (payload && payload.replyTo != null) {
      replyTo = Number(payload.replyTo);
      if (!Number.isInteger(replyTo)) return;
      const target = db.prepare("SELECT id, conversation_id, deleted FROM messages WHERE id = ?").get(replyTo);
      if (!target || target.conversation_id !== conversationId || target.deleted) {
        socket.emit("message:rejected", { conversationId, reason: "reply_invalid" });
        return;
      }
    }

    // القنوات للقراءة فقط (أدوات الإشراف — درس FireChat): النشر للمشرفين
    // والمالك حصرًا؛ الأعضاء يستقبلون ويقرأون. الرفض بعقد صريح يعرفه العميل.
    if (conv.type === "channel") {
      const role = db.prepare("SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?").get(conversationId, uid)?.role;
      if (!role || !["owner", "admin"].includes(role)) {
        socket.emit("message:rejected", { conversationId, reason: "channel_readonly" });
        return;
      }
    }

    if (conv.type !== "dm") {
      const kv = Number.isInteger(key_version) ? key_version : 1;
      if (kv !== conv.current_key_version) {
        socket.emit("message:rejected", { conversationId, reason: "key_version_mismatch", expected: conv.current_key_version, got: kv });
        return;
      }
    }

    if (attachmentId) {
      const att = db.prepare("SELECT conversation_id, uploader_id FROM attachments WHERE id = ?").get(attachmentId);
      if (!att || att.conversation_id !== conversationId || att.uploader_id !== uid) {
        socket.emit("message:rejected", { conversationId, reason: "bad_attachment" });
        return;
      }
    }

    const time = Date.now();
    // المؤقت الفعّال (P6 — نمط Signal): مدة المرسل الصريحة (>0) تتفوق، وإلا
    // ترث الرسالة مؤقت المحادثة الافتراضي (conv.ttl_seconds) — فمثلاً محادثة
    // ضبطت على «يوم» تجعل كل رسالة جديدة تختفي بعد يوم دون فعل من المرسل.
    const senderTtl = Number.isInteger(ephemeral_ttl) && ephemeral_ttl > 0 ? ephemeral_ttl : 0;
    const effTtl = senderTtl || (Number.isInteger(conv.ttl_seconds) && conv.ttl_seconds > 0 ? conv.ttl_seconds : 0);
    const info = db.prepare("INSERT INTO messages (conversation_id, sender_id, type, ciphertext, iv, ephemeral_ttl, time, key_version, attachment_id, reply_to_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(conversationId, uid, type || "text", ciphertext, iv, effTtl, time, key_version || 1, attachmentId || null, replyTo);
    const msg = { id: info.lastInsertRowid, conversationId, senderId: uid, senderName: socket.user.username, type: type || "text", ciphertext, iv, time, ephemeral_ttl: effTtl, key_version: key_version || 1, attachmentId: attachmentId || null, replyTo };
    // clientId: معرّف يوضعه العميل لرسائل طابور الأوفلاين (≤ 64 حرفاً) — يمرّ
    // مع البث كي يستبدل العميل نسخته المتفائلة بالنسخة الرسمية دون تكرار.
    if (typeof clientId === "string" && clientId.length > 0 && clientId.length <= 64) {
      msg.clientId = clientId;
    }
    io.to("conv:" + conversationId).emit("message", msg);
    // إقرار للمرسل: الرسالة حُفظت على الخادم وأُرسلت للغرفة (مؤشر ✓ في الواجهة).
    if (msg.clientId) socket.emit("message:ack", { clientId: msg.clientId, id: msg.id, time });

    // Push for offline members
    const members = db.prepare("SELECT user_id FROM conversation_members WHERE conversation_id = ? AND user_id != ?").all(conversationId, uid);
    const onlineIds = new Set();
    for (const [sid, sock] of io.sockets.sockets) {
      if (sock.user && members.some((m) => m.user_id === sock.user.id)) onlineIds.add(sock.user.id);
    }
    for (const mm of members) {
      if (onlineIds.has(mm.user_id)) continue;
      // طلبات الرسائل (P6): بلا إشعارات دفع للطلب غير المقبول — يصله لما
      // يفتح التطبيق ويجده في قسم الطلبات (نفس عقد WhatsApp/Signal: طلبات
      // لا إشعارات، لئلا يصير بدء محادثات من غرباء قناة إزعاج).
      if (wasPending) continue;
      if (!notifications.canPush(mm.user_id, "new_message")) continue; // تفضيلات المستخدم (تشغيل/إيقاف)
      push.sendToUser(mm.user_id, notifications.buildNotificationPayload("new_message", { conversationId, messageId: msg.id }));
    }

    if (effTtl > 0) {
      setTimeout(() => {
        db.prepare("DELETE FROM messages WHERE id = ?").run(msg.id);
        io.to("conv:" + conversationId).emit("message:deleted", { id: msg.id });
        if (msg.attachmentId) {
          const p = path.join(UPLOAD_DIR, msg.attachmentId + ".bin");
          if (fs.existsSync(p)) fs.unlinkSync(p);
          db.prepare("DELETE FROM attachments WHERE id = ?").run(msg.attachmentId);
        }
      }, ephemeral_ttl * 1000);
    }
  });

  socket.on("typing", ({ conversationId, isTyping }) => {
    socket.to("conv:" + conversationId).emit("typing", { conversationId, userId: uid, name: socket.user.username, isTyping: !!isTyping });
  });

  socket.on("read", ({ conversationId, messageId }) => {
    db.prepare("UPDATE conversation_members SET last_read_id = ? WHERE conversation_id = ? AND user_id = ?").run(messageId, conversationId, uid);
    socket.to("conv:" + conversationId).emit("read", { conversationId, userId: uid, messageId });
  });

  socket.on("message:delete", ({ messageId }) => {
    if (!Number.isInteger(messageId)) return;
    const row = db.prepare("SELECT conversation_id, sender_id FROM messages WHERE id = ?").get(messageId);
    if (!row || row.sender_id !== uid) { socket.emit("message:rejected", { reason: "not_owner" }); return; }
    const m = db.prepare("SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?").get(row.conversation_id, uid);
    if (!m) return;
    db.prepare("DELETE FROM messages WHERE id = ?").run(messageId);
    io.to("conv:" + row.conversation_id).emit("message:deleted", { id: messageId });
  });

  socket.on("message:edit", ({ messageId, ciphertext, iv }) => {
    if (!Number.isInteger(messageId) || !ciphertext || !iv) return;
    const row = db.prepare("SELECT conversation_id, sender_id, type FROM messages WHERE id = ?").get(messageId);
    if (!row || row.sender_id !== uid) { socket.emit("message:rejected", { reason: "not_owner" }); return; }
    if (row.type === "file") { socket.emit("message:rejected", { reason: "cannot_edit_file" }); return; }
    const m = db.prepare("SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?").get(row.conversation_id, uid);
    if (!m) return;
    const now = Date.now();
    db.prepare("UPDATE messages SET ciphertext = ?, iv = ?, edited_at = ? WHERE id = ?").run(ciphertext, iv, now, messageId);
    io.to("conv:" + row.conversation_id).emit("message:edited", { id: messageId, ciphertext, iv, edited_at: now });
  });

  // --- Call signaling (relays only — validation + busy tracking, no storage) ---
  socket._callWindow = Date.now();
  socket._callCount = 0;
  const checkCallRate = () => {
    const now = Date.now();
    if (now - socket._callWindow > CALL_RATE_WINDOW_MS) { socket._callWindow = now; socket._callCount = 0; }
    socket._callCount++;
    return socket._callCount <= CALL_RATE_MAX;
  };

  // عرض مكالمة: كلا الطرفين عضوان في نفس المحادثة، ولا أحد منهما في مكالمة
  socket.on("call:offer", ({ conversationId, toUserId, sdp, video } = {}) => {
    if (!checkCallRate()) return;
    const convId = Number(conversationId);
    if (!Number.isInteger(convId) || !Number.isInteger(toUserId)) return;
    if (typeof sdp !== "string" || !sdp.length || Buffer.byteLength(sdp, "utf8") > MAX_SDP_BYTES) return;
    if (!isMemberOf(convId, uid) || !isMemberOf(convId, toUserId)) {
      socket.emit("call:error", { reason: "forbidden" });
      return;
    }
    if (callBusy.has(uid)) return; // المتصل نفسه في مكالمة
    if (callBusy.has(toUserId)) { socket.emit("call:busy", {}); return; }
    const targets = userSockets(toUserId);
    if (!targets.length) { socket.emit("call:unavailable", {}); return; }
    callBusy.set(uid, { peer: toUserId, conversationId: convId });
    callBusy.set(toUserId, { peer: uid, conversationId: convId });
    for (const target of targets) {
      target.emit("call:offer", { from: uid, fromName: socket.user.username, conversationId: convId, sdp, video: !!video });
    }
  });

  // قبول: مسموح فقط لمن لديه اقتران مكالمة فعلي مع الطرف
  socket.on("call:answer", ({ toUserId, sdp } = {}) => {
    if (!checkCallRate()) return;
    if (typeof sdp !== "string" || !sdp.length || Buffer.byteLength(sdp, "utf8") > MAX_SDP_BYTES) return;
    const busy = callBusy.get(uid);
    if (!busy || busy.peer !== toUserId) return;
    for (const target of userSockets(toUserId)) target.emit("call:answer", { from: uid, sdp });
  });

  // مرشحات ICE — صغيرة ومتدفقة؛ تتطلب اقتراناً قائماً كذلك
  socket.on("call:ice", ({ toUserId, candidate } = {}) => {
    if (!checkCallRate()) return;
    if (typeof candidate !== "string" || !candidate.length || Buffer.byteLength(candidate, "utf8") > MAX_ICE_BYTES) return;
    const busy = callBusy.get(uid);
    if (!busy || busy.peer !== toUserId) return;
    for (const target of userSockets(toUserId)) target.emit("call:ice", { from: uid, candidate });
  });

  // إنهاء/رفض — يزيل اقتران الطرفين دائماً (لا حالة يتيمة)
  socket.on("call:end", ({ toUserId } = {}) => {
    const busy = callBusy.get(uid);
    if (!busy || busy.peer !== toUserId) return;
    clearCallPair(uid, toUserId);
    for (const target of userSockets(toUserId)) target.emit("call:end", { from: uid, reason: "hangup" });
  });

  socket.on("call:reject", ({ toUserId } = {}) => {
    const busy = callBusy.get(uid);
    if (!busy || busy.peer !== toUserId) return;
    clearCallPair(uid, toUserId);
    for (const target of userSockets(toUserId)) target.emit("call:reject", { from: uid });
  });

  socket.on("disconnect", () => {
    // إن كان المستخدم في مكالمة ولم يبق له أجهزة متصلة — أبلغ الطرف الآخر
    const busy = callBusy.get(uid);
    if (busy && userSockets(uid).length === 0) {
      clearCallPair(uid, busy.peer);
      for (const target of userSockets(busy.peer)) target.emit("call:end", { from: uid, reason: "disconnect" });
    }
    presence.get(uid)?.delete(socket.id);
    if (presence.get(uid)?.size === 0) { presence.delete(uid); broadcastPresence(uid, false); }
  });
});

// ===== REST: conversations =====
app.get("/api/conversations", authRequired, (req, res) => {
  // pinned_message_id مرفق للأدوات الإشرافية — اللاصقة تعرضها فور فتح المحادثة
  // ttl_seconds وdm_accepted (P6): مؤقت المتلاشية + طلبات الرسائل — يعرف
  // العميل منهما ما يحتاج دون نداء إضافي.
  const rows = db.prepare(`SELECT c.id, c.type, c.name, c.description, c.owner_id, c.created_at, c.current_key_version, c.pinned_message_id, c.ttl_seconds, c.dm_accepted,
    (SELECT COUNT(*) FROM conversation_members WHERE conversation_id = c.id) AS members
    FROM conversations c JOIN conversation_members m ON m.conversation_id = c.id
    WHERE m.user_id = ? ORDER BY c.created_at DESC`).all(req.user.id);
  res.json({ conversations: rows });
});

app.post("/api/conversations", authRequired, (req, res) => {
  const { type, name, description, members } = req.body || {};
  if (!["dm", "group", "channel"].includes(type)) return res.status(400).json({ error: "bad type" });
  // بوابة الحظر (P4): DM جديدة بين طرفين بينهما حجب بأي اتجاه تُرفض 403
  if (type === "dm") {
    for (const uname of (members || [])) {
      const u = db.prepare("SELECT id FROM users WHERE username = ?").get(uname);
      if (u && interactions.isBlockedBetween(req.user.id, u.id)) return res.status(403).json({ error: "blocked" });
    }
  }
  const info = db.prepare("INSERT INTO conversations (type, name, description, owner_id, created_at, dm_accepted) VALUES (?, ?, ?, ?, ?, ?)").run(
    type, name || null, description || null, req.user.id, Date.now(),
    // طلبات الرسائل (P6 — نمط WhatsApp/Signal): DM يبدؤها شخص لشخص آخر تصل
    // صاحبها الثانية «طلبًا» غير مقبول (dm_accepted=0) يقبله صراحة أو يرد
    // فيُقبل تلقائياً؛ المجموعات والقنوات تبقى مقبولة دائماً (1).
    type === "dm" && (members || []).length > 0 ? 0 : 1
  );
  const cid = info.lastInsertRowid;
  const addMember = db.prepare("INSERT INTO conversation_members (conversation_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)");
  addMember.run(cid, req.user.id, "owner", Date.now());
  for (const uname of (members || [])) {
    const u = db.prepare("SELECT id FROM users WHERE username = ?").get(uname);
    if (u) addMember.run(cid, u.id, "member", Date.now());
  }
  io.to("conv:" + cid).emit("conversation:created", { id: cid });
  res.json({ id: cid });
});

// رسائل محفوظة (نمط Telegram «Saved Messages» — P5): مساحة شخصية لنفسي —
// DM بعضو واحد (أنا) اسمها «رسائل محفوظة». مُكرِرة (idempotent): الاستدعاء
// المتكرر يعيد نفس المحادثة. كل شيء آخر يعمل تلقائياً: التشفير، التعديل،
// المتلاشية، المرفقات — والحظر/الدفع غير مفعّلين بلا طرف ثانٍ.
app.post("/api/conversations/self", authRequired, (req, res) => {
  const existing = db
    .prepare(`SELECT c.id FROM conversations c
      WHERE c.type = 'dm' AND c.owner_id = ?
        AND (SELECT COUNT(*) FROM conversation_members WHERE conversation_id = c.id) = 1
        AND EXISTS (SELECT 1 FROM conversation_members WHERE conversation_id = c.id AND user_id = ?)`)
    .get(req.user.id, req.user.id);
  if (existing) return res.json({ id: existing.id, created: false });
  const info = db.prepare("INSERT INTO conversations (type, name, description, owner_id, created_at) VALUES ('dm', 'رسائل محفوظة', ?, ?, ?)")
    .run("مساحة شخصية — مرئية لك وحدها", req.user.id, Date.now());
  const cid = info.lastInsertRowid;
  db.prepare("INSERT INTO conversation_members (conversation_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)").run(cid, req.user.id, Date.now());
  io.to("conv:" + cid).emit("conversation:created", { id: cid });
  res.json({ id: cid, created: true });
});

app.get("/api/conversations/:id", authRequired, (req, res) => {
  const m = db.prepare("SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?").get(req.params.id, req.user.id);
  if (!m) return res.status(403).json({ error: "forbidden" });
  const c = db.prepare("SELECT * FROM conversations WHERE id = ?").get(req.params.id);
  res.json({ conversation: c });
});

app.get("/api/conversations/:id/members", authRequired, (req, res) => {
  const m = db.prepare("SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?").get(req.params.id, req.user.id);
  if (!m) return res.status(403).json({ error: "forbidden" });
  const rows = db.prepare("SELECT u.id, u.username, u.public_key, cm.role, cm.joined_at FROM conversation_members cm JOIN users u ON u.id = cm.user_id WHERE cm.conversation_id = ? ORDER BY cm.joined_at ASC").all(req.params.id);
  res.json({ members: rows });
});

app.post("/api/conversations/:id/members", authRequired, (req, res) => {
  const { username } = req.body || {};
  if (!username) return res.status(400).json({ error: "username required" });
  const owner = db.prepare("SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?").get(req.params.id, req.user.id);
  if (!owner || !["owner", "admin"].includes(owner.role)) return res.status(403).json({ error: "not allowed" });
  const target = db.prepare("SELECT id, username, public_key FROM users WHERE username = ?").get(username);
  if (!target) return res.status(404).json({ error: "user not found" });
  if (!target.public_key) return res.status(400).json({ error: "target has no public key" });
  // أدوات الإشراف: المحظور لا يُعاد إضافته — 403 صريح يعرضه العميل كحظر
  if (moderation.isBanned(Number(req.params.id), target.id)) return res.status(403).json({ error: "banned" });
  // بوابة الحظر الشخصي (P4 — نمط Telegram): من حظرني لا أضيفه للمجموعات،
  // ومن حظرته أنا لا يُضاف من حسابي — رسالتان منفصلتان لأداء واضح.
  if (interactions.hasBlocked(target.id, req.user.id)) return res.status(403).json({ error: "blocked_by_user" });
  if (interactions.hasBlocked(req.user.id, target.id)) return res.status(403).json({ error: "you_blocked_user" });
  const exists = db.prepare("SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?").get(req.params.id, target.id);
  if (exists) return res.status(409).json({ error: "already a member" });
  db.prepare("INSERT INTO conversation_members (conversation_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)").run(req.params.id, target.id, Date.now());
  io.to("conv:" + req.params.id).emit("member:added", { userId: target.id, username: target.username });
  // إشعار الدعوة للمجموعة — قالب ثابت بلا أي محتوى (E2EE)
  notifications.notifyUser(target.id, "group_invite", { conversationId: Number(req.params.id) });
  res.json({ ok: true, member: { id: target.id, username: target.username, public_key: target.public_key } });
});

app.delete("/api/conversations/:id/members/:userId", authRequired, (req, res) => {
  const owner = db.prepare("SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?").get(req.params.id, req.user.id);
  if (!owner || !["owner", "admin"].includes(owner.role)) return res.status(403).json({ error: "not allowed" });
  if (Number(req.params.userId) === req.user.id) return res.status(400).json({ error: "cannot remove self" });
  db.prepare("DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?").run(req.params.id, req.params.userId);
  db.prepare("DELETE FROM group_keys WHERE conversation_id = ? AND user_id = ?").run(req.params.id, req.params.userId);
  io.to("conv:" + req.params.id).emit("member:removed", { userId: Number(req.params.userId) });
  res.json({ ok: true });
});

app.get("/api/conversations/:id/messages", authRequired, (req, res) => {
  const m = db.prepare("SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?").get(req.params.id, req.user.id);
  if (!m) return res.status(403).json({ error: "forbidden" });
  // ترقيم صفحات التاريخ (P6 — نمط Telegram/WhatsApp «تحميل الأقدم»):
  // افتراضياً آخر 100 رسالة صاعدة؛ ?before=<id> يعيد ما قبله أقدم، ?limit
  // يسقف حتى 100 (خارج النطاق = افتراضي) — لا تعطيل ولا استعلام غير مقيد.
  let limit = Number(req.query.limit);
  if (!Number.isInteger(limit) || limit < 1) limit = 100;
  if (limit > 100) limit = 100;
  const before = Number(req.query.before);
  const whereBefore = Number.isInteger(before) && before > 0 ? "AND m.id < ?" : "";
  const params = Number.isInteger(before) && before > 0 ? [req.params.id, before] : [req.params.id];
  const rows = db.prepare(`SELECT m.id, m.conversation_id AS conversationId, m.sender_id AS senderId, u.username AS senderName, m.type, m.ciphertext, m.iv, m.ephemeral_ttl, m.time, m.key_version, m.attachment_id AS attachmentId, m.deleted, m.edited_at, m.reply_to_id AS replyTo FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.conversation_id = ? AND m.deleted = 0 ${whereBefore} ORDER BY m.time DESC, m.id DESC LIMIT ?`).all(...params, limit).reverse();
  // has_more + oldestId: يعرف العميل هل يعرض زر «الأقدم» ومؤشر النداء التالي —
  // بدون عدّ إضافي: امتلاء الصفحة = غالباً المزيد (تقريب مقبول لأرشيف المحادثات)
  // وأدق من ذلك: قبلتّ إذا كانت أعلى الصفحة ليست أقدم رسالة في المحادثة.
  const oldest = rows.length ? rows[0].id : null;
  const hasMore = rows.length > 0 && !!db.prepare(`SELECT 1 FROM messages WHERE conversation_id = ? AND deleted = 0 AND id < ? LIMIT 1`).get(req.params.id, oldest);
  // تفاعلات الرسائل (P4) وأصوات الاستطلاعات (P5) مجمّعة لصفحة الرسائل الحالية —
  // ميتاداتا فقط بلا محتوى
  res.json({ messages: interactions.attachPollVotes(interactions.attachReactions(rows)), hasMore, oldestId: oldest });
});

// ===== Group key =====
app.post("/api/conversations/:id/group-key/bulk", authRequired, (req, res) => {
  const { entries, key_version } = req.body || {};
  if (!Array.isArray(entries) || !entries.length) return res.status(400).json({ error: "entries required" });
  const version = Number.isInteger(key_version) && key_version > 0 ? key_version : 1;
  const owner = db.prepare("SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?").get(req.params.id, req.user.id);
  if (!owner || !["owner", "admin"].includes(owner.role)) return res.status(403).json({ error: "not allowed" });
  const conv = db.prepare("SELECT current_key_version FROM conversations WHERE id = ?").get(req.params.id);
  if (!conv) return res.status(404).json({ error: "conversation not found" });
  if (version <= conv.current_key_version) return res.status(409).json({ error: "key_version too old", current: conv.current_key_version });

  const members = new Set(db.prepare("SELECT user_id FROM conversation_members WHERE conversation_id = ?").all(req.params.id).map((r) => r.user_id));
  const upsert = db.prepare(`INSERT INTO group_keys (conversation_id, user_id, wrapped_by, wrapped_key, iv, key_version, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(conversation_id, user_id) DO UPDATE SET wrapped_by=excluded.wrapped_by, wrapped_key=excluded.wrapped_key, iv=excluded.iv, key_version=excluded.key_version, updated_at=excluded.updated_at`);
  const now = Date.now();
  try {
    db.exec("BEGIN");
    for (const e of entries) {
      if (!members.has(e.userId)) continue;
      if (typeof e.wrapped_key !== "string" || typeof e.iv !== "string") continue;
      upsert.run(req.params.id, e.userId, req.user.id, e.wrapped_key, e.iv, version, now);
    }
    db.prepare("UPDATE conversations SET current_key_version = ? WHERE id = ?").run(version, req.params.id);
    db.exec("COMMIT");
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch {}
    throw err;
  }
  io.to("conv:" + req.params.id).emit("group-key:updated", { by: req.user.id, key_version: version });
  res.json({ ok: true, updated: entries.length, key_version: version });
});

app.get("/api/conversations/:id/group-key", authRequired, (req, res) => {
  const m = db.prepare("SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?").get(req.params.id, req.user.id);
  if (!m) return res.status(403).json({ error: "forbidden" });
  const row = db.prepare(`SELECT gk.wrapped_key, gk.iv, gk.wrapped_by, gk.key_version, u.public_key AS owner_public_key FROM group_keys gk JOIN users u ON u.id = gk.wrapped_by WHERE gk.conversation_id = ? AND gk.user_id = ?`).get(req.params.id, req.user.id);
  const conv = db.prepare("SELECT current_key_version FROM conversations WHERE id = ?").get(req.params.id);
  res.json({ ...(row || { wrapped_key: null }), current_key_version: conv?.current_key_version || 1 });
});

app.get("/api/conversations/:id/key-state", authRequired, (req, res) => {
  const m = db.prepare("SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?").get(req.params.id, req.user.id);
  if (!m) return res.status(403).json({ error: "forbidden" });
  const conv = db.prepare("SELECT current_key_version FROM conversations WHERE id = ?").get(req.params.id);
  const mine = db.prepare("SELECT key_version FROM group_keys WHERE conversation_id = ? AND user_id = ?").get(req.params.id, req.user.id);
  res.json({ current: conv?.current_key_version || 1, mine: mine?.key_version || 0, up_to_date: (mine?.key_version || 0) === (conv?.current_key_version || 1) });
});

// ===== Emergency alert (إنذار الطوارئ) =====
// زر بث جماعي على غرار Zello: عضو يطلق إنذاراً في محادثة → حدث Socket فوري
// لكل من في الغرفة + إشعار FCM بالقالب الثابت لكل عضو غير متصل.
// الإساءة مقهومة: إنذار واحد لكل مستخدم لكل محادثة كل 60 ثانية.
// نص الإشعار من القالب فقط (notifications.TEMPLATES.emergency) — بلا أي محتوى.
const EMERGENCY_COOLDOWN_MS = 60 * 1000;
const lastEmergency = new Map(); // key: `${userId}:${conversationId}` -> timestamp

function emergencyKey(userId, conversationId) { return `${userId}:${conversationId}`; }

app.post("/api/conversations/:id/emergency", authRequired, (req, res) => {
  const convId = Number(req.params.id);
  if (!Number.isInteger(convId)) return res.status(400).json({ error: "bad conversation id" });
  const m = db.prepare("SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?").get(convId, req.user.id);
  if (!m) return res.status(403).json({ error: "not a member" });
  const conv = db.prepare("SELECT id, type FROM conversations WHERE id = ?").get(convId);
  if (!conv) return res.status(404).json({ error: "conversation not found" });

  const key = emergencyKey(req.user.id, convId);
  const now = Date.now();
  const last = lastEmergency.get(key) || 0;
  if (now - last < EMERGENCY_COOLDOWN_MS) {
    return res.status(429).json({ error: "cooldown", retry_after_ms: EMERGENCY_COOLDOWN_MS - (now - last) });
  }
  lastEmergency.set(key, now);

  const at = now;
  io.to("conv:" + convId).emit("emergency", { conversationId: convId, by: req.user.id, byName: req.user.username, at });

  // إشعار FCM لكل عضو غير متصل — يحترم تفضيلات الطوارئ لكل مستخدم
  const members = db.prepare("SELECT user_id FROM conversation_members WHERE conversation_id = ? AND user_id != ?").all(convId, req.user.id);
  const onlineIds = new Set();
  for (const [sid, sock] of io.sockets.sockets) {
    if (sock.user && members.some((mm) => mm.user_id === sock.user.id)) onlineIds.add(sock.user.id);
  }
  let notified = 0;
  for (const mm of members) {
    if (onlineIds.has(mm.user_id)) continue; // المتصلون بالغرفة استلموا حدث Socket
    if (!notifications.canPush(mm.user_id, "emergency")) continue;
    notifications.notifyUser(mm.user_id, "emergency", { conversationId: convId });
    notified++;
  }
  res.json({ ok: true, at, notified });
});

// ===== Calls — مكالمات صوت/مرئي (WebRTC — من بحث الميزات P1: نمط Meshenger/Zello) =====
// الإشارة فقط تمر عبر الخادم (SDP/ICE) — الوسائط نفسها تسير طرف-لطرف مباشرة
// مشفّرة DTLS-SRTP ولا يرى الخادم صوتاً أو صورة إطلاقاً. بلا تخزين ولا DB:
// كل حالة اتصال في الذاكرة وتموت بانتهائها.
// الخطابة بالـ userId (لا socket id) لتدعم تعدد الأجهزة: العرض يصل كل أجهزة
// الطرف الآخر وأول "قبول" يفوز. الإساءة مقهومة بمحدّد معدل مستقل.
const MAX_SDP_BYTES = 32768;
const MAX_ICE_BYTES = 2048;
const CALL_RATE_WINDOW_MS = 10000;
const CALL_RATE_MAX = 120;
const callBusy = new Map(); // userId -> { peer, conversationId } — حالة الخطابة/المكالمة

function isMemberOf(conversationId, userId) {
  return !!db.prepare("SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?").get(conversationId, userId);
}

function userSockets(userId) {
  const out = [];
  for (const sock of io.sockets.sockets.values()) {
    if (sock.user && sock.user.id === userId) out.push(sock);
  }
  return out;
}

function clearCallPair(aId, bId) { callBusy.delete(aId); callBusy.delete(bId); }

// المكالمات الجماعية (WebRTC mesh حتى 8 مشاركين — وسائط P2P مشفّرة
// DTLS-SRTP كالبنائية؛ الخادم موجّه إشارات فقط). callBusy يُمرَّر بالمرجع
// ليصبح المستخدم مشغولاً أمام المكالمات الثنائية أثناء الجماعية بلا تعديل
// في فحوصها القائمة (راجع server/groupcalls.js).
groupcalls.init(io, { callBusy });

// ===== Stories =====
app.post("/api/stories", authRequired, (req, res) => {
  const { ciphertext, iv, type } = req.body || {};
  if (!ciphertext || !iv) return res.status(400).json({ error: "missing" });
  const now = Date.now();
  const info = db.prepare("INSERT INTO stories (user_id, ciphertext, iv, type, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)").run(req.user.id, ciphertext, iv, type || "text", now, now + 24 * 3600 * 1000);
  res.json({ id: info.lastInsertRowid });
});

app.get("/api/stories", authRequired, (req, res) => {
  const rows = db.prepare(`SELECT s.id, s.user_id AS userId, u.username AS username, s.ciphertext, s.iv, s.type, s.created_at AS createdAt, s.expires_at AS expiresAt FROM stories s JOIN users u ON u.id = s.user_id WHERE s.expires_at > ? ORDER BY s.created_at DESC`).all(Date.now());
  res.json({ stories: rows });
});

app.post("/api/stories/:id/view", authRequired, (req, res) => {
  try { db.prepare("INSERT INTO story_views (story_id, viewer_id, viewed_at) VALUES (?, ?, ?)").run(req.params.id, req.user.id, Date.now()); } catch {}
  res.json({ ok: true });
});

// ===== Media upload =====
// Raw octet-stream upload (preferred for E2EE)
app.post("/api/attachments", authRequired, express.raw({ type: "application/octet-stream", limit: 30 * 1024 * 1024 }), (req, res) => {
  const convId = Number(req.query.conversationId);
  if (!Number.isInteger(convId)) return res.status(400).json({ error: "bad convId" });
  const member = db.prepare("SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?").get(convId, req.user.id);
  if (!member) return res.status(403).json({ error: "forbidden" });
  if (!req.body || !Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: "empty body" });

  const crypto = require("crypto");
  const id = crypto.randomBytes(16).toString("hex");
  const filePath = path.join(UPLOAD_DIR, id + ".bin");
  fs.writeFileSync(filePath, req.body);
  db.prepare("INSERT INTO attachments (id, conversation_id, uploader_id, size_bytes, created_at) VALUES (?, ?, ?, ?, ?)").run(id, convId, req.user.id, req.body.length, Date.now());
  res.json({ id, size: req.body.length });
});

app.get("/api/attachments/:id", authRequired, (req, res) => {
  const row = db.prepare("SELECT conversation_id, size_bytes FROM attachments WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "not found" });
  const member = db.prepare("SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?").get(row.conversation_id, req.user.id);
  if (!member) return res.status(403).json({ error: "forbidden" });
  const filePath = path.join(UPLOAD_DIR, req.params.id + ".bin");
  if (!fs.existsSync(filePath)) return res.status(410).json({ error: "gone" });
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Length", row.size_bytes);
  res.setHeader("Cache-Control", "private, max-age=86400");
  fs.createReadStream(filePath).pipe(res);
});

// ===== Push tokens =====
app.post("/api/push/register", authRequired, (req, res) => {
  const { token, platform } = req.body || {};
  if (typeof token !== "string" || token.length < 20) return res.status(400).json({ error: "invalid token" });
  if (!["android", "ios", "web"].includes(platform)) return res.status(400).json({ error: "invalid platform" });
  push.registerToken(req.user.id, token, platform);
  res.json({ ok: true });
});

app.post("/api/push/unregister", authRequired, (req, res) => {
  const { token } = req.body || {};
  if (typeof token === "string") push.unregisterToken(token);
  res.json({ ok: true });
});

// ===== Cleanup =====
setInterval(() => {
  db.prepare("DELETE FROM stories WHERE expires_at < ?").run(Date.now());
  // P6 — مسح المتلاشية كل 60 ثانية: يلتقط كل ما تجاوز مؤقته حتى لو سقط
  // setTimeout الخاص به بإعادة تشغيل — الوعد بلا استثناء لا بمؤقتات هشة.
  ephemeral.sweepEphemeral({ io });
  // P7 — مسح بيانات الزوار التجريبية (بوابة زمنية داخلية 6 ساعات افتراضياً)
  demo.sweepDemo({ io });
}, 60 * 1000);

app.use(security.errorHandler);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Rasan on http://localhost:${PORT}`));
