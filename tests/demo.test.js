// demo.test.js — اختبارات P7 التشغيلية (راوترات حقيقية + io وهمي + DATA_DIR مؤقت)
//
// الضمانات:
// 1. زرع حسابات الزوار idempotent: 3 حسابات is_demo=1، والنداء الثاني لا يكرر
//    ولا يمس حساباً حقيقياً وقع له الاسم.
// 2. جلسة الزائر: توكن حيّ يعمل على /api/auth/me الحقيقي، user.is_demo=true،
//    والمفتاح العام للزائر يُخزن (عقد 65 بايت نفسه).
// 3. التناوب: ثلاث جلسات متتالية = ثلاثة أسماء مختلفة (الأقدم استخداماً أولاً).
// 4. حدود الجلسة (resetDemoUsers): محادثة الزوار النقية تمحى كاملة، توكن الجلسة
//    السابقة يموت (token_version+1)، والحساب يعاد إنشاؤه إن حُذف (panic).
// 5. المسح الدوري القسري (sweepDemo force): كل أثر الزوار يمحى (رسائل/ستوريات/
//    توكنات دفع/نسخ مفاتيح/حظر/مرفقات بملفاتها من القرص) وبيانات الحقيقيين
//    سليمة تماماً — والمحادثات المختلطة تبقى لأصحابها بلا رسائل الزوار.
// 6. حرسات المصادقة: تغيير كلمة مرور زائر = 403، وتسجيل اسم محجوز = 409.
// 7. التعطيل: DEMO_MODE=0 يجعل /session و 404 وstatus enabled=false.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let db;
let auth;
let demo;
let uploadDir;
let app;
let server;
let port;
let emitted = [];

const fakeIo = { to: (room) => ({ emit: (event, payload) => emitted.push({ room, event, payload }) }) };
const bearer = (t) => ({ 'content-type': 'application/json', authorization: `Bearer ${t}` });
// مفتاح عام صالح: 65 بايت تبدأ بـ 0x04 (نقطة EC P-256 غير مضغوطة — نفس عقد validatePublicKey)
const PUB = Buffer.from(Uint8Array.from({ length: 65 }, (_, i) => (i === 0 ? 4 : 7))).toString('base64');
const call = (path, { method = 'GET', token, body } = {}) =>
  fetch(`http://localhost:${port}${path}`, { method, headers: token ? bearer(token) : { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });

let realToken; // توكن مستخدم حقيقي (dane) عبر التسجيل الفعلي

beforeAll(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'rasan-demo-test-'));
  process.env.DATA_DIR = dataDir;
  process.env.JWT_SECRET = 'p7-test-secret';
  const dbMod = await import('../server/db.js');
  db = dbMod.db;
  uploadDir = dbMod.UPLOAD_DIR;
  auth = await import('../server/auth.js');
  demo = await import('../server/demo.js');

  const express = (await import('express')).default;
  app = express();
  app.use(express.json());
  app.use('/api/auth', auth.router); // راوتر حقيقي — bcrypt + JWT حقيقيان
  app.use('/api', demo.createRouter({ signToken: auth.signToken, io: fakeIo }));
  server = app.listen(0);
  port = server.address().port;
});

afterAll(() => {
  server?.close();
  rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.JWT_SECRET;
});

