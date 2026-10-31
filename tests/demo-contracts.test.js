// demo-contracts.test.js — عقود أسلاك P7 (تركيب الصفحة والخادم والعميل والـCI)
//
// نفس منهج p6-contracts: العقد هو «السلك الصحيح» — أن كل قطعة موصولة بالمكان
// الذي يستخدمها فعلاً. فشل العقد هنا يمنع انفصال الصامت (كود موجود بلا توصيل).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const serverSrc = read('server/server.js');
const demoSrc = read('server/demo.js');
const authSrc = read('server/auth.js');
const dbSrc = read('server/db.js');
const appSrc = read('web/app.js');
const htmlSrc = read('web/index.html');
const i18nSrc = read('web/i18n.js');
const styleSrc = read('web/style.css');
const demoHtmlSrc = read('web/demo.html');
const demoJsSrc = read('web/demo.js');

describe('تركيب الخادم (server.js)', () => {
  it('الوحدة مطلوبة والراوتر مركّب على /api مع signToken الحقيقي', () => {
    expect(serverSrc).toContain('const demo = require("./demo")');
    expect(serverSrc).toContain('demo.createRouter({ signToken, io })');
  });
  it('الإقلاع: زرع الحسابات + مسح قسري قبل استقبال الاتصالات — بشرط التمكين', () => {
    expect(serverSrc).toContain('if (demo.demoEnabled())');
    expect(serverSrc).toContain('demo.ensureDemoAccounts()');
    expect(serverSrc).toContain('demo.sweepDemo({ io, force: true })');
  });
  it('المسح الدوري مربوط بمنظّف stories كل 60 ثانية (نمط P6)', () => {
    expect(serverSrc).toContain('demo.sweepDemo({ io });');
  });
  it('signToken مصدَّر من auth.js — توقيع الجلسة بآلية المصادقة نفسها', () => {
    expect(authSrc).toContain('module.exports = { router, verifyToken, JWT_SECRET, authRequired, loginLocked, recordLoginFail, recordLoginSuccess, LOGIN_LOCKOUT_MS, LOGIN_MAX_FAILS, signToken, RESERVED_USERNAMES }');
  });
});

describe('عقد الوحدة (server/demo.js)', () => {
  it('المسح الصحي نطاقان منفصلان: الأهداف vs كل الزوار (لا مسح عابر للحسابات)', () => {
    expect(demoSrc).toContain('const targets =');
    expect(demoSrc).toContain('const demoAll =');
    expect(demoSrc).toContain('WHERE m.user_id IN (${inT})');
    expect(demoSrc).toContain('x.user_id NOT IN (${inD})');
  });
  it('بث conv:declined للمحادثات النقية — نفس حدث الرفض P6 (العميل يعالجه أصلاً)', () => {
    expect(demoSrc).toContain('conv:declined');
  });
  it('المرفقات تمسح بملفاتها من القرص (نمط ephemeral — لا ملفات يتيمة)', () => {
    expect(demoSrc).toContain('fs.unlinkSync(path.join(UPLOAD_DIR, id + ".bin"))');
  });
  it('البوابة الزمنية والقسر: force يتجاوز، وغير القسري يلتزم DEMO_WIPE_MS', () => {
    expect(demoSrc).toContain('if (!force && now - lastWipeAt < DEMO_WIPE_MS) return false;');
    expect(demoSrc).toContain('Math.max(60 * 1000, Number(process.env.DEMO_WIPE_MS)');
  });
  it('التعطيل البيئي DEMO_MODE=0 يعطل المسار والحالة معاً', () => {
    expect(demoSrc).toContain('return process.env.DEMO_MODE !== "0";');
    expect(demoSrc).toContain('if (!demoEnabled()) return res.status(404)');
  });
  it('الزرع يتجاهل الحساب الحقيقي صاحب الاسم ولا يمسه', () => {
    expect(demoSrc).toContain('مملوك لحساب حقيقي');
  });
});

describe('حرسات المصادقة (auth.js + db.js)', () => {
  it('الأسماء المحجوزة عن التسجيل العام', () => {
    expect(authSrc).toContain('RESERVED_USERNAMES.has(u.toLowerCase())');
    expect(authSrc).toContain('new Set(["demo", "demo1", "demo2", "demo3"])');
  });
  it('تغيير كلمة مرور الزائر مرفوض قبل أي تحقق آخر', () => {
    expect(authSrc).toContain('if (req.user.is_demo) return res.status(403).json({ error: "demo account" });');
  });
  it('is_demo متاح في الجلسة (authRequired) وفي الدخول', () => {
    expect(authSrc).toContain('created_at, token_version, is_demo FROM users');
    expect(authSrc).toContain('is_demo: !!row.is_demo');
  });
  it('الترحيلان التلقائيان في db.js: is_demo و demo_last_used', () => {
    expect(dbSrc).toContain('ALTER TABLE users ADD COLUMN is_demo INTEGER DEFAULT 0');
    expect(dbSrc).toContain('ALTER TABLE users ADD COLUMN demo_last_used INTEGER DEFAULT 0');
  });
});

