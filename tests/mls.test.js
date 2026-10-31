// mls.test.js — أسبوع 3 من خارطة المنتَجة: بنية MLS (روح RFC 9420) للمجموعات
//
// الضمانات:
// 1. التشفير الصرف (وحدة الويب على WebCrypto حقيقي): الغلاف الإفيمرالي يفك بسرّ
//    المستقبل حصراً، commitment (SHA-256) يطابق السر ويكشف العبث، اشتقاق مفتاح
//    الإبوك مستقر، وأرشفة الإبوكات محدودة بسقفها.
// 2. الخادم (راوتر حقيقي + io وهمي + DATA_DIR مؤقت): التفعيل للمالك/المشرف فقط
//    وللمجموعات/القنوات، الإبوك = الأخير+1 حصراً (السباق 409)، أهداف الأغلفة
//    أعضاء فعليون، current_key_version يرتفع مع الإبوك فيبقى عقد مسار الإرسال
//    القائم (key_version_mismatch) صحيحاً بلا تعديل فيه، وغير العضو 403.
// 3. محاكاة ميدانية موثقة (docs/MLS_FIELD_TEST.md): 6 أعضاء — إبوكات بمنشئين
//    مختلفين، سباق commit يتتبنّى الفائز، انضمام متأخر يعيد التهيئة بنفسه،
//    مغادرة تُوقف فك المستقبل، وفك تاريخ الإبوكات من الأرشيف ثم مسحه.
// 4. عقود الأسلاك: تركيب server.js، جداول db.js، تحميل index.html، دمج app.js،
//    مفاتيح i18n باللغتين، ومتغير ORIGIN.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

let db;
let app;
let server;
let port;
let dataDir;
let emitted = [];

const fakeAuth = (req, res, next) => {
  const m = /^Bearer u:(\d+)$/.exec(req.headers.authorization || '');
  const user = m && db.prepare('SELECT id, username FROM users WHERE id = ?').get(Number(m[1]));
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  req.user = user;
  next();
};
const fakeIo = { to: (room) => ({ emit: (event, payload) => emitted.push({ room, event, payload }) }) };
const bearer = (t) => ({ 'content-type': 'application/json', authorization: `Bearer ${t}` });
const call = (path, { method = 'GET', token, body } = {}) =>
  fetch(`http://localhost:${port}${path}`, { method, headers: token ? bearer(token) : { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });

const M = () => globalThis.RasanMls;
const randomSecret = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
async function genKeypair() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']);
  return {
    pub: btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)))),
    priv: btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey)))),
  };
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'rasan-mls-test-'));
  process.env.DATA_DIR = dataDir;
  process.env.JWT_SECRET = 'mls-test-secret';
  const dbMod = await import('../server/db.js');
  db = dbMod.db;
  await import('../server/mls.js');
  await import('../web/mls.js');

  const express = (await import('express')).default;
  app = express();
  app.use(express.json());
  app.use('/api', (await import('../server/mls.js')).createRouter({ authRequired: fakeAuth, io: fakeIo }));
  server = app.listen(0);
  port = server.address().port;

  // خمسة مستخدمين: مالك + عضو عادي + مشرف + عضو ثانٍ + غريب
  const t = Date.now();
  for (const [id, name] of [[1, 'mls_owner'], [2, 'mls_member'], [3, 'mls_admin'], [4, 'mls_member2'], [5, 'mls_outsider']]) {
    db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)').run(id, name, 'x', t + id);
  }
  // مجموعة (id=1) + قناة (id=2) + DM (id=3)
  db.prepare("INSERT INTO conversations (id, type, name, owner_id, created_at) VALUES (1, 'group', 'مجموعة MLS', 1, ?)").run(t);
  db.prepare("INSERT INTO conversation_members (conversation_id, user_id, role, joined_at) VALUES (1, 1, 'owner', ?), (1, 2, 'member', ?), (1, 3, 'admin', ?), (1, 4, 'member', ?)").run(t, t, t, t);
  db.prepare("INSERT INTO conversations (id, type, name, owner_id, created_at) VALUES (2, 'channel', 'قناة', 1, ?)").run(t);
  db.prepare("INSERT INTO conversation_members (conversation_id, user_id, role, joined_at) VALUES (2, 1, 'owner', ?), (2, 2, 'member', ?)").run(t, t);
  db.prepare("INSERT INTO conversations (id, type, name, owner_id, created_at) VALUES (3, 'dm', NULL, NULL, ?)").run(t);
  db.prepare("INSERT INTO conversation_members (conversation_id, user_id, role, joined_at) VALUES (3, 1, 'member', ?), (3, 2, 'member', ?)").run(t, t);
});

