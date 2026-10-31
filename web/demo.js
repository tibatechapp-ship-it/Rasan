// demo.js — صفحة التجربة العامة (P7 — أسبوع 2 من خارطة المنتَجة)
//
// «افتح، جرّب، امسح»: نقرة واحدة تولّد مفاتيح الزائر محلياً (WebCrypto —
// الخاصة لا تغادر الجهاز أبداً)، تطلب جلسة من الخادم، ثم تحوّل إلى التطبيق
// بنفس مفتاح الجلسة الذي يقرؤه app.js (rasan_token).
//
// حماية الحسابات الحقيقية على نفس المتصفح: إن كان هناك حساب دائم مسجّل هنا
// تُحفظ مفاتيحه في IndexedDB تحت «myKeypair_prev» قبل أي تجربة — لولاها
// لتعمّدت التجربة على مفاتيح حساب حقيقي. مسار الاستعادة الرسمي يبقى رمز
// الاستعادة (key-backup) كما هو — هذه شبكة أمان إضافية بلا واجهة.
(function () {
  "use strict";

  // ===== i18n مصغّر للصفحة — مستقل عن التطبيق (لا بناء، ملف واحد) =====
  var T = {
    ar: {
      dir: "rtl", langSwitch: "English",
      title: "رسن — جرّبها الآن بلا تسجيل",
      wipePromise: "🧹 بيانات الزوار تُمسح تلقائياً — لا شيء يبقى",
      heroTitle: "دردشة <em>مشفّرة طرف-لطرف</em><br />بلا رقم هاتف وبلا تسجيل",
      heroSub: "رسن منصة مراسلة مفتوحة المصدر: تشفير حقيقي، مكالمات صوتية وجماعية، وعمل بلا إنترنت عبر الشبكة المحلية. جرّبها الآن بحساب زائر مؤقت — نقرة واحدة.",
      tryNow: "🚀 جرّب الآن — بلا تسجيل",
      step1T: "افتح", step1P: "بلا رقم، بلا بريد، بلا كلمة مرور — نقرة واحدة تولّد مفاتيحك على جهازك أنت فقط.",
      step2T: "جرّب", step2P: "دردشة ومكالمات واستطلاعات وستوريات — كل شيء مشفّر فعلياً كما في الحساب الدائم.",
      step3T: "امسح", step3P: "بيانات الزوار تُمحى تلقائياً كل 6 ساعات وعند كل إقلاع للخادم — لا شيء يبقى لك ولا علينا.",
      f1T: "تشفير طرف-لطرف حقيقي", f1P: "ECDH + AES-GCM: الرسائل تُشفَّر وتُفك على الجهازين فقط — الخادم ينقل عتمة.",
      f2T: "بلا رقم هاتف", f2P: "اسم مستخدم فقط — لا دفتر عناوين ولا هوية هاتفية تُربط بك (نمط Session).",
      f3T: "تعمل بلا إنترنت", f3P: "«صلة»: شبكة محلية بين الأجهزة + دعم LoRa — الميزة التي لا يملكها Signal ولا WhatsApp.",
      f4T: "مكالمات ثنائية وجماعية", f4P: "صوت مشفّر حتى 8 مشاركين + وضع للّكة (PTT) للفرق الميدانية.",
      f5T: "عربية أولاً", f5P: "واجهة من اليمين لليسار من الجذر + 12 لغة — لا ترجمة لاحقة.",
      f6T: "إشراف كامل وخادم خفيف", f6P: "حظر وأدوار وتثبيت، وخادم بملف واحد (Node + SQLite) يُنشر بأمر واحد.",
      footCta: "أعجبتك؟ أنشئ حسابك الدائم في دقيقة:", footLink: "إنشاء حساب دائم ←", footOs: "مشروع مفتوح المصدر",
      starting: "جارٍ تجهيز مفاتيحك وجلسة الزائر...", disabled: "التجربة معطلة على هذا الخادم حالياً.",
      failed: "تعذر بدء الجلسة — أعد المحاولة: "
    },
    en: {
      dir: "ltr", langSwitch: "العربية",
      title: "Rasan — try it now, no sign-up",
      wipePromise: "🧹 Visitor data is wiped automatically — nothing stays",
      heroTitle: "End-to-end <em>encrypted messaging</em><br />no phone number, no sign-up",
      heroSub: "Rasan is an open-source messenger: real E2EE, voice & group calls, and offline operation over local mesh. Try it now with a temporary visitor account — one click.",
      tryNow: "🚀 Try now — no sign-up",
      step1T: "Open", step1P: "No number, no email, no password — one click generates your keys on your device only.",
      step2T: "Try", step2P: "Chat, calls, polls, stories — everything truly encrypted, same as a permanent account.",
      step3T: "Wipe", step3P: "Visitor data is erased every 6 hours and on every server restart — nothing stays with you or us.",
      f1T: "Real end-to-end encryption", f1P: "ECDH + AES-GCM: messages encrypt/decrypt on the two devices only — the server moves ciphertext.",
      f2T: "No phone number", f2P: "A username is all — no address book, no phone identity attached to you (Session-style).",
      f3T: "Works offline", f3P: "Sila: device-to-device local mesh + LoRa support — the feature Signal and WhatsApp lack.",
      f4T: "1:1 & group calls", f4P: "Encrypted voice up to 8 participants + push-to-talk for field teams.",
      f5T: "Arabic first", f5P: "Native RTL interface + 12 languages — not an afterthought translation.",
      f6T: "Full moderation, light server", f6P: "Bans, roles, pinning — and a single-file server (Node + SQLite) deployable in one command.",
      footCta: "Liked it? Create your permanent account in a minute:", footLink: "Create a permanent account ←", footOs: "Open-source project",
      starting: "Preparing your keys and visitor session...", disabled: "Demo is disabled on this server right now.",
      failed: "Could not start a session — try again: "
    }
  };

  var locale = localStorage.getItem("rasan_locale") === "en" ? "en" : "ar";

  function t(k) { return (T[locale] && T[locale][k]) || T.ar[k] || k; }

  function applyI18n() {
    var d = T[locale];
    document.documentElement.lang = locale;
    document.documentElement.dir = d.dir;
    document.title = d.title;
    document.querySelectorAll("[data-i18n]").forEach(function (el) { el.textContent = d[el.getAttribute("data-i18n")] || el.textContent; });
    document.querySelectorAll("[data-i18n-html]").forEach(function (el) { el.innerHTML = d[el.getAttribute("data-i18n-html")] || el.innerHTML; });
    document.getElementById("lang-btn").textContent = d.langSwitch;
  }

  document.getElementById("lang-btn").addEventListener("click", function () {
    locale = locale === "ar" ? "en" : "ar";
    localStorage.setItem("rasan_locale", locale);
    applyI18n();
  });

  // ===== IndexedDB نفس مخزن التطبيق («rasan» / kv) بلا أي اعتمادية =====
  function idbPut(key, val) {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open("rasan", 1);
      req.onupgradeneeded = function () { req.result.createObjectStore("kv"); };
      req.onerror = function () { reject(req.error); };
      req.onsuccess = function () {
        var tx = req.result.transaction("kv", "readwrite");
        tx.objectStore("kv").put(val, key);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      };
    });
  }
  function idbGet(key) {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open("rasan", 1);
      req.onupgradeneeded = function () { req.result.createObjectStore("kv"); };
      req.onerror = function () { reject(req.error); };
      req.onsuccess = function () {
        var tx = req.result.transaction("kv", "readonly");
        var r = tx.objectStore("kv").get(key);
        tx.oncomplete = function () { resolve(r.result); };
        tx.onerror = function () { reject(tx.error); };
      };
    });
  }

  var note = document.getElementById("try-note");
  var btn = document.getElementById("try-btn");
  function say(msg, isErr) {
    note.textContent = msg || "";
    note.classList.toggle("try-err", !!isErr);
  }

  // ===== حماية الحساب الحقيقي: إن كان في المتصفح توكن حساب دائم فمفاتيحه
  // تُحفظ احتياطاً في «myKeypair_prev» قبل أي تجربة، ثم يُمسح التوكن لتبدأ
  // التجربة نظيفة. جلسة زائر سابقة (is_demo) تُمسح بلا حفظ — مفاتيحها ذاتية.
  (async function guardRealAccount() {
    var token = localStorage.getItem("rasan_token");
    if (!token) return;
    try {
      var res = await fetch("/api/auth/me", { headers: { Authorization: "Bearer " + token } });
      if (res.ok) {
        var user = (await res.json()).user;
        if (!user.is_demo) {
          var prev = await idbGet("myKeypair");
          if (prev && !(await idbGet("myKeypair_prev"))) await idbPut("myKeypair_prev", prev);
        }
      }
    } catch (e) { /* الخادم غير متاح — نكمل بلا حفظ، لا ضرر */ }
    localStorage.removeItem("rasan_token");
  })();

  // ===== حالة التجربة: إن عُطّلت خادمياً يختفي الزر بدل الوفشل بصمت =====
  (async function checkStatus() {
    try {
      var s = await (await fetch("/api/demo/status")).json();
      if (!s.enabled) { btn.disabled = true; say(t("disabled")); }
    } catch (e) { /* الخادم سيحدد عند النقر على أي حال */ }
  })();

  btn.addEventListener("click", async function () {
    btn.disabled = true;
    say(t("starting"));
    try {
      // المفاتيح تولد محلياً أولاً — الخاصة لا تُرسل لأحد أبداً
      var kp = await RasanCrypto.genKeypair();
      await idbPut("myKeypair", kp);
      var res = await fetch("/api/demo/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ publicKey: kp.publicKey })
      });
      if (!res.ok) {
        var err = await res.json().catch(function () { return {}; });
        throw new Error(err.error || ("HTTP " + res.status));
      }
      var data = await res.json();
      localStorage.setItem("rasan_token", data.token);
      localStorage.setItem("rasan_locale", locale);
      // زائر يعرف أنه زائر: شارة في التطبيق + وعده بالمسح الدوري
      sessionStorage.setItem("rasan_demo_since", String(Date.now()));
      location.href = "/";
    } catch (e) {
      say(t("failed") + e.message, true);
      btn.disabled = false;
    }
  });

  applyI18n();
})();
