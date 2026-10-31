// mls.js — أسبوع 3 من خارطة المنتَجة: بنية MLS (روح RFC 9420) على الخادم
//
// الخادم هنا Delivery Service غير موثوق كما في MLS: يخزّن أرقام إبوك وcommitment
// وأغلفة معتمة (wrapped_key/iv/eph_pub) فقط — لا يرى سرّ الإبوك إطلاقاً (E2EE).
//
// العقود:
// 1) PUT  /conversations/:id/mls/enabled  — تفعيل/إيقاف (مالك/مشرف، مجموعات وقنوات).
//    الإيقاف صمّام أمان: يعيد المحادثة لمسار توزيع المفاتيح القديم بلا فقدان بيانات.
// 2) GET  /conversations/:id/mls/state    — { enabled, epoch, commitment }.
// 3) POST /conversations/:id/mls/commit   — أي عضو يصدر إبوكاً جديداً (خاصية MLS):
//    تحقق صارم (إبوك = الأخير+1 حصراً — السباق يفصله 409 epoch conflict)، وأهداف
//    الأغلفة أعضاء فعليون، وسقوف أحجام، وكل ذلك ذرياً مع رفع conversations.
//    current_key_version = الإبوك — فيصار على عقد «الرسالة تحمل إصدار المفتاح
//    الحالي» القائم منذ البداية دون تعديل مسار الإرسال إطلاقاً.
// 4) GET  /conversations/:id/mls/wraps/:epoch — غلاف هذا العضو لإبوك معين (404
//    بلا غلاف: العضو الذي انضم بعد الإبوك يعيد التهيئة بإبوك جديد — شفاء ذاتي).
//
// الترحيلات في db.js: جدولا mls_epochs/mls_wraps + عمود conversations.mls_enabled.

const express = require("express");
const { db } = require("./db");

const EPOCH_MAX = 1000000;
const WRAPS_MAX = 200;
const hex64 = (s) => typeof s === "string" && /^[0-9a-f]{64}$/.test(s);