afterAll(() => {
  server?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

// ===== 1) وحدة العميل: التشفير الصرف =====
describe('web/mls.js — التشفير الصرف (WebCrypto حقيقي)', () => {
  let alice;
  let bob;
  beforeAll(async () => {
    alice = await genKeypair();
    bob = await genKeypair();
  });

  it('الغلاف الإفيمرالي يفك بسرّ المستقبل حصراً إلى نفس سرّ الإبوك', async () => {
    const secret = randomSecret();
    const wrap = await M().wrapForMember(secret, bob.pub);
    expect(wrap.eph_pub).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(await M().unwrapEpochSecret(wrap, bob.priv)).toBe(secret);
    // مفتاح آلايس لا يفك غلاف بوب (المفتاح المشتق من ECDH مختلف)
    await expect(M().unwrapEpochSecret(wrap, alice.priv)).rejects.toThrow();
  });

  it('commitment (SHA-256) يطابق السر ويكشف أي غلاف مُعبَّث به', async () => {
    const secret = randomSecret();
    const c = await M().computeCommitment(secret);
    expect(c).toMatch(/^[0-9a-f]{64}$/);
    expect(c).toBe(await M().computeCommitment(secret));
    expect(c).not.toBe(await M().computeCommitment(randomSecret()));
    // عبث في الغلاف → فكه يعطي سراً مختلفاً → commitment لا يطابق
    const wrap = await M().wrapForMember(secret, bob.pub);
    const tampered = { ...wrap, wrapped_key: btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(48)))) };
    const got = await M().unwrapEpochSecret(tampered, bob.priv).catch(() => null);
    if (got) expect(await M().computeCommitment(got)).not.toBe(c);
  });

  it('اشتقاق مفتاح الإبوك مستقر — نفس السر يفك نفس النص (عربي)', async () => {
    const secret = randomSecret();
    const k1 = await M().deriveEpochKey(secret);
    const k2 = await M().deriveEpochKey(secret);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k1, new TextEncoder().encode('سلام MLS'));
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, k2, ct);
    expect(new TextDecoder().decode(pt)).toBe('سلام MLS');
  });

  it('أرشفة الإبوكات محدودة بسقف 32 — الأقدم يُمسح أولاً وwipe يمحو الكل', () => {
    const st = { epoch: 1, secret: 'a', history: {} };
    for (let e = 2; e <= 40; e++) st.history[String(e)] = 's' + e;
    M().saveLocal('conv-cap-test', st);
    const saved = JSON.parse(localStorage.getItem('rasan_mls_conv-cap-test'));
    const keys = Object.keys(saved.history).map(Number).sort((a, b) => a - b);
    expect(keys.length).toBe(M().HISTORY_CAP);
    expect(keys[0]).toBe(40 - M().HISTORY_CAP + 1);
    expect(keys[keys.length - 1]).toBe(40);
    M().wipe('conv-cap-test');
    expect(localStorage.getItem('rasan_mls_conv-cap-test')).toBe(null);
  });
});

