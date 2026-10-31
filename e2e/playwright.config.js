// playwright.config.js — E2E صفحة التجربة (أسبوع 2 من خارطة المنتَجة)
//
// مبدأ الخطة: «لا معلم بلا تحقق آلي» — هذا الملف يشغّل الخادم الحقيقي
// (server/server.js) بقاعدة بيانات مؤقتة معزولة، ثم يجري رحلة الزائر كاملة
// في متصفح Chromium حقيقي: هبوط /demo ← جلسة زائر ← دخول التطبيق ← إرسال
// رسالة مشفرة فعلاً. لا محاكاة ولا stubs — نفس ما يفعله زائر حقيقي.
const { defineConfig } = require("@playwright/test");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const PORT = 3111;

module.exports = defineConfig({
  testDir: ".",
  timeout: 90 * 1000,
  expect: { timeout: 20 * 1000 },
  fullyParallel: false, // قاعدة بيانات واحدة — الرحلة متسلسلة بوعي
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "line" : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    locale: "ar",
    viewport: { width: 480, height: 860 }, // نافذة هاتف — الصفحة والتطبيق موبايل-أولاً
    actionTimeout: 15 * 1000,
  },
  webServer: {
    command: "node server/server.js",
    url: `http://localhost:${PORT}/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 30 * 1000,
    cwd: join(__dirname, ".."),
    env: {
      PORT: String(PORT),
      JWT_SECRET: "e2e-demo-secret",
      DATA_DIR: mkdtempSync(join(tmpdir(), "rasan-e2e-")), // قاعدة نظيفة لكل تشغيل
    },
  },
});