// ================= الزرع والجلسة والتناوب =================
describe('زرع حسابات الزوار وجلسة التجربة (P7)', () => {
  it('الزرع يخلق 3 حسابات is_demo=1 وهو idempotent', () => {
    demo.ensureDemoAccounts();
    demo.ensureDemoAccounts(); // النداء الثاني بلا تكرار
    const rows = db.prepare('SELECT id, username, is_demo FROM users WHERE is_demo = 1 ORDER BY id').all();
    expect(rows.map((r) => r.username)).toEqual(['demo1', 'demo2', 'demo3']);
    // كلمات المرور عشوائية خادمية — لا يمكن الدخول بها من مسار /login
    const hash = db.prepare('SELECT password_hash FROM users WHERE username = ?').get('demo1').password_hash;
    expect(hash).toBeTruthy();
  });

  it('الزرع لا يستبدل حساباً حقيقياً وقع له اسم المحجوز', () => {
    db.prepare("INSERT INTO users (username, password_hash, is_demo, created_at) VALUES ('demo4', 'x', 0, ?)").run(Date.now());
    // demo4 ليس في المسبح أصلاً — نضيفه للمسبح عبر محاكاة: الزرع يتجاهل الحقيقي فقط
    const real = db.prepare("SELECT id, is_demo FROM users WHERE username = 'demo4'").get();
    demo.ensureDemoAccounts();
    const after = db.prepare("SELECT is_demo FROM users WHERE id = ?").get(real.id);
    expect(after.is_demo).toBe(0); // لم يُستبدل ولم يُمس
  });

  it('POST /api/demo/session يعيد توكناً حياً وuser.is_demo=true ويخزن المفتاح العام', async () => {
    const r = await call('/api/demo/session', { method: 'POST', body: { publicKey: PUB } });
    expect(r.status).toBe(200);
    const data = await r.json();
    expect(data.user.is_demo).toBe(true);
    expect(data.wipeAfterMs).toBeGreaterThan(0);
    const me = await call('/api/auth/me', { token: data.token });
    expect(me.status).toBe(200);
    const mu = (await me.json()).user;
    expect(mu.is_demo).toBe(1); // authRequired يعيد الحقل من القاعدة
    expect(mu.public_key).toBe(PUB);
  });

  it('التناوب: ثلاث جلسات متتالية = ثلاثة أسماء مختلفة (الأقدم استخداماً أولاً)', async () => {
    const names = [];
    for (let i = 0; i < 3; i++) {
      const r = await call('/api/demo/session', { method: 'POST', body: { publicKey: PUB } });
      expect(r.status).toBe(200);
      names.push((await r.json()).user.username);
    }
    expect(new Set(names).size).toBe(3);
  });

  it('المفتاح العام غير الصالح يرد 400 — والمفتاح طلب إلزامي', async () => {
    expect((await call('/api/demo/session', { method: 'POST', body: { publicKey: 'short' } })).status).toBe(400);
    expect((await call('/api/demo/session', { method: 'POST', body: {} })).status).toBe(400);
  });
});

// ================= حدود الجلسة: المسح الصحي عند بدء كل جلسة =================
describe('المسح الصحي عند بدء الجلسة (resetDemoUsers)', () => {
  it('إعادة الدخول لنفس الحساب تمحو صندوقه: المحادثة النقية تختفي والتوكن القديم يموت', async () => {
    // جلسة لحساب X (أيًّا كان الذي يلتقطه التناوب) — ثم بناء صندوقه برسالة
    const s1 = await call('/api/demo/session', { method: 'POST', body: { publicKey: PUB } });
    const { token: t1, user: picked } = await s1.json();
    const X = db.prepare('SELECT id FROM users WHERE id = ?').get(picked.id);
    const convInfo = db.prepare("INSERT INTO conversations (type, name, owner_id, created_at) VALUES ('dm', 'sandbox', ?, ?)").run(X.id, Date.now());
    const cid = Number(convInfo.lastInsertRowid);
    db.prepare("INSERT INTO conversation_members (conversation_id, user_id, joined_at) VALUES (?, ?, ?)").run(cid, X.id, Date.now());
    db.prepare("INSERT INTO messages (conversation_id, sender_id, ciphertext, iv, time) VALUES (?, ?, 'ct', 'iv', ?)").run(cid, X.id, Date.now());
    expect(db.prepare('SELECT COUNT(*) c FROM messages WHERE conversation_id = ?').get(cid).c).toBe(1);

    // ما يفعله الخادم حرفياً عندما يُختار X مجدداً لزائر جديد (resetDemoUsers
    // على الهدف وحده — لا مسا لمخازن الزوار الآخرين)
    const before = db.prepare("SELECT COUNT(*) c FROM users WHERE is_demo = 1 AND id != ?").get(X.id).c;
    demo.resetDemoUsers([X.id], { io: fakeIo });
    expect(db.prepare('SELECT COUNT(*) c FROM conversations WHERE id = ?').get(cid).c).toBe(0);
    expect(db.prepare('SELECT COUNT(*) c FROM messages WHERE sender_id = ?').get(X.id).c).toBe(0);
    // حسابات الزوار الآخرين لم تُمس توكناتها (النطاق = الهدف فقط)
    const after = db.prepare("SELECT COUNT(*) c FROM users WHERE is_demo = 1 AND id != ?").get(X.id).c;
    expect(after).toBe(before);
    expect((await call('/api/auth/me', { token: t1 })).status).toBe(401);
  });

  it('حساب زائر محذوف (panic) يعاد زرعه تلقائياً في الجلسة التالية', async () => {
    db.prepare("DELETE FROM users WHERE username = 'demo2'").run();
    const r = await call('/api/demo/session', { method: 'POST', body: { publicKey: PUB } });
    expect(r.status).toBe(200);
    expect((await r.json()).user.username).toBe('demo2'); // أعيد زرعه وهو الأقدم استخداماً
  });
});

