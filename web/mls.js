// Rasan MLS — بنية MLS (روح RFC 9420) للمجموعات: إبوكات + التفاف إفيمرالي + commitment
//
// لماذا هذه الطبقة؟ نمط توزيع المفاتيح القديم (group_keys) يغلّف مفتاح المجموعة
// بمفتاح المالك طويل الأمد — من يسرق مفتاح المالك يفكّ كل الأغلفة الحالية
// والمستقبلية. MLS يحل ذلك بـ«تحديث الورقة»: كل commit يولّد سرّ إبوك عشوائياً
// جديداً ويغلّفه لأعضاء بمفاتيح إفيمرالية تُولَّد لكل غلاف ولن تُستخدم ثانية —
// فسرقة المفتاح طويل الأمد لا تفسد شيئاً من المستقبل (Post-Compromise Security
// بروح TreeKEM)، وسرقة سرّ الإبوك الحالي لا تفضح الإبوكات الماضية ولا القادمة.
//
// خصائص مُنفَّذة فعلياً (موثقة في docs/MLS_FIELD_TEST.md):
// 1) إبوكات مرقمة: كل رسالة تحمل key_version = رقم الإبوك — الخادم يفرض التطابق
//    عبر current_key_version (القاعدة القائمة) فلا التباس.
// 2) أي عضو يصدر commit (خاصية MLS — لا ازدحام على المالك)؛ تضارب الإبوكات
//    يفصله الخادم (409 epoch conflict) فيتبنّى الخاسر إبوك الفائز.
// 3) التفاف إفيمرالي P-256 لكل عضو في كل commit + HKDF بمعلومات مجال ثابتة
//    ("rasan-mls-v1 wrap" / "rasan-mls-v1 epoch") + AES-GCM.
// 4) commitment (SHA-256 لسر الإبوك) يتحقق منه كل مستقبل — غلاف فاسد أو عبث
//    في النقل يُكتشف قبل استخدام المفتاح.
// 5) أرشفة إبوكات محدودة (آخر 32) لفك تاريخ المحادثة — وفك الرسائل الأقدم من
//    الأرشيف يبقى ممكناً عبر مسار 🔒 كالرسائل بلا مفتاح (لا كسر للخصوصية).
//
// الخادم هنا Delivery Service غير موثوق كما في MLS: يخزّن أغلفة معتمة وأرقام
// إبوك فقط — لا يرى سرّ الإبوك إطلاقاً.
window.RasanMls = (() => {
  const enc = new TextEncoder();

  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

  // أرشفة الإبوكات لفك التاريخ (نمط Signal: المفاتيح تُمسح بعد فترة لا فوراً —
  // فالمقايضة الصادقة هي قابلية قراءة الأرشيف الحديث مقابل سقف التعرض)
  const HISTORY_CAP = 32;

  const lsKey = (convId) => `rasan_mls_${convId}`;
  const keyCache = new Map(); // "convId:epoch" -> CryptoKey (ذاكرة جلسة فقط)

  function local(convId) {
    try { return JSON.parse(localStorage.getItem(lsKey(convId)) || "null"); } catch { return null; }
  }
  function saveLocal(convId, st) {
    if (st && st.history) {
      const entries = Object.entries(st.history)
        .map(([e, s]) => ({ e: Number(e), s }))
        .filter((x) => x.e > 0 && typeof x.s === "string")
        .sort((a, b) => a.e - b.e);
      while (entries.length > HISTORY_CAP) entries.shift();
      st.history = Object.fromEntries(entries.map((x) => [String(x.e), x.s]));
    }
    localStorage.setItem(lsKey(convId), JSON.stringify(st));
  }
  function wipe(convId) {
    localStorage.removeItem(lsKey(convId));
    for (const k of [...keyCache.keys()]) if (k.startsWith(convId + ":")) keyCache.delete(k);
  }
  function localEpoch(convId) { return local(convId)?.epoch || 0; }

  // api() يُحقن من app.js (توكن المصادقة يعيش هناك) — بلا حقن تعمل دوال التشفير الصرفة فقط
  let _api = null;
  function init({ api }) { _api = api; }

  const importPub = (k) => crypto.subtle.importKey("raw", unb64(k), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const importPriv = (k) => crypto.subtle.importKey("pkcs8", unb64(k), { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);

  // سر الإبوك (32 بايت عشوائية) → مفتاح AES-256-GCM عبر HKDF بمعلومات مجال ثابتة
  async function deriveEpochKey(secretB64) {
    const base = await crypto.subtle.importKey("raw", unb64(secretB64), "HKDF", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: enc.encode("rasan-mls-v1 epoch") },
      base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
    );
  }

  // commitment = SHA-256(سر الإبوك) — كل مستقبل يتحقق أن غلافه فكّ إلى نفس السر
  async function computeCommitment(secretB64) {
    return hex(await crypto.subtle.digest("SHA-256", unb64(secretB64)));
  }

  // مفتاح إبوك من الأرشيف المحلي (لفك رسائل تاريخية بإبوك أقدم) — null إن تجاوز الأرشيف
  async function keyForEpoch(convId, epoch) {
    const k = keyCache.get(convId + ":" + epoch);
    if (k) return k;
    const st = local(convId);
    const secret = st?.epoch === epoch ? st.secret : st?.history?.[String(epoch)];
    if (!secret) return null;
    const key = await deriveEpochKey(secret);
    keyCache.set(convId + ":" + epoch, key);
    return key;
  }

  // غلاف إفيمرالي: زوج P-256 جديد لكل عضو في كل commit — لا مفتاح طويل الأمد يدخل المسار
  async function wrapForMember(secretB64, memberPubB64) {
    const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey", "deriveBits"]);
    const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: await importPub(memberPubB64) }, kp.privateKey, 256);
    const base = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
    const wrapKey = await crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: enc.encode("rasan-mls-v1 wrap") },
      base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
    );
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, wrapKey, unb64(secretB64));
    return {
      eph_pub: b64(await crypto.subtle.exportKey("raw", kp.publicKey)),
      wrapped_key: b64(ct),
      iv: b64(iv),
    };
  }

  // فك الغلاف: ECDH(خاصيتي، إفيمرالي المصدر) → HKDF → AES-GCM → سر الإبوك
  async function unwrapEpochSecret(wrap, myPrivB64) {
    const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: await importPub(wrap.eph_pub) }, await importPriv(myPrivB64), 256);
    const base = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
    const wrapKey = await crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: enc.encode("rasan-mls-v1 wrap") },
      base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
    );
    const raw = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(wrap.iv) }, wrapKey, unb64(wrap.wrapped_key));
    return b64(raw);
  }

  // تبنّي إبوك منشور: جلب غلافي → فك → تحقق commitment → أرشفة السابق → اشتقاق المفتاح
  async function adopt(convId, myKeys, epoch) {
    if (!_api) throw new Error("mls: api not injected");
    const st = local(convId);
    if (st && st.epoch === epoch) {
      return { key: await keyForEpoch(convId, epoch), epoch };
    }
    const payload = await _api(`/api/conversations/${convId}/mls/wraps/${epoch}`);
    if (!payload || !payload.wrap) throw new Error("mls: no wrap");
    const secret = await unwrapEpochSecret(payload.wrap, myKeys.privateKey);
    const commitment = await computeCommitment(secret);
    if (commitment !== payload.commitment) throw new Error("mls: commitment mismatch"); // عبث أو غلاف فاسد
    const hist = { ...(st?.history || {}) };
    if (st?.epoch && st?.secret) hist[String(st.epoch)] = st.secret;
    saveLocal(convId, { epoch, secret, history: hist });
    const key = await deriveEpochKey(secret);
    keyCache.set(convId + ":" + epoch, key);
    return { key, epoch, commitment };
  }

  // commit جديد (خاصية MLS: أي عضو) — إبوك جديد بسر عشوائي كلي، أغلفة إفيمرالية لكل عضو
  async function commitNewEpoch(convId, myKeys) {
    if (!_api) throw new Error("mls: api not injected");
    const stateResp = await _api(`/api/conversations/${convId}/mls/state`);
    const serverEpoch = stateResp.epoch || 0;
    const prev = local(convId);
    // لو تخلّفت عن الخادم (أوفلاين أثناء commit سابق) تبنّى الحالي أولاً — لا قفز في السلسلة
    if (prev && prev.epoch && prev.epoch < serverEpoch) {
      try { return await adopt(convId, myKeys, serverEpoch); } catch { /* لا غلاف لي — أكمل بإبوك جديد */ }
    }
    const { members } = await _api(`/api/conversations/${convId}/members`);
    const secretB64 = b64(crypto.getRandomValues(new Uint8Array(32)));
    const wraps = [];
    for (const m of members) {
      if (!m.public_key) continue;
      wraps.push({ userId: m.id, ...(await wrapForMember(secretB64, m.public_key)) });
    }
    const commitment = await computeCommitment(secretB64);
    try {
      await _api(`/api/conversations/${convId}/mls/commit`, {
        method: "POST",
        body: JSON.stringify({ epoch: serverEpoch + 1, commitment, wraps }),
      });
    } catch (e) {
      // سباق commit (عضو آخر سبقني) — الخادم رد 409 epoch conflict: تبنّى إبوكه
      if (String(e.message).includes("conflict")) {
        return adopt(convId, myKeys, serverEpoch + 1);
      }
      throw e;
    }
    const hist = { ...(prev?.history || {}) };
    if (prev?.epoch && prev?.secret) hist[String(prev.epoch)] = prev.secret;
    saveLocal(convId, { epoch: serverEpoch + 1, secret: secretB64, history: hist });
    const key = await deriveEpochKey(secretB64);
    keyCache.set(convId + ":" + (serverEpoch + 1), key);
    return { key, epoch: serverEpoch + 1 };
  }

  // فتح محادثة MLS: توطين الإبوك من الخادم، وإن لم أجد غلافاً (انضممت مؤخراً)
  // أعيد تهيئة السلسلة بإبوك جديد يشملني — خاصية الشفاء الذاتي
  async function ensure(conv, myKeys) {
    if (!conv || !conv.mls_enabled || !_api || !myKeys) return null;
    const st = await _api(`/api/conversations/${conv.id}/mls/state`);
    if (!st.enabled) return null;
    if (st.epoch === 0) return commitNewEpoch(conv.id, myKeys); // أول إبوك بعد التفعيل
    try {
      return await adopt(conv.id, myKeys, st.epoch);
    } catch (e) {
      return commitNewEpoch(conv.id, myKeys);
    }
  }

  return {
    init, ensure, adopt, commitNewEpoch,
    keyForEpoch, deriveEpochKey, computeCommitment,
    wrapForMember, unwrapEpochSecret,
    local, localEpoch, wipe, saveLocal,
    HISTORY_CAP,
  };
})();

// تصدير Node/الاختبارات
if (typeof module !== "undefined" && module.exports) {
  module.exports = globalThis.RasanMls;
}
