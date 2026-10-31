const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { db } = require("./db");

const router = express.Router();
if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is required in production');
const JWT_SECRET = process.env.JWT_SECRET || "dev-only-change-me";
const JWT_EXPIRES = "30d";

const RATE = new Map();
function rateLimit(ip) {
  const now = Date.now();
  const r = RATE.get(ip) || { c: 0, reset: now + 15 * 60 * 1000 };
  if (now > r.reset) { r.c = 0; r.reset = now + 15 * 60 * 1000; }
  r.c++; RATE.set(ip, r);
  return r.c <= 20;
}

// قفل الحساب ضد التخمين (P6 — صلب أمان إضافي فوق حدّ الـ IP):
// 5 محاولات فاشلة متتالية على نفس اسم المستخدم تقفله 15 دقيقة حتى لو صحّت
// كلمة المرور — يحمي من هجوم موزّع عديد المصادر على حساب واحد (محدّد الـ IP
// وحده لا يمنع بوتات متعددة). القفل في الذاكرة ويموت بإعادة التشغيل — بلا
// تخزين دائم، والنافذة قابلة للضبط للبيئات الاختبارية عبر LOGIN_LOCKOUT_MS.
const LOGIN_MAX_FAILS = 5;
const LOGIN_LOCKOUT_MS = Number(process.env.LOGIN_LOCKOUT_MS) > 0 ? Number(process.env.LOGIN_LOCKOUT_MS) : 15 * 60 * 1000;
const LOGIN_LOCKS = new Map(); // username(lower) -> { fails, lockedUntil }

function loginLocked(username) {
  const k = String(username || "").toLowerCase();
  const rec = LOGIN_LOCKS.get(k);
  if (!rec) return { locked: false, retry_after_ms: 0 };
  const now = Date.now();
  if (rec.lockedUntil > now) return { locked: true, retry_after_ms: rec.lockedUntil - now };
  if (rec.lockedUntil > 0) LOGIN_LOCKS.delete(k); // انتهى القفل — بداية نظيفة
  return { locked: false, retry_after_ms: 0 };
}

function recordLoginFail(username) {
  const k = String(username || "").toLowerCase();
  const now = Date.now();
  const rec = LOGIN_LOCKS.get(k) || { fails: 0, lockedUntil: 0 };
  rec.fails++;
  if (rec.fails >= LOGIN_MAX_FAILS) { rec.lockedUntil = now + LOGIN_LOCKOUT_MS; rec.fails = 0; }
  LOGIN_LOCKS.set(k, rec);
}

function recordLoginSuccess(username) {
  LOGIN_LOCKS.delete(String(username || "").toLowerCase());
}

function validateUsername(u) {
  return typeof u === "string" && /^[a-zA-Z0-9_]{3,24}$/.test(u.trim());
}
// أسماء محجوزة (P7 — أسبوع 2): حسابات الزوار التجريبية تُدار خادمياً فقط —
// لا يجوز لأحد تسجيلها يدوياً فيتظلل مسار التناوب والمسح (الرد 409 نفسه
// كـ«username taken» بلا كشف سبب خاص).
const RESERVED_USERNAMES = new Set(["demo", "demo1", "demo2", "demo3"]);
function validatePassword(p) {
  return typeof p === "string" && p.length >= 6 && p.length <= 72;
}
function validatePublicKey(k) {
  if (typeof k !== "string" || k.length < 80 || k.length > 200) return false;
  try { return atob(k).length === 65; } catch { return false; }
}

function signToken(user) {
  // ver = token_version: يُرفع عند تغيير كلمة المرور أو «خروج من كل الأجهزة»
  // فيموت كل توكن صدر قبل ذلك (authRequired يرفض أي ver قديم) — إبطال جلسات
  // فوري بلا قائمة revocation (نمط إدارة الجلسات في Signal/WhatsApp، P6).
  const ver = user.token_version ?? 0;
  return jwt.sign({ sub: user.id, username: user.username, ver }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}
function verifyToken(token) {
  try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
}
function authRequired(req, res, next) {
  const h = req.headers.authorization || "";
  const t = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!t) return res.status(401).json({ error: "unauthorized" });
  const p = verifyToken(t);
  if (!p) return res.status(401).json({ error: "unauthorized" });
  const user = db.prepare("SELECT id, username, email, locale, public_key, created_at, token_version, is_demo FROM users WHERE id = ?").get(p.sub);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  // توكن صادر قبل رفع token_version (تغيير مرور/خروج شامل) = ميت — حتى لو
  // توقيعه صحيح، ليعمل تغيير كلمة المرور كإبطال فوري لكل الجلسات الأخرى.
  if ((p.ver ?? 0) !== (user.token_version ?? 0)) return res.status(401).json({ error: "unauthorized" });
  req.user = user;
  next();
}

router.post("/register", async (req, res) => {
  if (!rateLimit(req.ip)) return res.status(429).json({ error: "too many attempts" });
  const { username, password, publicKey, locale } = req.body || {};
  if (!validateUsername(username)) return res.status(400).json({ error: "bad username" });
  if (!validatePassword(password)) return res.status(400).json({ error: "bad password" });
  if (!validatePublicKey(publicKey)) return res.status(400).json({ error: "public key required" });
  const u = username.trim();
  const exists = db.prepare("SELECT id FROM users WHERE username = ?").get(u);
  if (exists || RESERVED_USERNAMES.has(u.toLowerCase())) return res.status(409).json({ error: "username taken" });
  const hash = await bcrypt.hash(password, 10);
  const info = db.prepare("INSERT INTO users (username, password_hash, public_key, locale, created_at) VALUES (?, ?, ?, ?, ?)").run(u, hash, publicKey, locale || "ar", Date.now());
  const user = db.prepare("SELECT id, username, locale, public_key, created_at, token_version FROM users WHERE id = ?").get(info.lastInsertRowid);
  res.json({ token: signToken(user), user });
});

