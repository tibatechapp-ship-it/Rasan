// sessions.test.js — اختبارات الجلسات المرئية (أسبوع 4 — نمط Signal «Linked devices»)
// راوتر auth حقيقي + JWT/bcrypt حقيقيان + DATA_DIR مؤقت — نفس نمط privacy.test.js.
//
// الضمانات:
// 1. كل دخول ينشئ جلسة والتوكن يحمل sid يطابقها — القائمة تراها بعلامة current.
// 2. طرد جهاز: DELETE /sessions/:sid يميت توكنه فوراً رغم صحة التوقيع، والبقية تكمل.
// 3. التوكنات القديمة بلا sid تكمل عاملًا (توافق رجعي — لا إجبار إعادة دخول عند الترقية).
// 4. logout-all وتغيير المرور يسحبان كل الجلسات — القائمة تُفرغ.
// 5. last_seen بقناع دقيقة: طلبان متتاليان لا يكتبان مرتين (كتابة واحدة/دقيقة كحد أقصى).
// 6. التحقق الصارم: sid غريب الصيغة 400، sid لمستخدم آخر 404، تصنيف الجهاز الخشن.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let db, auth, dataDir, app, server, port;

const bearer = (t) => ({ 'content-type': 'application/json', authorization: `Bearer ${t}` });
const PUB = Buffer.from(Uint8Array.from({ length: 65 }, (_, i) => (i === 0 ? 4 : 7))).toString('base64');
const call = (path, { method = 'GET', token, body, ua } = {}) =>
  fetch(`http://localhost:${port}${path}`, {
    method,
    headers: { ...(token ? bearer(token) : { 'content-type': 'application/json' }), ...(ua ? { 'user-agent': ua } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'rasan-sessions-test-'));
  process.env.DATA_DIR = dataDir;
  process.env.JWT_SECRET = 'w4-test-secret';
  process.env.RATE_MAX = '1000'; // الاختبارات المتتالية من IP واحد — نفس عقد LOGIN_LOCKOUT_MS
  const dbMod = await import('../server/db.js');
  db = dbMod.db;
  auth = await import('../server/auth.js');

  const express = (await import('express')).default;
  app = express();
  app.use(express.json());
  app.use('/api/auth', auth.router);
  app.get('/api/whoami', auth.authRequired, (req, res) => res.json({ id: req.user.id }));
  server = app.listen(0);
  port = server.address().port;
});

