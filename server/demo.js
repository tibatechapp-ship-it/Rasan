// demo.js — P7: صفحة التجربة العامة (أسبوع 2 من خارطة المنتَجة)
//
// «افتح، جرّب، امسح» — نمط صفحات التجربة الفورية (Session/SimpleX على الويب،
// روابط WhatsApp التجريبية): زائر بلا تسجيل يدخل بحساب جاهز خلال نقرة،
// يجرب دردشة E2EE حقيقية، ثم تُمسح كل بيانات الزوار تلقائياً.
//
// العقد الأمني:
// 1. حسابات المسبح (demo1..demo3) كلمات مرورها عشوائية تولّد خادمياً ولا
//    يعرفها أحد — الدخول فقط عبر POST /api/demo/session (حدّ معدل خاص)،
//    والأسماء محجوزة عن التسجيل العام (RESERVED_USERNAMES في auth.js).
// 2. كل جلسة زائر تبدأ بمسح صحي: محادثات الزوار «النقية» (كل أعضائها زوار)
//    تُمحى كاملة (CASCADE: رسائل/مفاتيح/مرفقات/تفاعلات/استطلاعات/حظر)،
//    ورسائل الزوار في المحادثات «المختلطة» تُمحى مع بقاء بيانات المستخدمين
//    الحقيقيين سليمة، وتُرفع token_version فتموت كل توكنات الزوار السابقة.
// 3. المسح الدوري sweepDemo (عند الإقلاع قسراً + كل 60 ثانية مع بوابة زمنية
//    DEMO_WIPE_MS = 6 ساعات افتراضياً): نفس النمط الخادمي لمسح المتلاشية P6 —
//    المؤقت ملك الخادم لا ذاكرة عملاء، ويعيد زرع الحسابات إن حُذفت (panic).
// 4. لا محتوى E2EE يمر هنا إطلاقاً — المفتاح العام للزائر فقط (65 بايت،
//    نفس عقد validatePublicKey) يُخزن ليُغلف مفتاح المحادثة إليه.

const express = require("express");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const bcrypt = require("bcryptjs");
const { db, UPLOAD_DIR } = require("./db");

// تكوين قابل للضبط: DEMO_MODE=0 يعطل المسار كلياً (404)؛ DEMO_WIPE_MS يضبط
// دورية المسح (الحد الأدنى 60 ثانية — تحت ذلك لا معنى له ولا يحمي شيئاً)؛
// DEMO_RATE_MAX حدّ نداءات /session لكل IP كل 15 دقيقة (افتراضي 30 — أوسع من
// حدّ الدخول العادي لأن عناوين NAT/الجامعات تتشارك مصدراً واحداً).
const DEMO_USERNAMES = ["demo1", "demo2", "demo3"];
const DEMO_WIPE_MS = Math.max(60 * 1000, Number(process.env.DEMO_WIPE_MS) || 6 * 3600 * 1000);
const DEMO_RATE_MAX = Number(process.env.DEMO_RATE_MAX) > 0 ? Number(process.env.DEMO_RATE_MAX) : 30;

function demoEnabled() {
  return process.env.DEMO_MODE !== "0";
}

// حدّ المعدل الخاص (مستقل عن مصادِقات auth حتى لا يستنزف الزوار حصة الدخول)
const RATE = new Map();
function rateLimit(ip) {
  const now = Date.now();
  const r = RATE.get(ip) || { c: 0, reset: now + 15 * 60 * 1000 };
  if (now > r.reset) { r.c = 0; r.reset = now + 15 * 60 * 1000; }
  r.c++; RATE.set(ip, r);
  return r.c <= DEMO_RATE_MAX;
}

// نفس عقد المفتاح العام في auth.js: نقطة EC P-256 غير مضغوطة (65 بايت)
function validPublicKey(k) {
  if (typeof k !== "string" || k.length < 80 || k.length > 200) return false;
  try { return Buffer.from(k, "base64").length === 65; } catch { return false; }
}

