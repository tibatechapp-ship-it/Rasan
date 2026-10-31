import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // sila/ عقدة مستقلة باختبارات node:test خاصة بها — وظيفة CI منفصلة.
    // e2e/ حزمة Playwright معزولة عن الجذر (أسبوع 2) — وظيفة CI منفصلة أيضاً.
    exclude: ['**/web/session.test.mjs', '**/node_modules/**', '**/sila/**', '**/e2e/**'],
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.js'],
  }
});