afterAll(() => {
  server?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const register = async (username, extra = {}) =>
  call('/api/auth/register', { method: 'POST', body: { username, password: 'secret1', publicKey: PUB, ...extra } });

describe('الجلسات المرئية — كل دخول جلسة (أسبوع 4)', () => {
  it('التسجيل ينشئ جلسة، والتوكن يحمل sid، والقائمة تعيّنه current', async () => {
    const reg = await register('w4sami', { device: 'TestOS' });
    expect(reg.status).toBe(200);
    const { token, user } = await reg.json();
    expect(user.username).toBe('w4sami');
    const list = await (await call('/api/auth/sessions', { token })).json();
    expect(list.sessions).toHaveLength(1);
    expect(list.sessions[0].device).toBe('TestOS');
    expect(list.sessions[0].current).toBe(true);
  });

  it('دخول ثانٍ = جلسة ثانية، والقائمة تعرض الكل والأحدث أولًا (التسجيل جلسة أولى)', async () => {
    await register('w4dana');
    const l1 = await (await call('/api/auth/login', { method: 'POST', body: { username: 'w4dana', password: 'secret1' } })).json();
    const l2 = await (await call('/api/auth/login', { method: 'POST', body: { username: 'w4dana', password: 'secret1' } })).json();
    expect(l1.token).not.toBe(l2.token);
    const list = (await (await call('/api/auth/sessions', { token: l2.token })).json()).sessions;
    expect(list).toHaveLength(3); // جلسة التسجيل + دخولان
    expect(list.filter((s) => s.current).length).toBe(1);
    expect(list[0].id).not.toBe(list[1].id);
  });

  it('طرد جهاز: توكنه يميت فوراً رغم صحة التوقيع — والجلسة الأخرى تكمل', async () => {
    const l1 = await (await call('/api/auth/login', { method: 'POST', body: { username: 'w4dana', password: 'secret1' } })).json();
    const l2 = await (await call('/api/auth/login', { method: 'POST', body: { username: 'w4dana', password: 'secret1' } })).json();
    const mine = (await (await call('/api/auth/sessions', { token: l1.token })).json()).sessions.find((s) => s.current);
    const other = (await (await call('/api/auth/sessions', { token: l2.token })).json()).sessions.find((s) => s.current);
    expect((await call('/api/whoami', { token: l1.token })).status).toBe(200);
    expect((await call('/api/whoami', { token: l2.token })).status).toBe(200);

    const kick = await call(`/api/auth/sessions/${other.id}`, { method: 'DELETE', token: l1.token });
    expect(kick.status).toBe(200);
    expect((await kick.json()).ok).toBe(true);

    expect((await call('/api/whoami', { token: l2.token })).status).toBe(401); // المطرود مات
    expect((await call('/api/whoami', { token: l1.token })).status).toBe(200); // الطارد حي
    // القائمة لم تعد تعرض المطرود، وطرده ثانيةً = 404
    const after = (await (await call('/api/auth/sessions', { token: l1.token })).json()).sessions;
    expect(after.some((s) => s.id === other.id)).toBe(false);
    expect((await call(`/api/auth/sessions/${other.id}`, { method: 'DELETE', token: l1.token })).status).toBe(404);
  });

  it('sid مستخدم آخر أو صيغة فاسدة تُرفض قبل أي لمس للبيانات', async () => {
    const a = await (await register('w4karim')).json();
    const b = await (await register('w4layla')).json();
    const bSession = (await (await call('/api/auth/sessions', { token: b.token })).json()).sessions[0];
    expect((await call(`/api/auth/sessions/${bSession.id}`, { method: 'DELETE', token: a.token })).status).toBe(404);
    expect((await call('/api/auth/sessions/not-a-sid', { method: 'DELETE', token: a.token })).status).toBe(400);
    expect((await call('/api/auth/sessions/' + 'a'.repeat(48), { method: 'DELETE', token: a.token })).status).toBe(404); // هيكس سليم غير موجود
    expect((await call('/api/auth/sessions/' + 'A'.repeat(48), { method: 'DELETE', token: a.token })).status).toBe(400); // ليست هيكس صغيرة
  });

  it('توكن قديم بلا sid يكمل عاملًا — ترقية بلا إجبار إعادة دخول', async () => {
    const { createRequire } = await import('node:module');
    const sRequire = createRequire(join(ROOT, 'server/'));
    const jwt = sRequire('jsonwebtoken');
    const row = db.prepare('SELECT id, username, token_version FROM users WHERE username = ?').get('w4karim');
    const legacy = jwt.sign({ sub: row.id, username: row.username, ver: row.token_version ?? 0 }, 'w4-test-secret', { expiresIn: '1d' });
    expect((await call('/api/whoami', { token: legacy })).status).toBe(200); // بلا فحص جلسة
    // لكن sid مزوّر (غير موجود في الجدول) يُرفض — لا سحب بالتخمين ولا التوكن المصنوع
    const forgedSid = jwt.sign({ sub: row.id, username: row.username, ver: row.token_version ?? 0, sid: 'f'.repeat(48) }, 'w4-test-secret', { expiresIn: '1d' });
    expect((await call('/api/whoami', { token: forgedSid })).status).toBe(401);
  });

  it('logout-all يسحب كل الجلسات — القائمة تُفرغ وكل التوكنات تموت', async () => {
    await register('w4nour');
    const t1 = await (await call('/api/auth/login', { method: 'POST', body: { username: 'w4nour', password: 'secret1' } })).json();
    const t2 = await (await call('/api/auth/login', { method: 'POST', body: { username: 'w4nour', password: 'secret1' } })).json();
    expect((await call('/api/auth/logout-all', { method: 'POST', token: t1.token, body: {} })).status).toBe(200);
    expect((await call('/api/whoami', { token: t1.token })).status).toBe(401);
    expect((await call('/api/whoami', { token: t2.token })).status).toBe(401);
    const fresh = await (await call('/api/auth/login', { method: 'POST', body: { username: 'w4nour', password: 'secret1' } })).json();
    expect((await (await call('/api/auth/sessions', { token: fresh.token })).json()).sessions).toHaveLength(1);
  });

  it('تغيير المرور يسحب كل الجلسات أيضاً (نفس عقد P6 + القائمة)', async () => {
    await register('w4hazem');
    const t1 = await (await call('/api/auth/login', { method: 'POST', body: { username: 'w4hazem', password: 'secret1' } })).json();
    await call('/api/auth/login', { method: 'POST', body: { username: 'w4hazem', password: 'secret1' } });
    expect((await call('/api/auth/change-password', { method: 'POST', token: t1.token, body: { oldPassword: 'secret1', newPassword: 'secret2' } })).status).toBe(200);
    const fresh = await (await call('/api/auth/login', { method: 'POST', body: { username: 'w4hazem', password: 'secret2' } })).json();
    expect((await (await call('/api/auth/sessions', { token: fresh.token })).json()).sessions).toHaveLength(1);
  });

  it('last_seen بقناع دقيقة: طلبان متلاصقان لا يكتبان مرتين، وتجاوز القناع يكتب', async () => {
    await register('w4qmar');
    const t = await (await call('/api/auth/login', { method: 'POST', body: { username: 'w4qmar', password: 'secret1' } })).json();
    const sid = (await (await call('/api/auth/sessions', { token: t.token })).json()).sessions[0].id;
    await call('/api/whoami', { token: t.token });
    const seen1 = db.prepare('SELECT last_seen FROM sessions WHERE id = ?').get(sid).last_seen;
    await call('/api/whoami', { token: t.token }); // داخل القناع — بلا كتابة
    expect(db.prepare('SELECT last_seen FROM sessions WHERE id = ?').get(sid).last_seen).toBe(seen1);
    db.prepare('UPDATE sessions SET last_seen = ? WHERE id = ?').run(Date.now() - 61000, sid); // تسريبات زمن
    await call('/api/whoami', { token: t.token });
    expect(db.prepare('SELECT last_seen FROM sessions WHERE id = ?').get(sid).last_seen).toBeGreaterThan(seen1);
  });

  it('التصنيف الخشن للجهاز من User-Agent عند غياب body.device — ولا يخزن بصمة UA', async () => {
    await register('w4omar');
    const t = await (await call('/api/auth/login', { method: 'POST', body: { username: 'w4omar', password: 'secret1' }, ua: 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 Chrome/125.0 Mobile Safari/537.36 VeryLongFingerprintString1234567890' })).json();
    const list = (await (await call('/api/auth/sessions', { token: t.token })).json()).sessions;
    const android = list.find((s) => s.current);
    expect(android.device).toBe('Android');
    expect(android.device.includes('S918B')).toBe(false); // صنف الجهاز لا السلسلة
  });

  it('سقف الجلسات: الدخول 35 مرة يبقي أحدث 30 فقط (بلا نمو غير محدود)', async () => {
    await register('w4faris');
    for (let i = 0; i < 35; i++) {
      await call('/api/auth/login', { method: 'POST', body: { username: 'w4faris', password: 'secret1' } });
    }
    const count = db.prepare("SELECT COUNT(*) c FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.username = 'w4faris'").get().c;
    expect(count).toBe(auth.SESSIONS_CAP);
  });
});