// ===== زرع حسابات المسبح (idempotent — يُستدعى عند الإقلاع وبعد كل مسح) =====
// كلمة المرور عشوائية 24 بايت ولا تُعاد أبداً — الدخول لمسار /session فقط.
// اسم موجود مسبقاً بحساب حقيقي (is_demo=0) لا يُمس ولا يُستبدل — نتجاوزه
// بتحذير في السجل حمايةً لبيانات مستخدم حقيقي وقع له الاسم أولاً.
function ensureDemoAccounts() {
  const created = [];
  for (const username of DEMO_USERNAMES) {
    const exists = db.prepare("SELECT id, is_demo FROM users WHERE username = ?").get(username);
    if (exists) {
      if (!exists.is_demo) console.warn(`[demo] «${username}» مملوك لحساب حقيقي — تجاوز الزرع`);
      else db.prepare("UPDATE users SET is_demo = 1 WHERE id = ?").run(exists.id);
      continue;
    }
    const password = crypto.randomBytes(24).toString("hex");
    const hash = bcrypt.hashSync(password, 8);
    const info = db.prepare("INSERT INTO users (username, password_hash, is_demo, created_at) VALUES (?, ?, 1, ?)").run(username, hash, Date.now());
    created.push(Number(info.lastInsertRowid));
  }
  return created;
}

// ===== المسح الصحي لقائمة زوار (بداية الجلسة: زائر واحد — المسح الدوري: الكل) =====
// نطاقان منفصلان: «الأهداف» (من يُمسح أثره الآن — زائر واحد عند بدء جلسة، أو
// كل الزوار في المسح الدوري) و«كل الزوار» (يحدد النقاء فقط). إعادة تعيين زائر
// لا تمس أبداً بيانات زوار آخرين ولا المستخدمين الحقيقيين.
// - المحادثات «النقية» (الهدف عضو فيها وكل أعضائها زوار): تُمحى كاملة بـ
//   CASCADE وتبث conv:declined للغرفة (نفس حدث الرفض P6 — العميل يعالجه أصلاً).
// - المحادثات «المختلطة» (هدف + مستخدمون حقيقيون): تبقى للحقيقيين، وتُمحى
//   رسائل الأهداف فقط (الزناد ينظف التفاعلات/الاستطلاعات) وعضويتهم.
// - المرفقات: ملفات القرص تُمسح يدوياً بعد حذف الصفوف (نمط ephemeral.js —
//   لا ملفات يتيمة)، لأن CASCADE يمسح الصفوف لا الملفات.
// - ستوريات/توكنات دفع/نسخ مفاتيح/حظر شخصي للأهداف: تُمحى كلها.
// - token_version +1 للأهداف فقط: كل توكناتهم السابقة تموت فوراً.
function resetDemoUsers(userIds, { io } = {}) {
  const targets = [...new Set(userIds.map(Number))];
  if (!targets.length) return { pureConversations: 0, attachments: 0 };
  const demoAll = db.prepare("SELECT id FROM users WHERE is_demo = 1").all().map((r) => Number(r.id));
  if (!demoAll.length) demoAll.push(...targets);
  const inT = targets.map(() => "?").join(",");
  const inD = demoAll.map(() => "?").join(",");
  // المحادثات النقية: الهدف عضو فيها ولا يوجد فيها أي مستخدم حقيقي
  const pure = db.prepare(
    `SELECT DISTINCT m.conversation_id AS id FROM conversation_members m
      WHERE m.user_id IN (${inT})
        AND NOT EXISTS (SELECT 1 FROM conversation_members x
                        WHERE x.conversation_id = m.conversation_id AND x.user_id NOT IN (${inD}))`
  ).all(...targets, ...demoAll).map((r) => r.id);
  // مرفقات تُنظف: مرفقات المحادثات النقية + كل ما رفعه الأهداف (محادثات مختلطة)
  const attIds = [];
  if (pure.length) {
    const inPure = pure.map(() => "?").join(",");
    for (const row of db.prepare(`SELECT id FROM attachments WHERE conversation_id IN (${inPure})`).all(...pure)) attIds.push(row.id);
    for (const cid of pure) io?.to("conv:" + cid).emit?.("conv:declined", { conversationId: cid });
    db.prepare(`DELETE FROM conversations WHERE id IN (${inPure})`).run(...pure); // CASCADE: رسائل/أعضاء/مفاتيح/مرفقات/تفاعلات/حظر
  }
  for (const row of db.prepare(`SELECT id FROM attachments WHERE uploader_id IN (${inT})`).all(...targets)) attIds.push(row.id);
  // رسائل الأهداف في المحادثات المختلطة + عضويتهم (المحادثة تبقى للحقيقيين)
  db.prepare(`DELETE FROM messages WHERE sender_id IN (${inT})`).run(...targets); // الزناد ينظف التفاعلات/الاستطلاعات
  db.prepare(`DELETE FROM conversation_members WHERE user_id IN (${inT})`).run(...targets);
  // أثر الأهداف الجانبي: ستوريات (CASCADE مشاهداتها)، توكنات دفع، نسخ مفاتيح، حظر
  db.prepare(`DELETE FROM stories WHERE user_id IN (${inT})`).run(...targets);
  db.prepare(`DELETE FROM device_tokens WHERE user_id IN (${inT})`).run(...targets);
  db.prepare(`DELETE FROM key_backups WHERE user_id IN (${inT})`).run(...targets);
  db.prepare(`DELETE FROM blocked_users WHERE blocker_id IN (${inT}) OR blocked_id IN (${inT})`).run(...targets, ...targets);
  db.prepare(`UPDATE users SET token_version = token_version + 1 WHERE id IN (${inT})`).run(...targets);
  // ملفات القرص أخيراً — بعد نجاح عمليات القاعدة (فشل unlink لا يفشل المسار)
  for (const id of new Set(attIds)) {
    db.prepare("DELETE FROM attachments WHERE id = ?").run(id); // no-op للممسوحة CASCADE
    try { fs.unlinkSync(path.join(UPLOAD_DIR, id + ".bin")); } catch {}
  }
  return { pureConversations: pure.length, attachments: attIds.length };
}