// ===== 2) الخادم: عقود REST الصارمة (راوتر حقيقي) =====
describe('server/mls.js — عقود الخادم', () => {
  it('التفعيل: غريب 403، DM 400، قيمة غير منطقية 400، عضو عادي 403، المشرف ينجح ويبث', async () => {
    expect((await call('/api/conversations/1/mls/enabled', { method: 'PUT', token: 'u:5', body: { enabled: true } })).status).toBe(403);
    expect((await call('/api/conversations/3/mls/enabled', { method: 'PUT', token: 'u:1', body: { enabled: true } })).status).toBe(400);
    expect((await call('/api/conversations/1/mls/enabled', { method: 'PUT', token: 'u:1', body: { enabled: 'yes' } })).status).toBe(400);
    expect((await call('/api/conversations/1/mls/enabled', { method: 'PUT', token: 'u:2', body: { enabled: true } })).status).toBe(403);
    emitted.length = 0;
    const r = await call('/api/conversations/1/mls/enabled', { method: 'PUT', token: 'u:3', body: { enabled: true } });
    expect(r.status).toBe(200);
    expect((await r.json()).mls_enabled).toBe(true);
    expect(emitted.some((e) => e.event === 'mls:enabled' && e.room === 'conv:1' && e.payload.enabled === true)).toBe(true);
  });

  it('state للعضو يظهر { enabled, epoch:0 } وللغريب 403', async () => {
    const r = await call('/api/conversations/1/mls/state', { token: 'u:2' });
    expect(r.status).toBe(200);
    const s = await r.json();
    expect(s.enabled).toBe(true);
    expect(s.epoch).toBe(0);
    expect((await call('/api/conversations/1/mls/state', { token: 'u:5' })).status).toBe(403);
  });

  it('commit: عضو عادي ينجح (خاصية أي-عضو) ويرفع current_key_version إلى الإبوك', async () => {
    const secret = randomSecret();
    const commitment = await M().computeCommitment(secret);
    const wraps = [];
    for (const uid of [1, 2, 3, 4]) wraps.push({ userId: uid, ...(await M().wrapForMember(secret, (await genKeypair()).pub)) });
    emitted.length = 0;
    const r = await call('/api/conversations/1/mls/commit', { method: 'POST', token: 'u:2', body: { epoch: 1, commitment, wraps } });
    expect(r.status).toBe(200);
    expect(db.prepare('SELECT current_key_version v FROM conversations WHERE id = 1').get().v).toBe(1);
    expect(db.prepare('SELECT COUNT(*) c FROM mls_wraps WHERE conversation_id = 1 AND epoch = 1').get().c).toBe(4);
    expect(emitted.some((e) => e.event === 'mls:commit' && e.room === 'conv:1' && e.payload.epoch === 1)).toBe(true);
  });

  it('commit: الرفوض الصارمة — غير عضو 403، غير مفعّلة 400، إبوك خاطئ 400/409، أهداف غير أعضاء 400', async () => {
    const commitment = await M().computeCommitment(randomSecret());
    const okWrap = { userId: 1, ...(await M().wrapForMember(randomSecret(), (await genKeypair()).pub)) };
    expect((await call('/api/conversations/1/mls/commit', { method: 'POST', token: 'u:5', body: { epoch: 2, commitment, wraps: [okWrap] } })).status).toBe(403);
    expect((await call('/api/conversations/2/mls/commit', { method: 'POST', token: 'u:1', body: { epoch: 1, commitment, wraps: [okWrap] } })).status).toBe(400); // قناة غير مفعّلة
    expect((await call('/api/conversations/1/mls/commit', { method: 'POST', token: 'u:1', body: { epoch: 0, commitment, wraps: [okWrap] } })).status).toBe(400);
    expect((await call('/api/conversations/1/mls/commit', { method: 'POST', token: 'u:1', body: { epoch: '1', commitment, wraps: [okWrap] } })).status).toBe(400);
    expect((await call('/api/conversations/1/mls/commit', { method: 'POST', token: 'u:1', body: { epoch: 2, commitment: 'zz', wraps: [okWrap] } })).status).toBe(400);
    expect((await call('/api/conversations/1/mls/commit', { method: 'POST', token: 'u:1', body: { epoch: 2, commitment, wraps: [] } })).status).toBe(400);
    // كل الأهداف أغبياء غير أعضاء (u:5) → لا أغلفة صالحة
    const outWrap = { userId: 5, ...(await M().wrapForMember(randomSecret(), (await genKeypair()).pub)) };
    expect((await call('/api/conversations/1/mls/commit', { method: 'POST', token: 'u:1', body: { epoch: 2, commitment, wraps: [outWrap] } })).status).toBe(400);
    // إبوك يتجاوز الأخير+1
    const far = await call('/api/conversations/1/mls/commit', { method: 'POST', token: 'u:1', body: { epoch: 7, commitment, wraps: [okWrap] } });
    expect(far.status).toBe(409);
    expect((await far.json()).expected).toBe(2);
  });

  it('commit: الإبوك الثاني بنجاح ثم إعادة الإبوك نفسه 409 (لا إعادة تشغيل السلسلة)', async () => {
    const secret = randomSecret();
    const commitment = await M().computeCommitment(secret);
    const wraps = [{ userId: 1, ...(await M().wrapForMember(secret, (await genKeypair()).pub)) }, { userId: 2, ...(await M().wrapForMember(secret, (await genKeypair()).pub)) }];
    expect((await call('/api/conversations/1/mls/commit', { method: 'POST', token: 'u:3', body: { epoch: 2, commitment, wraps } })).status).toBe(200);
    expect(db.prepare('SELECT current_key_version v FROM conversations WHERE id = 1').get().v).toBe(2);
    expect((await call('/api/conversations/1/mls/commit', { method: 'POST', token: 'u:1', body: { epoch: 2, commitment, wraps } })).status).toBe(409);
  });

  it('wraps/:epoch: العضو يجلب غلافه وcommitment — والغيبات 404/403/400', async () => {
    const r = await call('/api/conversations/1/mls/wraps/2', { token: 'u:2' });
    expect(r.status).toBe(200);
    const p = await r.json();
    expect(p.epoch).toBe(2);
    expect(p.commitment).toMatch(/^[0-9a-f]{64}$/);
    expect(p.wrap.eph_pub).toBeTruthy();
    expect((await call('/api/conversations/1/mls/wraps/2', { token: 'u:5' })).status).toBe(403); // غريب
    expect((await call('/api/conversations/1/mls/wraps/2', { token: 'u:3' })).status).toBe(404); // عضو بلا غلاف في هذا الإبوك
    expect((await call('/api/conversations/1/mls/wraps/99', { token: 'u:2' })).status).toBe(404); // إبوك غير موجود
    expect((await call('/api/conversations/1/mls/wraps/x', { token: 'u:2' })).status).toBe(400);
  });

  it('الإيقاف (صمّام أمان): مشرف يوقف، commit بعده يرفض، current_key_version يبقى عند آخر إبوك', async () => {
    expect((await call('/api/conversations/1/mls/enabled', { method: 'PUT', token: 'u:3', body: { enabled: false } })).status).toBe(200);
    const commitment = await M().computeCommitment(randomSecret());
    const wrap = { userId: 1, ...(await M().wrapForMember(randomSecret(), (await genKeypair()).pub)) };
    expect((await call('/api/conversations/1/mls/commit', { method: 'POST', token: 'u:1', body: { epoch: 3, commitment, wraps: [wrap] } })).status).toBe(400);
    expect(db.prepare('SELECT current_key_version v FROM conversations WHERE id = 1').get().v).toBe(2);
    // إعادة التفعيل تعمل والسلسلة تكمل من حيث توقفت (3 = 2+1)
    expect((await call('/api/conversations/1/mls/enabled', { method: 'PUT', token: 'u:1', body: { enabled: true } })).status).toBe(200);
    const secret = randomSecret();
    expect((await call('/api/conversations/1/mls/commit', { method: 'POST', token: 'u:1', body: { epoch: 3, commitment: await M().computeCommitment(secret), wraps: [{ userId: 1, ...(await M().wrapForMember(secret, (await genKeypair()).pub)) }] } })).status).toBe(200);
  });
});

