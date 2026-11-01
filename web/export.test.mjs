// export.test.mjs — اختبارات وحدة التصدير المشفّر ذاتياً (أسبوع 4)
// node --test web/ — Web Crypto الحقيقي (globalThis.crypto في Node 20+)
//
// الضمانات:
// 1. بناء الأرشيف: شكل صريح (app/export_version/messages) بلا حقول خادمية زائدة.
// 2. دورة كاملة شفّر→فك: النص العربي/الإيموجي/الرسائل الطويلة تخرج كما دخلت.
// 3. عبارة خاطئة أو ملف معدَّل يُفشل الفك (GCM tag) — لا صمت ولا بيانات فاسدة.
// 4. الحاوية مسندة: format/v/kdf/cipher/AAD — رفض أي انحراف.
// 5. عبارة المرور لا تظهر في مخرجات الحاوية إطلاقاً (لا شفرة عبثية تحملها).
// 6. اسم الملف آمن ومعرّف الصيغة الزمني صحيح.

import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.window = globalThis;
globalThis.document = globalThis.document || { createElement: () => ({ click() {}, remove() {}, set href(v) {} }), body: { appendChild() {} } };
globalThis.Blob = globalThis.Blob || class {};
globalThis.URL = globalThis.URL || { createObjectURL: () => "blob:x", revokeObjectURL: () => {} };
await import('./export.js');
const X = globalThis.RasanExport;

const MSGS = [
  { id: 1, senderId: 7, senderName: "أمين", time: 1700000000000, type: "text", text: "مرحباً بالعالم — سلامٌ لا ينقطع ✌️", replyTo: null },
  { id: 2, senderId: 9, senderName: "ريم", time: 1700000060000, type: "text", text: "وفيكم — جرّبنا التشفير وأحسناها".repeat(200), edited: true, replyTo: 1 },
  { id: 3, senderId: 7, senderName: "أمين", time: 1700000120000, type: "location", text: "📍 24.7136, 46.6753", replyTo: null },
];

test("buildArchive يعيد شكلاً صريحاً بلا تسريب حقول خادمية", () => {
  const a = X.buildArchive({ conversation: { id: 12, title: "فريق رسن", type: "group" }, me: { id: 7, username: "amin" }, messages: MSGS });
  assert.equal(a.app, "rasan");
  assert.equal(a.export_version, 1);
  assert.equal(a.message_count, 3);
  assert.deepEqual(a.conversation, { id: 12, title: "فريق رسن", type: "group" });
  assert.deepEqual(a.exported_by, { id: 7, username: "amin" });
  assert.equal(a.messages[1].edited, true);
  assert.equal(a.messages[0].text.includes("سلامٌ"), true);
  // لا حقول ciphertext/iv داخل الأرشيف — النص المفكوك فقط (الملف للقارئ البشري)
  assert.equal("ciphertext" in a.messages[0], false);
  assert.equal("iv" in a.messages[0], false);
});

test("دورة كاملة: شفّر ثم فك بنفس العبارة يطابق الأصل حرفياً", async () => {
  const a = X.buildArchive({ conversation: { id: 1, title: "خاص", type: "dm" }, me: { id: 7, username: "amin" }, messages: MSGS });
  const snap = JSON.parse(JSON.stringify(a));
  const c = await X.encryptArchive(a, "عبارة سرية 1234");
  const back = await X.decryptArchive(c, "عبارة سرية 1234");
  assert.deepEqual(back, snap); // حتى الرموز الزخرفية والترتيب كما هي
});

test("عبارة خاطئة تُفشل الفك ولا تُرجع بيانات فاسدة", async () => {
  const a = X.buildArchive({ conversation: { id: 1, title: "", type: "dm" }, me: null, messages: MSGS });
  const c = await X.encryptArchive(a, "correct-horse-battery");
  await assert.rejects(() => X.decryptArchive(c, "wrong-passphrase-x"), /wrong_passphrase|corrupted/);
});

