// week4-contracts.test.js — عقود الأسلاك لأسبوع 4 (نفس نمط p6-contracts):
// الخادم والعميل مربوطان بعقد صريحة يفشل الاختبار فوراً لو انفصل أي طرف.
//
// 1. الخادم: جدول sessions + مسارات القائمة/الطرد خلف authRequired + فحص
//    revoked في authRequired + سحب الجلسات في logout-all وتغيير المرور +
//    RATE_MAX بيئي.
// 2. العميل: زر التصدير في الرأس + نافذتا export/devices + سكربت export.js
//    + مستمعات الأزرار + كشف التاريخ عبر ترقيم P6 + logout-all مربوط أخيراً.
// 3. الوحدة: export.js Web Crypto فقط (بلا fetch ولا شبكة) + PBKDF2 200k +
//    AES-GCM + AAD مسند.
// 4. i18n عربي/إنجليزي متكاملان لكل مفاتيح الأسبوع 4.
// 5. package.json: test:web ضمن verify (فجوة CI — session.test.mjs كانت
//    تعمل يدوياً فقط — مغلقة الآن).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const authSrc = read('server/auth.js');
const dbSrc = read('server/db.js');
const appSrc = read('web/app.js');
const htmlSrc = read('web/index.html');
const i18nSrc = read('web/i18n.js');
const exportSrc = read('web/export.js');
const pkg = JSON.parse(read('package.json'));
const cssSrc = read('web/style.css');