// ===== 3) المحاكاة الميدانية (6 أعضاء — خادم وهمي بنفس عقود الخادم الحقيقي) =====
// الحقائب: حالة MLS لكل عضو تعيش في localStorage مفتاح واحد — ننقلها بين الأعضاء
// كما تنتقل بين متصفحات حقيقية (وحدة العميل singleton مثل المتصفح الواحد).
describe('محاكاة ميدانية — دورة حياة كاملة (6 أعضاء)', () => {
  const CONV = 'sim-conv';
  let serverSim;
  let actors;
  let currentActor;

  function makeActor(id) {
    return genKeypair().then((kp) => ({ id, ...kp, bag: null, active: true }));
  }
  // الحقائب: حالة MLS لكل عضو تعيش في localStorage بمفتاح واحد (وحدة العميل
  // singleton كالمتصفح الواحد) — ننقلها بين الأعضاء كأنها أجهزة منفصلة، ونمسح
  // كاش مفاتيح الوحدة عند كل تبديل فلا يتسرب مفتاح بين «متصفحين» مختلفين
  async function as(actor, fn) {
    localStorage.removeItem(`rasan_mls_${CONV}`);
    M().wipe(CONV);
    currentActor = actor;
    if (actor.bag) localStorage.setItem(`rasan_mls_${CONV}`, actor.bag);
    try { return await fn(); } finally {
      actor.bag = localStorage.getItem(`rasan_mls_${CONV}`); // المكان الوحيد للحفظ — لا قراءة من مخزن ممسوح بعده
      localStorage.removeItem(`rasan_mls_${CONV}`);
      M().wipe(CONV);
    }
  }

  beforeAll(async () => {
    localStorage.clear();
    actors = await Promise.all([1, 2, 3, 4, 5, 6].map(makeActor));
    actors[5].active = false; // السادس ينضم لاحقاً (لا غلاف له في إبوكات البداية)
    currentActor = null;
    serverSim = {
      enabled: false,
      currentEpoch: 0,
      epochs: new Map(),
      raceHook: null, // يُستدعى قبل أول commit تالٍ — يحاكي فائزاً خفياً في سباق commit
      members: () => actors.filter((a) => a.active).map((a) => ({ id: a.id, public_key: a.pub })),
    };
    // خادم وهمي بنفس عقود server/mls.js الحقيقية (إبوك = الأخير+1 + العضوية)
    const api = async (path, opts = {}) => {
      if (path === `/api/conversations/${CONV}/mls/state`) {
        const e = serverSim.epochs.get(serverSim.currentEpoch);
        return { enabled: serverSim.enabled, epoch: serverSim.currentEpoch, commitment: e?.commitment || null };
      }
      if (path === `/api/conversations/${CONV}/mls/enabled`) {
        serverSim.enabled = JSON.parse(opts.body).enabled;
        return { ok: true, mls_enabled: serverSim.enabled };
      }
      if (path === `/api/conversations/${CONV}/mls/commit`) {
        if (serverSim.raceHook) { const h = serverSim.raceHook; serverSim.raceHook = null; await h(); }
        const { epoch, commitment, wraps } = JSON.parse(opts.body);
        if (epoch !== serverSim.currentEpoch + 1) throw new Error('epoch conflict');
        serverSim.epochs.set(epoch, { commitment, wraps });
        serverSim.currentEpoch = epoch;
        return { ok: true, epoch };
      }
      const wm = /^\/api\/conversations\/[^/]+\/mls\/wraps\/(\d+)$/.exec(path);
      if (wm) {
        const e = serverSim.epochs.get(Number(wm[1]));
        if (!e) throw new Error('no such epoch');
        const wrap = e.wraps.find((w) => w.userId === currentActor.id);
        if (!wrap) throw new Error('no wrap for user');
        return { epoch: Number(wm[1]), commitment: e.commitment, wrap };
      }
      if (path === `/api/conversations/${CONV}/members`) return { members: serverSim.members() };
      throw new Error('unknown path: ' + path);
    };
    M().init({ api });
  });

  it('التفعيل + إبوك 1 من المؤسس — بقية الأعضاء يتبنّون ويشتقون نفس المفتاح', async () => {
    serverSim.enabled = true;
    await as(actors[0], async () => {
      const r = await M().ensure({ id: CONV, mls_enabled: 1 }, { privateKey: actors[0].priv });
      expect(r.epoch).toBe(1);
    });
    expect(serverSim.currentEpoch).toBe(1);
    const keys = [];
    for (const a of actors.slice(1, 5)) {
      await as(a, async () => {
        const r = await M().ensure({ id: CONV, mls_enabled: 1 }, { privateKey: a.priv });
        expect(r.epoch).toBe(1);
        keys.push(r.key);
      });
    }
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, keys[0], new TextEncoder().encode('رسالة الإبوك الأول'));
    for (const k of keys) expect(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, k, ct))).toBe('رسالة الإبوك الأول');
  });

  it('إبوك 2 من عضو عادي (أي-عضو خاصية MLS) — الجميع يتبنّى ومفتاح الإبوك يتغير فعلاً', async () => {
    await as(actors[2], async () => {
      const r = await M().commitNewEpoch(CONV, { privateKey: actors[2].priv });
      expect(r.epoch).toBe(2);
    });
    const keys = [];
    for (const a of [actors[0], actors[1], actors[3]]) {
      await as(a, async () => {
        const r = await M().adopt(CONV, { privateKey: a.priv }, 2);
        expect(r.epoch).toBe(2);
        keys.push(r.key);
      });
    }
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ctNew = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, keys[0], new TextEncoder().encode('x'));
    // مفتاح الإبوك 1 لا يفك إبوك 2 (تناوب حقيقي — لا مفتاح ثابت)
    const oldKey = await as(actors[0], () => M().keyForEpoch(CONV, 1));
    await expect(crypto.subtle.decrypt({ name: 'AES-GCM', iv }, oldKey, ctNew)).rejects.toThrow();
    expect(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, keys[1], ctNew))).toBe('x');
  });

  it('إبوك 3 عادي ثم سباق commit: الخاسر يتتبنّى إبوك الفائز الخفي (409 → adopt)', async () => {
    await as(actors[3], async () => {
      const r = await M().commitNewEpoch(CONV, { privateKey: actors[3].priv });
      expect(r.epoch).toBe(3);
    });
    // فائز خفي يرسل إبوك 4 قبيل محاولة actors[3] الثانية (نقر مزدوج متزامن)
    serverSim.raceHook = async () => {
      const secret = randomSecret();
      const commitment = await M().computeCommitment(secret);
      const wraps = [];
      for (const a of actors.filter((x) => x.active)) wraps.push({ userId: a.id, ...(await M().wrapForMember(secret, a.pub)) });
      serverSim.epochs.set(4, { commitment, wraps });
      serverSim.currentEpoch = 4;
    };
    await as(actors[3], async () => {
      const r = await M().commitNewEpoch(CONV, { privateKey: actors[3].priv });
      expect(r.epoch).toBe(4); // تبنّى إبوك الفائز بدل فشل صامت
    });
    const c = await as(actors[3], async () => M().computeCommitment(M().local(CONV).secret));
    expect(c).toBe(serverSim.epochs.get(4).commitment);
  });

  it('انضمام متأخر: السادس بلا غلاف → يعيد التهيئة بنفسه بإبوك 5 يشمل الجميع الستة', async () => {
    actors[5].active = true;
    await as(actors[5], async () => {
      const r = await M().ensure({ id: CONV, mls_enabled: 1 }, { privateKey: actors[5].priv });
      expect(r.epoch).toBe(5); // adopt فشل (لا غلاف) → commitNewEpoch
    });
    expect(serverSim.currentEpoch).toBe(5);
    expect(serverSim.epochs.get(5).wraps.length).toBe(6);
    for (const a of [actors[0], actors[1]]) {
      await as(a, async () => {
        const r = await M().adopt(CONV, { privateKey: a.priv }, 5);
        expect(r.epoch).toBe(5);
      });
    }
  });

  it('المغادرة: المطرود خارج أغلفة الإبوك 6 — لا يفك الجديد (الخاصية الأمنية المحورية)', async () => {
    actors[4].active = false; // طرد العضو الخامس
    await as(actors[1], async () => {
      const r = await M().commitNewEpoch(CONV, { privateKey: actors[1].priv });
      expect(r.epoch).toBe(6);
    });
    expect(serverSim.epochs.get(6).wraps.find((w) => w.userId === actors[4].id)).toBeUndefined();
    await as(actors[4], async () => {
      expect(await M().keyForEpoch(CONV, 6)).toBe(null); // لا سر محلي ولا غلاف من الخادم
    });
    await as(actors[0], async () => {
      const r = await M().adopt(CONV, { privateKey: actors[0].priv }, 6);
      expect(r.epoch).toBe(6);
    });
  });

  it('فك التاريخ: رسائل الإبوك 1 تفك من أرشيف عضو قديم — وwipe يمحو كل شيء', async () => {
    await as(actors[0], async () => {
      const k1 = await M().keyForEpoch(CONV, 1);
      expect(k1).toBeTruthy();
      const secret1 = M().local(CONV).history['1'];
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await M().deriveEpochKey(secret1), new TextEncoder().encode('التاريخ لا يضيع'));
      expect(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, k1, ct))).toBe('التاريخ لا يضيع');
      M().wipe(CONV);
      expect(await M().keyForEpoch(CONV, 1)).toBe(null);
      expect(M().local(CONV)).toBe(null);
    });
  });
});