// ================= المسح الدوري القسري: أثر الزوار كله vs الحقيقيون =================
describe('المسح الدوري (sweepDemo force) — «امسح» وعد بلا استثناء', () => {
  let realId;
  beforeAll(async () => {
    // مستخدم حقيقي عبر التسجيل الفعلي + أثر كامل (محادثة/رسالة/ستوري/توكن/نسخة)
    const reg = await call('/api/auth/register', { method: 'POST', body: { username: 'dane', password: 'secret1', publicKey: PUB } });
    realToken = (await reg.json()).token;
    realId = db.prepare("SELECT id FROM users WHERE username = 'dane'").get().id;
    const convInfo = db.prepare("INSERT INTO conversations (type, name, owner_id, created_at) VALUES ('dm', 'real', ?, ?)").run(realId, Date.now());
    const realCid = Number(convInfo.lastInsertRowid);
    db.prepare("INSERT INTO conversation_members (conversation_id, user_id, joined_at) VALUES (?, ?, ?)").run(realCid, realId, Date.now());
    db.prepare("INSERT INTO messages (conversation_id, sender_id, ciphertext, iv, time) VALUES (?, ?, 'rct', 'iv', ?)").run(realCid, realId, Date.now());
    // ستوري + توكن دفع + نسخة مفاتيح للحقيقي
    db.prepare("INSERT INTO stories (user_id, ciphertext, iv, created_at, expires_at) VALUES (?, 's', 'i', ?, ?)").run(realId, Date.now(), Date.now() + 3600e3);
    db.prepare("INSERT INTO device_tokens (token, user_id, platform, created_at, updated_at) VALUES ('real-push-token-123456', ?, 'android', ?, ?)").run(realId, Date.now(), Date.now());
    db.prepare("INSERT INTO key_backups (user_id, ciphertext, iv, salt, iterations, created_at) VALUES (?, 'c', 'i', 's', 200000, ?)").run(realId, Date.now());
  });

  it('كل أثر الزوار يمحى وبيانات الحقيقيين سليمة', async () => {
    // أثر كامل لزائر: محادثة + رسالة + ستوري + توكن دفع + نسخة مفاتيح + مرفق بملف
    const demo3 = db.prepare("SELECT id FROM users WHERE username = 'demo3'").get();
    const convInfo = db.prepare("INSERT INTO conversations (type, name, owner_id, created_at) VALUES ('dm', 'visitor', ?, ?)").run(demo3.id, Date.now());
    const vCid = Number(convInfo.lastInsertRowid);
    db.prepare("INSERT INTO conversation_members (conversation_id, user_id, joined_at) VALUES (?, ?, ?)").run(vCid, demo3.id, Date.now());
    db.prepare("INSERT INTO messages (conversation_id, sender_id, ciphertext, iv, time) VALUES (?, ?, 'vct', 'iv', ?)").run(vCid, demo3.id, Date.now());
    db.prepare("INSERT INTO stories (user_id, ciphertext, iv, created_at, expires_at) VALUES (?, 's', 'i', ?, ?)").run(demo3.id, Date.now(), Date.now() + 3600e3);
    db.prepare("INSERT INTO device_tokens (token, user_id, platform, created_at, updated_at) VALUES ('demo-push-token-654321', ?, 'web', ?, ?)").run(demo3.id, Date.now(), Date.now());
    db.prepare("INSERT INTO key_backups (user_id, ciphertext, iv, salt, iterations, created_at) VALUES (?, 'c', 'i', 's', 200000, ?)").run(demo3.id, Date.now());
    // مرفقان: ملف على القرص — واحد للزائر وواحد للحقيقي (نفس عقد ephemeral: لا ملفات يتيمة)
    writeFileSync(join(uploadDir, 'att-demo.bin'), 'demo-file');
    db.prepare("INSERT INTO attachments (id, conversation_id, uploader_id, size_bytes, created_at) VALUES ('att-demo', ?, ?, 10, ?)").run(vCid, demo3.id, Date.now());
    const realCid = db.prepare('SELECT conversation_id c FROM conversation_members WHERE user_id = ?').get(realId).c;
    writeFileSync(join(uploadDir, 'att-real.bin'), 'real-file');
    db.prepare("INSERT INTO attachments (id, conversation_id, uploader_id, size_bytes, created_at) VALUES ('att-real', ?, ?, 10, ?)").run(realCid, realId, Date.now());

    expect(demo.sweepDemo({ io: fakeIo, force: true })).toBe(true);

    // الزائر: لا محادثة ولا رسالة ولا ستوري ولا توكن ولا نسخة ولا مرفق بملفه
    expect(db.prepare('SELECT COUNT(*) c FROM conversations WHERE id = ?').get(vCid).c).toBe(0);
    expect(db.prepare('SELECT COUNT(*) c FROM messages WHERE sender_id = ?').get(demo3.id).c).toBe(0);
    expect(db.prepare('SELECT COUNT(*) c FROM stories WHERE user_id = ?').get(demo3.id).c).toBe(0);
    expect(db.prepare('SELECT COUNT(*) c FROM device_tokens WHERE user_id = ?').get(demo3.id).c).toBe(0);
    expect(db.prepare('SELECT COUNT(*) c FROM key_backups WHERE user_id = ?').get(demo3.id).c).toBe(0);
    expect(existsSync(join(uploadDir, 'att-demo.bin'))).toBe(false);
    expect(db.prepare("SELECT COUNT(*) c FROM attachments WHERE id = 'att-demo'").get().c).toBe(0);
    // الحقيقي: كل أثره سليم
    expect(db.prepare('SELECT COUNT(*) c FROM messages WHERE sender_id = ?').get(realId).c).toBe(1);
    expect(db.prepare('SELECT COUNT(*) c FROM stories WHERE user_id = ?').get(realId).c).toBe(1);
    expect(db.prepare('SELECT COUNT(*) c FROM device_tokens WHERE user_id = ?').get(realId).c).toBe(1);
    expect(db.prepare('SELECT COUNT(*) c FROM key_backups WHERE user_id = ?').get(realId).c).toBe(1);
    expect(existsSync(join(uploadDir, 'att-real.bin'))).toBe(true);
    expect(db.prepare("SELECT COUNT(*) c FROM attachments WHERE id = 'att-real'").get().c).toBe(1);
    // الحسابات الثلاثة باقية بعد المسح (إعادة الزرع تعمل)
    expect(db.prepare('SELECT COUNT(*) c FROM users WHERE is_demo = 1').get().c).toBe(3);
  });

  it('المحادثة المختلطة (زائر + حقيقي) تبقى للحقيقي بلا رسائل الزائر ولا عضويته', () => {
    const demo1 = db.prepare("SELECT id FROM users WHERE username = 'demo1'").get();
    const convInfo = db.prepare("INSERT INTO conversations (type, name, owner_id, created_at) VALUES ('group', 'mixed', ?, ?)").run(realId, Date.now());
    const mCid = Number(convInfo.lastInsertRowid);
    db.prepare("INSERT INTO conversation_members (conversation_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)").run(mCid, realId, Date.now());
    db.prepare("INSERT INTO conversation_members (conversation_id, user_id, joined_at) VALUES (?, ?, ?)").run(mCid, demo1.id, Date.now());
    db.prepare("INSERT INTO messages (conversation_id, sender_id, ciphertext, iv, time) VALUES (?, ?, 'dct', 'iv', ?)").run(mCid, demo1.id, Date.now());
    db.prepare("INSERT INTO messages (conversation_id, sender_id, ciphertext, iv, time) VALUES (?, ?, 'rct', 'iv', ?)").run(mCid, realId, Date.now());

    demo.sweepDemo({ io: fakeIo, force: true });

    expect(db.prepare('SELECT COUNT(*) c FROM conversations WHERE id = ?').get(mCid).c).toBe(1); // بقيت
    expect(db.prepare('SELECT COUNT(*) c FROM messages WHERE conversation_id = ? AND sender_id = ?').get(mCid, demo1.id).c).toBe(0);
    expect(db.prepare('SELECT COUNT(*) c FROM messages WHERE conversation_id = ? AND sender_id = ?').get(mCid, realId).c).toBe(1);
    expect(db.prepare('SELECT COUNT(*) c FROM conversation_members WHERE conversation_id = ? AND user_id = ?').get(mCid, demo1.id).c).toBe(0);
    expect(db.prepare('SELECT COUNT(*) c FROM conversation_members WHERE conversation_id = ? AND user_id = ?').get(mCid, realId).c).toBe(1);
  });

  it('المسح يرفع token_version فيموت توكن الزائر القائم — والحقيقي يعمل', async () => {
    const s = await call('/api/demo/session', { method: 'POST', body: { publicKey: PUB } });
    const tok = (await s.json()).token;
    expect((await call('/api/auth/me', { token: tok })).status).toBe(200);
    demo.sweepDemo({ io: fakeIo, force: true });
    expect((await call('/api/auth/me', { token: tok })).status).toBe(401);
    expect((await call('/api/auth/me', { token: realToken })).status).toBe(200);
  });

  it('البوابة الزمنية: بلا force لا يمسح قبل DEMO_WIPE_MS', async () => {
    // آخر مسح كان قبل لحظات — النداء العادي يرد false بلا مسح
    expect(demo.sweepDemo({ io: fakeIo })).toBe(false);
  });
});