describe('عقد الخادم — الجلسات المرئية', () => {
  it('جدول sessions بمفاتيحه: sid مفتاح أساسي + فهرس (user_id, revoked_at)', () => {
    expect(dbSrc).toMatch(/CREATE TABLE IF NOT EXISTS sessions \(/);
    expect(dbSrc).toMatch(/id TEXT PRIMARY KEY/);
    expect(dbSrc).toMatch(/revoked_at INTEGER NOT NULL DEFAULT 0/);
    expect(dbSrc).toMatch(/CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions\(user_id, revoked_at\)/);
  });

  it('كل دخول ينشئ جلسة والتوكن يحمل sid — register وlogin معاً', () => {
    const regCount = (authSrc.match(/signToken\(user, createSession\(user\.id, device\)\)/g) || []).length;
    expect(regCount).toBe(2); // register + login
    expect(authSrc).toMatch(/claims\.sid = sid/);
  });

  it('authRequired يرفض جلسة مسحوبة أو غريبة، ويحدّث last_seen بقناع', () => {
    expect(authSrc).toMatch(/if \(!s \|\| s\.user_id !== user\.id \|\| s\.revoked_at > 0\) return res\.status\(401\)/);
    expect(authSrc).toMatch(/s\.last_seen < Date\.now\(\) - LAST_SEEN_MASK_MS/);
    // التوكن بلا sid يتخطى الفحص (توافق رجعي) — الشرط نفسه
    expect(authSrc).toMatch(/if \(p\.sid\) \{/);
  });

  it('مسارا القائمة والطرد خلف authRequired والطرد يملك مالكه فقط', () => {
    expect(authSrc).toMatch(/router\.get\("\/sessions", authRequired/);
    expect(authSrc).toMatch(/router\.delete\("\/sessions\/:sid", authRequired/);
    expect(authSrc).toMatch(/\|\| row\.user_id !== req\.user\.id/);
    expect(authSrc).toMatch(/\^\[a-f0-9]\{48}\$/);
  });

  it('logout-all وتغيير المرور يسحبان كل الجلسات معاً', () => {
    expect(authSrc).toMatch(/revokeAllSessions/);
    const count = (authSrc.match(/revokeAllSessions\(req\.user\.id\)/g) || []).length;
    expect(count).toBe(2); // logout-all + change-password (خارج تعريف الدالة)
  });

  it('RATE_MAX بيئي — السقف قابل للرفع بلا تعديل كود', () => {
    expect(authSrc).toMatch(/process\.env\.RATE_MAX/);
    expect(authSrc).toMatch(/r\.c <= RATE_MAX/);
  });
});

describe('عقد العميل — التصدير المشفّر والجلسات', () => {
  it('الأزرار والنوافذ موجودة في index.html ومخفية افتراضياً حيث يلزم', () => {
    expect(htmlSrc).toMatch(/id="export-btn" class="icon hidden"/);
    expect(htmlSrc).toMatch(/id="devices-btn"/);
    expect(htmlSrc).toMatch(/id="devices-modal" class="modal hidden"/);
    expect(htmlSrc).toMatch(/id="export-modal" class="modal hidden"/);
    expect(htmlSrc).toMatch(/id="export-pass" type="password"/);
    expect(htmlSrc).toMatch(/id="export-pass2" type="password"/);
    expect(htmlSrc).toMatch(/id="logout-all-btn"/);
  });

  it('export.js محمّل في index.html قبل app.js', () => {
    const ex = htmlSrc.indexOf('<script src="/export.js">');
    const app = htmlSrc.indexOf('<script src="/app.js">');
    expect(ex).toBeGreaterThan(-1);
    expect(app).toBeGreaterThan(ex);
  });

  it('app.js: التصدير يكشف التاريخ عبر ترقيم P6 وفكّ محلي بنفس مسار العرض', () => {
    expect(appSrc).toMatch(/\$\("export-btn"\)\?\.addEventListener/);
    expect(appSrc).toMatch(/\$\("devices-btn"\)\?\.addEventListener/);
    expect(appSrc).toMatch(/\$\("logout-all-btn"\)\?\.addEventListener/);
    expect(appSrc).toMatch(/async function gatherHistory/);
    expect(appSrc).toMatch(/\?before=\$\{before\}&limit=100/);
    expect(appSrc).toMatch(/RasanExport\.buildArchive/);
    expect(appSrc).toMatch(/RasanExport\.encryptArchive/);
    expect(appSrc).toMatch(/RasanExport\.downloadContainer/);
    // فكّ الرسائل عبر decryptMessage نفسه — لا مسار فكّ موازٍ
    expect(appSrc).toMatch(/const text = await decryptMessage\(m\);/);
    // عقد الخصوصية الحقيقي: مرحلة «بناء → شفير → تنزيل» بلا أي نداء شبكة —
    // الأرشيف وعبارة المرور لا يعبران الشبكة إطلاقاً (gatherHistory تجلب
    // ciphertext فقط كما في العرض العادي — مسار جلب معتمد منذ P6)
    const from = appSrc.indexOf('RasanExport.buildArchive');
    const to = appSrc.indexOf('RasanExport.downloadContainer');
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    expect(appSrc.slice(from, to)).not.toMatch(/api\(/);
  });

  it('تصدير متاح لكل أنواع المحادثات عند الفتح — والقائمة تحمل current', () => {
    expect(appSrc).toMatch(/\$\("export-btn"\)\.classList\.remove\("hidden"\)/);
    expect(appSrc).toMatch(/s\.current \? " — " \+ t\("deviceCurrent"\)/);
  });

  it('logout-all مربوط أخيراً في الواجهة — فجوة P6 مغلقة', () => {
    expect(appSrc).toMatch(/\/api\/auth\/logout-all/);
  });

  it('أنماط CSS للقائمة والأزرار موجودة', () => {
    expect(cssSrc).toMatch(/\.device-row/);
    expect(cssSrc).toMatch(/\.btn-danger/);
    expect(cssSrc).toMatch(/\.export-status/);
  });
});

describe('عقد الوحدة — export.js Web Crypto فقط', () => {
  it('بلا شبكة ولا خادم: لا fetch ولا XMLHttpRequest ولا WebSocket', () => {
    expect(exportSrc).not.toMatch(/fetch\(|XMLHttpRequest|WebSocket|io\(/);
  });

  it('الأقرار التشفيري مسند: PBKDF2-SHA256 200k + AES-256-GCM + AAD + tag 128', () => {
    expect(exportSrc).toMatch(/DEFAULT_ITERATIONS = 200000/);
    expect(exportSrc).toMatch(/"PBKDF2"/);
    expect(exportSrc).toMatch(/hash: "SHA-256"/);
    expect(exportSrc).toMatch(/"AES-GCM"/);
    expect(exportSrc).toMatch(/length: 256/);
    expect(exportSrc).toMatch(/additionalData: enc\.encode\(AAD\)/);
    expect(exportSrc).toMatch(/tagLength: 128/);
  });

  it('الحاوية مسندة إصداراً: format راسن + v:1 + رفض iterations أقل من الثابت', () => {
    expect(exportSrc).toMatch(/format: "rasan-export"/);
    expect(exportSrc).toMatch(/v: 1/);
    expect(exportSrc).toMatch(/iterations < DEFAULT_ITERATIONS/);
  });

  it('8 محارف أدنى لعبارة المرور — لا مفتاح من كلمة قصيرة', () => {
    expect(exportSrc).toMatch(/pass\.length < 8/);
  });
});

describe('عقد i18n — مفاتيح الأسبوع 4 متكاملة عربي/إنجليزي', () => {
  const KEYS = ['devicesTitle', 'devicesHint', 'devicesClose', 'logoutAllBtn', 'deviceCurrent',
    'deviceLastSeen', 'deviceKick', 'devicesFailed', 'devicesEmpty',
    'exportTitle', 'exportHint', 'exportGo', 'exportCancel', 'exportPassPh', 'exportPass2Ph',
    'exportPassMismatch', 'exportShortPass', 'exportCollecting', 'exportDone', 'exportFailed'];

  it('كل مفتاح في ar وen معاً — t() لا يقع على fallback للمفاتيح الجديدة', () => {
    for (const k of KEYS) {
      expect(i18nSrc).toMatch(new RegExp(`${k}:"[^"]+"`));
      expect((i18nSrc.match(new RegExp(`${k}:`, 'g')) || []).length).toBeGreaterThanOrEqual(2);
    }
  });

  it('النوافذ تستخدم data-i18n للمفاتيح الثابتة — لا نصوص عربية مقحلة في الوضع الإنجليزي', () => {
    for (const key of ['devicesTitle', 'devicesHint', 'devicesClose', 'logoutAllBtn',
      'exportTitle', 'exportHint', 'exportGo', 'exportCancel']) {
      expect(htmlSrc).toMatch(new RegExp(`data-i18n="${key}"`));
    }
  });
});

describe('عقد CI — وحدات الويب داخل verify (فجوة مغلقة)', () => {
  it('test:web موجود وchain verify يشمله', () => {
    expect(pkg.scripts['test:web']).toMatch(/node --test/);
    expect(pkg.scripts.verify).toContain('npm run test:web');
  });

  it('vitest لا يلتقط web/*.test.mjs (تُستبعد كلها — نمط node:test في test:web)', () => {
    expect(read('vitest.config.js')).toMatch(/\*\*\/web\/\*\.test\.mjs/);
  });
});