test("عبث بايت واحد في ciphertext يُفشل الفك (GCM tag)", async () => {
  const a = X.buildArchive({ conversation: { id: 1, title: "", type: "dm" }, me: null, messages: MSGS.slice(0, 1) });
  const c = await X.encryptArchive(a, "passphrase-2026");
  const raw = Buffer.from(c.ciphertext, "base64");
  raw[raw.length - 1] ^= 0x01; // آخر بايت = داخل الـ tag
  const tampered = { ...c, ciphertext: raw.toString("base64") };
  await assert.rejects(() => X.decryptArchive(tampered, "passphrase-2026"), /wrong_passphrase|corrupted/);
});

test("الحاوية مسندة: format/v/AAD/خوارزميات خاطئة تُرفض قبل أي فك", async () => {
  const a = X.buildArchive({ conversation: { id: 1, title: "", type: "dm" }, me: null, messages: MSGS.slice(0, 1) });
  const c = await X.encryptArchive(a, "passphrase-2026");
  await assert.rejects(() => X.decryptArchive({ ...c, format: "other-export" }, "passphrase-2026"), /bad_container/);
  await assert.rejects(() => X.decryptArchive({ ...c, v: 2 }, "passphrase-2026"), /bad_container/);
  await assert.rejects(() => X.decryptArchive({ ...c, cipher: { ...c.cipher, aad: "evil:v1" } }, "passphrase-2026"), /bad_container/);
  await assert.rejects(() => X.decryptArchive({ ...c, kdf: { ...c.kdf, iterations: 1000 } }, "passphrase-2026"), /bad_container/);
  await assert.rejects(() => X.decryptArchive(null, "passphrase-2026"), /bad_container/);
});

test("عبارة قصيرة تُرفض عند الشفير والفك — لا مفتاح ضعيف يولد", async () => {
  const a = X.buildArchive({ conversation: { id: 1, title: "", type: "dm" }, me: null, messages: [] });
  await assert.rejects(() => X.encryptArchive(a, "1234567"), /passphrase_too_short/);
  await assert.rejects(() => X.decryptArchive({ format: "rasan-export", v: 1 }, "قصيرة"), /passphrase_too_short/);
});

test("عبارة المرور لا توجد في نص الحاوية إطلاقاً", async () => {
  const pass = "كلمة-سرية-فريدة-2026";
  const a = X.buildArchive({ conversation: { id: 1, title: "", type: "dm" }, me: null, messages: MSGS.slice(0, 1) });
  const text = X.containerToText(await X.encryptArchive(a, pass));
  assert.equal(text.includes(pass), false, "الحاوية لا تحمل العبارة");
  assert.equal(text.includes("rasan-export"), true);
  assert.equal(JSON.parse(text).ciphertext.length > 100, true);
});

test("salt وiv عشوائيان لكل تصدير — نفس المدخلات لا يعيد المخرجات", async () => {
  const a = X.buildArchive({ conversation: { id: 1, title: "", type: "dm" }, me: null, messages: MSGS.slice(0, 1) });
  const c1 = await X.encryptArchive(a, "same-passphrase");
  const c2 = await X.encryptArchive(a, "same-passphrase");
  assert.notEqual(c1.kdf.salt, c2.kdf.salt, "الملح جديد لكل تصدير");
  assert.notEqual(c1.cipher.iv, c2.cipher.iv, "الـ IV جديد لكل تصدير");
  assert.notEqual(c1.ciphertext, c2.ciphertext);
  // وكلاهما يُفك بالعبارة نفسها
  assert.equal((await X.decryptArchive(c1, "same-passphrase")).message_count, 1);
  assert.equal((await X.decryptArchive(c2, "same-passphrase")).message_count, 1);
});

test("exportFileName آمن وقياسي — يزيل المحارف الخطرة ويحمل طابعاً زمنياً", () => {
  const name = X.exportFileName(42, new Date(2026, 10, 1, 9, 5));
  assert.match(name, /^rasan-export-42-20261101-0905\.json$/);
  assert.equal(X.exportFileName("../evil/path", new Date(2026, 0, 1, 0, 0)), "rasan-export-evilpath-20260101-0000.json");
});