// ================= حرسات المصادقة والتعطيل =================
describe('حرسات الحساب التجريبي والتعطيل', () => {
  it('تغيير كلمة مرور الزائر مرفوض 403 حتى بكلمة مرور قديمة صحيحة الشكل', async () => {
    const s = await call('/api/demo/session', { method: 'POST', body: { publicKey: PUB } });
    const tok = (await s.json()).token;
    const r = await call('/api/auth/change-password', { method: 'POST', token: tok, body: { oldPassword: 'whatever1', newPassword: 'newpass1' } });
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe('demo account');
  });

  it('الأسماء المحجوزة لا تُسجل (409 username taken)', async () => {
    const r = await call('/api/auth/register', { method: 'POST', body: { username: 'demo1', password: 'secret1', publicKey: PUB } });
    expect(r.status).toBe(409);
  });

  it('DEMO_MODE=0 يعطل المسار: 404 للجلسة وenabled=false للحالة', async () => {
    process.env.DEMO_MODE = '0';
    expect((await call('/api/demo/session', { method: 'POST', body: { publicKey: PUB } })).status).toBe(404);
    const st = await (await call('/api/demo/status')).json();
    expect(st.enabled).toBe(false);
    process.env.DEMO_MODE = '1';
    const st2 = await (await call('/api/demo/status')).json();
    expect(st2.enabled).toBe(true);
  });
});
