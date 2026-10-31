// shot.js — لقطات تحقق بصري لصفحة التجربة والتطبيق (تُحفظ في /tmp/render)
const { chromium } = require("@playwright/test");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

(async () => {
  const { execSync, spawn } = require("node:child_process");
  const PORT = 3122;
  const dataDir = mkdtempSync(join(tmpdir(), "rasan-shot-"));
  const srv = spawn("node", ["server/server.js"], {
    cwd: join(__dirname, ".."),
    env: { ...process.env, PORT: String(PORT), JWT_SECRET: "shot-secret", DATA_DIR: dataDir },
    stdio: "ignore",
  });
  // انتظر /health
  for (let i = 0; i < 40; i++) {
    try { execSync(`curl -sf http://localhost:${PORT}/health >/dev/null`); break; } catch { await new Promise(r => setTimeout(r, 250)); }
  }
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 480, height: 860 }, locale: "ar" });

  await page.goto(`http://localhost:${PORT}/demo`);
  await page.waitForTimeout(600);
  await page.screenshot({ path: "/tmp/render/demo-ar.png", fullPage: true });

  await page.click("#lang-btn");
  await page.waitForTimeout(300);
  await page.screenshot({ path: "/tmp/render/demo-en.png", fullPage: true });

  // الجلسة ← التطبيق ← المحفوظات برسالة
  await page.click("#lang-btn"); // رجوع للعربية
  await page.click("#try-btn");
  await page.waitForURL((u) => u.pathname === "/", { timeout: 30000 });
  await page.waitForSelector("#app", { timeout: 30000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: "/tmp/render/app-banner.png" });
  await page.click("#saved-btn");
  await page.waitForSelector("#chat:not(.hidden)", { timeout: 30000 });
  await page.fill("#msg-input", "مرحباً — رسالة مشفرة من زائر");
  await page.click("#send-btn");
  await page.waitForTimeout(1200);
  await page.screenshot({ path: "/tmp/render/app-saved-msg.png" });

  await browser.close();
  srv.kill();
  console.log("shots done");
})().catch((e) => { console.error(e); process.exit(1); });