router.post("/login", async (req, res) => {
  if (!rateLimit(req.ip)) return res.status(429).json({ error: "too many attempts" });
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "invalid payload" });
  // قفل الحساب (P6): يُفحص قبل أي استعلام — والمؤقت يُعاد للـ 429 حتى لا يساعد
  // المهاجم على تقدير متى ينتهي القفل بدقة.
  const lock = loginLocked(username);
  if (lock.locked) return res.status(429).json({ error: "account locked", retry_after_ms: lock.retry_after_ms });
  const row = db.prepare("SELECT * FROM users WHERE username = ?").get(username.trim());
  if (!row) return res.status(401).json({ error: "wrong credentials" });
  const ok = await bcrypt.compare(password, row.password_hash);
  if (!ok) { recordLoginFail(username); return res.status(401).json({ error: "wrong credentials" }); }
  recordLoginSuccess(username);
  const user = { id: row.id, username: row.username, locale: row.locale, public_key: row.public_key, created_at: row.created_at, token_version: row.token_version ?? 0, is_demo: !!row.is_demo };
  res.json({ token: signToken(user), user });
});

// خروج من كل الأجهزة (P6 — نمط Signal/WhatsApp): رفع token_version يموت به
// كل توكن قائم فوراً؛ الجلسة الحالية تحتاج توكناً جديداً بعد النداء فتعيد
// الدخول. عمداً بلا حذف أجهزة/بيانات — إبطال توكنات فقط.
router.post("/logout-all", authRequired, (req, res) => {
  db.prepare("UPDATE users SET token_version = token_version + 1 WHERE id = ?").run(req.user.id);
  res.json({ ok: true });
});

router.get("/me", authRequired, (req, res) => res.json({ user: req.user }));

router.get("/users/:username", authRequired, (req, res) => {
  const u = db.prepare("SELECT id, username, public_key FROM users WHERE username = ?").get(req.params.username);
  if (!u) return res.status(404).json({ error: "not found" });
  res.json({ user: u });
});

router.post("/update-public-key", authRequired, (req, res) => {
  const { publicKey } = req.body || {};
  if (!validatePublicKey(publicKey)) return res.status(400).json({ error: "invalid public key" });
  db.prepare("UPDATE users SET public_key = ? WHERE id = ?").run(publicKey, req.user.id);
  res.json({ ok: true });
});

router.post("/change-password", authRequired, async (req, res) => {
  // حسابات الزوار التجريبية (P7) بلا كلمات مرور يملكها أحد — كلمتها العشوائية
  // خادمية فقط، وتغييرها يكسر تجديد المسبح — فالحرس قبل أي تحقق آخر.
  if (req.user.is_demo) return res.status(403).json({ error: "demo account" });
  const { oldPassword, newPassword } = req.body || {};
  if (typeof oldPassword !== "string" || typeof newPassword !== "string") return res.status(400).json({ error: "invalid payload" });
  if (newPassword.length < 6 || newPassword.length > 72) return res.status(400).json({ error: "password must be 6-72 chars" });
  const row = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(req.user.id);
  const ok = await bcrypt.compare(oldPassword, row.password_hash);
  if (!ok) return res.status(401).json({ error: "wrong password" });
  const hash = await bcrypt.hash(newPassword, 10);
  // تغيير كلمة المرور = إبطال فوري لكل الجلسات الأخرى (P6): رفع token_version
  // يجعل كل توكن سابق ميتاً — إن غيّر المستخدم مروره بعد اختراق مشتبه فلا
  // تبقى جلسة المهاجم حية. الجلسة الحالية تعمل حتى نهاية هذا الطلب فقط؛
  // العميل يعيد الدخول بالكلمة الجديدة.
  db.prepare("UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?").run(hash, req.user.id);
  res.json({ ok: true });
});

// Key Backup
router.post("/key-backup", authRequired, (req, res) => {
  const { ciphertext, iv, salt, iterations } = req.body || {};
  if (typeof ciphertext !== "string" || typeof iv !== "string" || typeof salt !== "string") return res.status(400).json({ error: "invalid payload" });
  if (!Number.isInteger(iterations) || iterations < 100000) return res.status(400).json({ error: "iterations too low" });
  db.prepare(`INSERT INTO key_backups (user_id, ciphertext, iv, salt, iterations, created_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET ciphertext=excluded.ciphertext, iv=excluded.iv, salt=excluded.salt, iterations=excluded.iterations, created_at=excluded.created_at`)
    .run(req.user.id, ciphertext, iv, salt, iterations, Date.now());
  res.json({ ok: true });
});

router.get("/key-backup", authRequired, (req, res) => {
  const row = db.prepare("SELECT ciphertext, iv, salt, iterations, created_at FROM key_backups WHERE user_id = ?").get(req.user.id);
  if (!row) return res.status(404).json({ error: "no backup" });
  res.json(row);
});

router.delete("/key-backup", authRequired, (req, res) => {
  db.prepare("DELETE FROM key_backups WHERE user_id = ?").run(req.user.id);
  res.json({ ok: true });
});

module.exports = { router, verifyToken, JWT_SECRET, authRequired, loginLocked, recordLoginFail, recordLoginSuccess, LOGIN_LOCKOUT_MS, LOGIN_MAX_FAILS, signToken, RESERVED_USERNAMES };