describe('صفحة الهبوط (web/demo.html + demo.js)', () => {
  it('الأصول موصولة: style.css و crypto.js و demo.js', () => {
    expect(demoHtmlSrc).toContain('<link rel="stylesheet" href="/style.css" />');
    expect(demoHtmlSrc).toContain('<script src="/crypto.js"></script>');
    expect(demoHtmlSrc).toContain('<script src="/demo.js"></script>');
  });
  it('عناصر العقد: زر التجربة + ملاحظة الحالة + الخطوات الثلاث + مبدّل اللغة', () => {
    expect(demoHtmlSrc).toContain('id="try-btn"');
    expect(demoHtmlSrc).toContain('id="try-note"');
    expect(demoHtmlSrc).toContain('id="lang-btn"');
    expect(demoHtmlSrc).toContain('class="steps"');
    expect(demoHtmlSrc).toContain('class="feats"');
  });
  it('المسار الكامل للزائر: مفاتيح محلية أولاً ثم جلسة ثم rasan_token ثم تحويل', () => {
    expect(demoJsSrc).toContain('RasanCrypto.genKeypair()');
    expect(demoJsSrc).toContain('idbPut("myKeypair", kp)');
    expect(demoJsSrc).toContain('"/api/demo/session"');
    expect(demoJsSrc).toContain('localStorage.setItem("rasan_token", data.token)');
    expect(demoJsSrc).toContain('location.href = "/"');
  });
  it('حماية الحساب الحقيقي: مفاتيحه تُحفظ في myKeypair_prev قبل أي تجربة', () => {
    expect(demoJsSrc).toContain('myKeypair_prev');
    expect(demoJsSrc).toContain('user.is_demo');
    expect(demoJsSrc).toContain('localStorage.removeItem("rasan_token")');
  });
  it('التعطيل يظهر للزائر بلا فشل صامت (status ثم إخفاء الزر)', () => {
    expect(demoJsSrc).toContain('"/api/demo/status"');
    expect(demoJsSrc).toContain('btn.disabled = true');
  });
  it('الثنائية ar/en مع اتجاه RTL/LTR واللغة تُورث للتطبيق (rasan_locale)', () => {
    expect(demoJsSrc).toContain('localStorage.getItem("rasan_locale")');
    expect(demoJsSrc).toContain('localStorage.setItem("rasan_locale", locale)');
    expect(demoJsSrc).toContain('document.documentElement.dir = d.dir');
  });
  it('مخزن IndexedDB هو نفس مخزن التطبيق («rasan» / kv) — التطبيق يجد المفاتيح', () => {
    expect(demoJsSrc).toContain('indexedDB.open("rasan", 1)');
    expect(appSrc).toContain('indexedDB.open("rasan", 1)');
  });
});

describe('تركيب العميل (app.js + index.html + i18n + style)', () => {
  it('شارة الزائر: عنصر في index.html وإظهارها في enterApp عند is_demo', () => {
    expect(htmlSrc).toContain('id="demo-banner"');
    expect(appSrc).toContain('if (state.user?.is_demo) $("demo-banner")?.classList.remove("hidden");');
  });
  it('قلعة الإقلاع: زائر بلا مفاتيح يولّدها ويرفع مفتاحه تلقائياً — والحقيقي له الاستعادة', () => {
    expect(appSrc).toContain('if (user.is_demo) {');
    expect(appSrc).toContain('await promptRestore();');
  });
  it('مفتاحا i18n للشارة بالعربية والإنجليزية', () => {
    expect(i18nSrc).toContain('demoBanner:"حساب زائر تجريبي');
    expect(i18nSrc).toContain("demoBanner:\"Visitor demo account");
  });
  it('نمط الشارة موجود في style.css', () => {
    expect(styleSrc).toContain('.demo-banner{');
  });
});

describe('التوزيع (CI + خطة المنتَجة)', () => {
  it('workflow الاختبار الـE2E موجود ويثبّت المتصفح ويشغّل الخادم الحقيقي', () => {
    const wf = read('.github/workflows/demo-e2e.yml');
    expect(wf).toContain('playwright install');
    expect(wf).toContain('npx playwright test');
  });
  it('مواصفة E2E تغطي: الهبوط ← التجربة ← التطبيق ← إرسال رسالة حقيقية', () => {
    const spec = read('e2e/demo.spec.js');
    expect(spec).toContain('"/demo"');
    expect(spec).toContain('#try-btn');
    expect(spec).toContain('#saved-btn');
    expect(spec).toContain('#msg-input');
  });
  it('config العزل: e2e مستقل عن vitest (exclude) حتى لا يلتقطها الاختبار الوحدوي', () => {
    expect(read('vitest.config.js')).toContain("**/e2e/**");
  });
});