// ===== 4) عقود الأسلاك =====
describe('عقود الأسلاك — تركيب MLS عبر المستودع', () => {
  const serverSrc = read('server/server.js');
  const dbSrc = read('server/db.js');
  const htmlSrc = read('web/index.html');
  const appSrc = read('web/app.js');
  const i18nSrc = read('web/i18n.js');

  it('server.js: يتطلب mls ويركّبه على /api ويضيف mls_enabled لقائمة المحادثات وORIGIN بيئياً', () => {
    expect(serverSrc).toContain('require("./mls")');
    expect(serverSrc).toContain('mls.createRouter({ authRequired, io })');
    expect(serverSrc).toContain('c.mls_enabled');
    expect(serverSrc).toContain('process.env.ORIGIN');
  });

  it('db.js: جدولا mls_epochs وmls_wraps وعمود mls_enabled مع CASCADE', () => {
    expect(dbSrc).toContain('CREATE TABLE IF NOT EXISTS mls_epochs');
    expect(dbSrc).toContain('CREATE TABLE IF NOT EXISTS mls_wraps');
    expect(dbSrc).toContain('ALTER TABLE conversations ADD COLUMN mls_enabled INTEGER DEFAULT 0');
    expect(dbSrc).toContain('idx_mls_wraps_user');
  });

  it('index.html: يحمّل mls.js قبل app.js', () => {
    expect(htmlSrc).toContain('<script src="/mls.js"></script>');
    expect(htmlSrc.indexOf('/mls.js')).toBeLessThan(htmlSrc.indexOf('/app.js'));
  });

  it('app.js: الحقن وضمانات الدمج كلها موجودة', () => {
    expect(appSrc).toContain('RasanMls.init({ api })');
    expect(appSrc).toContain('RasanMls.ensure(');
    expect(appSrc).toContain('RasanMls.commitNewEpoch(');
    expect(appSrc).toContain('RasanMls.adopt(');
    expect(appSrc).toContain('RasanMls.keyForEpoch(');
    expect(appSrc).toContain('state.socket.on("mls:commit"');
    expect(appSrc).toContain('state.socket.on("mls:enabled"');
    // حرس MLS في member:added — مسار التغليف القديم لا يلوث سلسلة الإبوكات
    expect(appSrc).toContain('if (state.activeConv.mls_enabled) return;');
  });

  it('i18n: مفاتيح MLS الخمسة بالعربية والإنجليزية', () => {
    const keys = ['mlsEnableConfirm', 'mlsRotateConfirm', 'mlsEnabledToast', 'mlsDisabledToast', 'mlsRotatedToast'];
    for (const k of keys) {
      expect(i18nSrc).toContain(`${k}:"`);
      expect(i18nSrc.match(new RegExp(`${k}:"`, 'g')).length).toBe(2);
    }
  });
});
