// demo.spec.js — رحلة الزائر كاملة (E2E حقيقي — Chromium + خادم حقيقي)
//
// المعلم الآلي لأسبوع 2 من خارطة المنتَجة: «زائر يدخل بحساب demo ويرسل رسالة».
// الرحلة كما يشهدها زائر فعلي:
//   1. يفتح /demo — يرى صفحة الهبوط وزر التجربة (عربياً — RTL أصلي).
//   2. ينقر «جرّب الآن» — تولّد مفاتيحه محلياً وتُطلب جلسة من الخادم.
//   3. ينتقل للتطبيق داخل الجلسة — يرى شارة الزائر التجريبي.
//   4. يفتح «الرسائل المحفوظة» (محادثة الذات — أسهل طريق بلا طرف ثانٍ).
//   5. يكتب رسالة ويرسلها — تظهر مشفرة في الخيط (roundtrip حقيقي عبر socket).
import { test, expect } from "@playwright/test";

const VISITOR_MSG = "مرحباً من زائر صفحة التجربة";

test("رحلة الزائر: هبوط ← تجربة ← تطبيق ← رسالة مشفرة حقيقية", async ({ page }) => {
  // 1) صفحة الهبوط بالعربية أولاً
  await page.goto("/demo");
  await expect(page.locator("#try-btn")).toBeVisible();
  await expect(page.locator(".hero h1")).toContainText("مشفّرة");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");

  // 2) الجلسة: نقرة واحدة — ثم تحويل تلقائي إلى التطبيق
  await page.click("#try-btn");
  await page.waitForURL((u) => u.pathname === "/", { timeout: 30_000 });

  // 3) التطبيق داخل جلسة الزائر: الشارة ظاهرة وشاشة الدخول مخفية
  await expect(page.locator("#app")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("#demo-banner")).toBeVisible();
  await expect(page.locator("#demo-banner")).toContainText("حساب زائر تجريبي");

  // 4) محادثة الذات (رسائل محفوظة) — بلا طرف ثانٍ
  await page.click("#saved-btn");
  await expect(page.locator("#chat")).toBeVisible({ timeout: 30_000 });

  // 5) إرسال رسالة حقيقية — تُشفَّر في المتصفح وترجع عبر الخادم للخيط
  await page.fill("#msg-input", VISITOR_MSG);
  await page.click("#send-btn");
  await expect(page.locator("#messages")).toContainText(VISITOR_MSG, { timeout: 30_000 });
});

test("صفحة الهبوط تعمل بالإنجليزية أيضاً (LTR + نصوص مبدّلة)", async ({ page }) => {
  await page.goto("/demo");
  await page.click("#lang-btn");
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(page.locator(".hero h1")).toContainText("encrypted");
  await expect(page.locator("#try-btn")).toContainText("Try now");
});

test("حالة التجربة من الخادم: enabled=true ومسح موعود", async ({ request }) => {
  const res = await request.get("/api/demo/status");
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(body.enabled).toBe(true);
  expect(body.wipeAfterMs).toBeGreaterThan(60_000);
});