// ===== المسح الدوري (بوابة زمنية — يُستدعى مع منظّف stories كل 60 ثانية) =====
let lastWipeAt = 0;
function sweepDemo({ io, force } = {}) {
  if (!demoEnabled()) return false;
  const now = Date.now();
  if (!force && now - lastWipeAt < DEMO_WIPE_MS) return false;
  const demoUsers = db.prepare("SELECT id FROM users WHERE is_demo = 1").all();
  resetDemoUsers(demoUsers.map((u) => u.id), { io });
  ensureDemoAccounts(); // إعادة زرع ما حُذف (مثلاً panic من زائر)
  lastWipeAt = now;
  return true;
}

// ===== الراوتر: جلسة الزائر + حالة الصفحة =====
function createRouter({ signToken, io } = {}) {
  const router = express.Router();

  router.get("/demo/status", (_req, res) => {
    res.json({ enabled: demoEnabled(), wipeAfterMs: DEMO_WIPE_MS, pool: DEMO_USERNAMES.length });
  });

  // جلسة زائر جديدة: مفتاح عام جديد من متصفح الزائر (الخاصة تولد محلياً ولا
  // يراها الخادم أبداً)، أقدم حساب المسبح استخداماً، مسح صحي، توكن حيّ.
  router.post("/demo/session", (req, res) => {
    if (!demoEnabled()) return res.status(404).json({ error: "not found" });
    if (!rateLimit(req.ip)) return res.status(429).json({ error: "too many attempts" });
    const { publicKey } = req.body || {};
    if (!validPublicKey(publicKey)) return res.status(400).json({ error: "invalid public key" });
    ensureDemoAccounts();
    const acct = db.prepare("SELECT id FROM users WHERE is_demo = 1 ORDER BY demo_last_used ASC, id ASC LIMIT 1").get();
    if (!acct) return res.status(503).json({ error: "demo unavailable" });
    resetDemoUsers([acct.id], { io });
    db.prepare("UPDATE users SET public_key = ?, demo_last_used = ? WHERE id = ?").run(publicKey, Date.now(), acct.id);
    const user = db.prepare("SELECT id, username, locale, public_key, created_at, token_version FROM users WHERE id = ?").get(acct.id);
    res.json({ token: signToken(user), user: { id: user.id, username: user.username, locale: user.locale, is_demo: true }, wipeAfterMs: DEMO_WIPE_MS });
  });

  return router;
}

module.exports = { createRouter, ensureDemoAccounts, resetDemoUsers, sweepDemo, demoEnabled, DEMO_USERNAMES, DEMO_WIPE_MS };