function createRouter({ authRequired, io }) {
  const router = express.Router();

  const memberOf = (convId, uid) =>
    db.prepare("SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?").get(convId, uid);
  const latestEpoch = (convId) =>
    db.prepare("SELECT epoch, commitment FROM mls_epochs WHERE conversation_id = ? ORDER BY epoch DESC LIMIT 1").get(convId);

  // ===== تفعيل/إيقاف MLS (مالك/مشرف — نفس سلّم أدوات الإشراف) =====
  router.put("/conversations/:id/mls/enabled", authRequired, (req, res) => {
    const convId = Number(req.params.id);
    if (!Number.isInteger(convId)) return res.status(400).json({ error: "bad conversation id" });
    const m = memberOf(convId, req.user.id);
    if (!m) return res.status(403).json({ error: "forbidden" });
    const conv = db.prepare("SELECT id, type FROM conversations WHERE id = ?").get(convId);
    if (!conv) return res.status(404).json({ error: "conversation not found" });
    if (conv.type === "dm") return res.status(400).json({ error: "dm has no group key" }); // للخاص مفتاحه المشتق أصلاً
    if (!["owner", "admin"].includes(m.role)) return res.status(403).json({ error: "not allowed" });
    const raw = (req.body || {}).enabled;
    if (raw !== true && raw !== false) return res.status(400).json({ error: "enabled must be boolean" });
    db.prepare("UPDATE conversations SET mls_enabled = ? WHERE id = ?").run(raw ? 1 : 0, convId);
    io.to("conv:" + convId).emit("mls:enabled", { conversationId: convId, enabled: raw, by: req.user.id });
    res.json({ ok: true, mls_enabled: raw });
  });

  // ===== حالة سلسلة MLS للعضو =====
  router.get("/conversations/:id/mls/state", authRequired, (req, res) => {
    const convId = Number(req.params.id);
    if (!Number.isInteger(convId)) return res.status(400).json({ error: "bad conversation id" });
    if (!memberOf(convId, req.user.id)) return res.status(403).json({ error: "forbidden" });
    const conv = db.prepare("SELECT mls_enabled FROM conversations WHERE id = ?").get(convId);
    if (!conv) return res.status(404).json({ error: "conversation not found" });
    const last = latestEpoch(convId);
    res.json({ enabled: !!conv.mls_enabled, epoch: last?.epoch || 0, commitment: last?.commitment || null });
  });

  // ===== commit إبوك جديد (أي عضو — خاصية MLS) =====
  router.post("/conversations/:id/mls/commit", authRequired, (req, res) => {
    const convId = Number(req.params.id);
    if (!Number.isInteger(convId)) return res.status(400).json({ error: "bad conversation id" });
    if (!memberOf(convId, req.user.id)) return res.status(403).json({ error: "forbidden" });
    const conv = db.prepare("SELECT id, mls_enabled FROM conversations WHERE id = ?").get(convId);
    if (!conv) return res.status(404).json({ error: "conversation not found" });
    if (!conv.mls_enabled) return res.status(400).json({ error: "mls not enabled" });

    const { epoch, commitment, wraps } = req.body || {};
    if (!Number.isInteger(epoch) || epoch < 1 || epoch > EPOCH_MAX) return res.status(400).json({ error: "bad epoch" });
    if (!hex64(commitment)) return res.status(400).json({ error: "bad commitment" });
    if (!Array.isArray(wraps) || wraps.length === 0 || wraps.length > WRAPS_MAX) return res.status(400).json({ error: "bad wraps" });

    // الأهداف أعضاء فعليون فقط (نمط group-key/bulk: غير العضو يُتخطى بصمت —
    // سباق الطرد أثناء commit لا يكسر السلسلة)، وسقوف أحجام صارمة لكل حقل
    const members = new Set(
      db.prepare("SELECT user_id FROM conversation_members WHERE conversation_id = ?").all(convId).map((r) => r.user_id)
    );
    const cleaned = [];
    for (const w of wraps) {
      if (!w || !Number.isInteger(w.userId) || !members.has(w.userId)) continue;
      if (typeof w.wrapped_key !== "string" || !w.wrapped_key || w.wrapped_key.length > 2000) continue;
      if (typeof w.iv !== "string" || !w.iv || w.iv.length > 64) continue;
      if (typeof w.eph_pub !== "string" || !w.eph_pub || w.eph_pub.length > 400) continue;
      cleaned.push(w);
    }
    if (!cleaned.length) return res.status(400).json({ error: "no valid wraps" });

    // الإبوك = الأخير + 1 حصراً — سباق عضوين يفصله الخادم ذرياً (409)
    const last = latestEpoch(convId);
    const expected = (last?.epoch || 0) + 1;
    if (epoch !== expected) return res.status(409).json({ error: "epoch conflict", expected });

    const now = Date.now();
    try {
      db.exec("BEGIN");
      db.prepare("INSERT INTO mls_epochs (conversation_id, epoch, commitment, created_by, created_at) VALUES (?, ?, ?, ?, ?)").run(convId, epoch, commitment, req.user.id, now);
      const ins = db.prepare("INSERT INTO mls_wraps (conversation_id, epoch, for_user, eph_pub, wrapped_key, iv) VALUES (?, ?, ?, ?, ?, ?)");
      for (const w of cleaned) ins.run(convId, epoch, w.userId, w.eph_pub, w.wrapped_key, w.iv);
      // current_key_version = الإبوك: عقد «الرسالة تحمل إصدار المفتاح الحالي»
      // القائم في مسار الإرسال يظل صحيحاً بلا أي تعديل فيه
      db.prepare("UPDATE conversations SET current_key_version = ? WHERE id = ?").run(epoch, convId);
      db.exec("COMMIT");
    } catch (err) {
      try { db.exec("ROLLBACK"); } catch {}
      throw err;
    }
    io.to("conv:" + convId).emit("mls:commit", { conversationId: convId, epoch, by: req.user.id, commitment });
    res.json({ ok: true, epoch });
  });

  // ===== غلاف هذا العضو لإبوك معين =====
  router.get("/conversations/:id/mls/wraps/:epoch", authRequired, (req, res) => {
    const convId = Number(req.params.id);
    const epoch = Number(req.params.epoch);
    if (!Number.isInteger(convId) || !Number.isInteger(epoch)) return res.status(400).json({ error: "bad id" });
    if (!memberOf(convId, req.user.id)) return res.status(403).json({ error: "forbidden" });
    const e = db.prepare("SELECT commitment FROM mls_epochs WHERE conversation_id = ? AND epoch = ?").get(convId, epoch);
    if (!e) return res.status(404).json({ error: "no such epoch" });
    const w = db.prepare("SELECT eph_pub, wrapped_key, iv FROM mls_wraps WHERE conversation_id = ? AND epoch = ? AND for_user = ?").get(convId, epoch, req.user.id);
    if (!w) return res.status(404).json({ error: "no wrap for user" }); // انضممت بعد هذا الإبوك — أعد التهيئة
    res.json({ epoch, commitment: e.commitment, wrap: w });
  });

  return router;
}

module.exports = { createRouter };
