// Rasan Export — تصدير محادثة مشفّر ذاتياً (أسبوع 4 — نمط الجميع، وصف المراجعة:
// «أرشيف JSON مشفر بمفتاح من كلمة مرور — معطى ناقص اليوم ومطلوب للثقة»).
//
// Web Crypto فقط، صفر اعتماديات، بلا أي خادم بعد الجلب: الأرشيف يُبنى من
// النصوص المفكوكة محلياً، يُشفّر بمفتاح مشتق من عبارة المرور (PBKDF2-SHA256
// 200k — نفس ثوابت مسح الذعر panic.js) بـ AES-256-GCM، ثم يُنزّل ملفاً
// واحدًا. الخادم لا يرى عبارة المرور ولا الأرشيف المشفر ولا شيء — هو أصلاً
// لا يرى النصوص (E2EE).
//
// صيغة الحاوية (مسندة إصداراً — إضافة مستقبلية = v2 لا كسر للقديم):
// {
//   format: "rasan-export", v: 1,
//   kdf:    { name: "PBKDF2-SHA256", iterations, salt: b64(16B) },
//   cipher: { name: "AES-256-GCM", iv: b64(12B), aad: "rasan-export:v1" },
//   ciphertext: b64(JSON.stringify(archive) UTF-8 + GCM tag)
// }
// AAD يربط الحقلين format وv بالـ ciphertext — ملف بتنسيق آخر لا يُفكّ على
// هذا المفتاح حتى لو سُرّب الاصطدام. المفتاح 256-bit، الـ IV 96-bit عشوائي
// لكل تصدير (معيار NIST لـ GCM)، والملح 128-bit عشوائي.

window.RasanExport = (() => {
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  const AAD = "rasan-export:v1";
  const DEFAULT_ITERATIONS = 200000; // نفس ثابت panic.js — لا لغزين في تطبيق واحد

  function assertPass(pass) {
    if (typeof pass !== "string" || pass.length < 8) {
      throw new Error("passphrase_too_short"); // 8 محارف أدنى — عبارة لا كلمة
    }
  }

  // مشتق مفتاح 256-bit من عبارة المرور — ملح وعدد دورات من الحاوية عند الفك
  // (الشفرة تستخدم الثابت الحالي؛ الفك يستخدم ما سجّله الملف — توافق مستقبلي)
  async function deriveKey(pass, salt, iterations = DEFAULT_ITERATIONS) {
    const base = await crypto.subtle.importKey("raw", enc.encode(pass), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", hash: "SHA-256", salt, iterations },
      base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
    );
  }

  // بناء الأرشيف من النصوص المفكوكة محلياً — كائن JSON صريح بلا حقول خادمية زائدة
  function buildArchive({ conversation, me, messages }) {
    if (!conversation || typeof conversation !== "object") throw new Error("bad_conversation");
    if (!Array.isArray(messages)) throw new Error("bad_messages");
    return {
      app: "rasan",
      export_version: 1,
      exported_at: new Date().toISOString(),
      conversation: {
        id: conversation.id ?? null,
        title: conversation.title ?? conversation.name ?? "",
        type: conversation.type ?? "dm",
      },
      exported_by: me ? { id: me.id ?? null, username: me.username ?? "" } : null,
      message_count: messages.length,
      messages: messages.map((m) => ({
        id: m.id ?? null,
        sender_id: m.senderId ?? m.sender_id ?? null,
        sender_name: m.senderName ?? m.sender_name ?? "",
        time: m.time ?? 0,
        type: m.type ?? "text",
        text: m.text ?? "",
        edited: !!(m.edited || m.edited_at),
        reply_to: m.replyTo ?? m.reply_to ?? null,
      })),
    };
  }

  // شفّر الأرشيف كاملاً — يعيد كائن الحاوية (يُنزّل JSON بعد التحول لنص)
  async function encryptArchive(archive, pass) {
    assertPass(pass);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(pass, salt);
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: enc.encode(AAD), tagLength: 128 },
      key, enc.encode(JSON.stringify(archive))
    );
    return {
      format: "rasan-export",
      v: 1,
      kdf: { name: "PBKDF2-SHA256", iterations: DEFAULT_ITERATIONS, salt: b64(salt) },
      cipher: { name: "AES-256-GCM", iv: b64(iv), aad: AAD },
      ciphertext: b64(ct),
    };
  }

  // فك الحاوية — يفشل برمي على عبارة خاطئة أو ملف عبث فيه (GCM tag)
  async function decryptArchive(container, pass) {
    assertPass(pass);
    if (!container || container.format !== "rasan-export" || container.v !== 1) {
      throw new Error("bad_container");
    }
    if (container.kdf?.name !== "PBKDF2-SHA256" || !Number.isInteger(container.kdf?.iterations)
      || container.kdf.iterations < DEFAULT_ITERATIONS || container.cipher?.name !== "AES-256-GCM"
      || container.cipher?.aad !== AAD) {
      throw new Error("bad_container");
    }
    const key = await deriveKey(pass, unb64(container.kdf.salt), container.kdf.iterations);
    let pt;
    try {
      pt = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: unb64(container.cipher.iv), additionalData: enc.encode(AAD), tagLength: 128 },
        key, unb64(container.ciphertext)
      );
    } catch {
      throw new Error("wrong_passphrase_or_corrupted");
    }
    const archive = JSON.parse(dec.decode(pt));
    if (archive?.app !== "rasan" || !Array.isArray(archive.messages)) throw new Error("bad_container");
    return archive;
  }

  // اسم ملف آمن: rasan-export-<convId>-<YYYYMMDD-HHMM>.json
  function exportFileName(convId, at = new Date()) {
    const p = (n) => String(n).padStart(2, "0");
    const stamp = `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}`;
    return `rasan-export-${String(convId ?? "x").replace(/[^a-zA-Z0-9_-]/g, "")}-${stamp}.json`;
  }

  // التحويل لنص ونزّل الملف — مسار تنزيل واحد يمر بـ Blob (بلا أي خدمة خارجية)
  function containerToText(container) { return JSON.stringify(container, null, 2); }
  function downloadContainer(container, fileName, convId) {
    const blob = new Blob([containerToText(container)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName || exportFileName(convId);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return {
    AAD, DEFAULT_ITERATIONS,
    buildArchive, encryptArchive, decryptArchive,
    exportFileName, containerToText, downloadContainer,
  };
})();
