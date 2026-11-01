import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // sila/ عقدة مستقلة باختبارات node:test خاصة بها — وظيفة CI منفصلة.
    // e2e/ حزمة Playwright معزولة عن الجذر (أسبوع 2) — وظيفة CI منفصلة أيضاً.
    // web/*.test.mjs وحدات ويب بنمط node:test — تُشغَّل عبر test:web (أسبوع 4
    // أغلق فجوة: كانت session.test.mjs تعمل يدوياً فقط).
    exclude: ['**/web/*.test.mjs', '**/node_modules/**', '**/sila/**', '**/e2e/**'],
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.js'],
  }
});
