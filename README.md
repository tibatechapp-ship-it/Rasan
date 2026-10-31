<p align="center">
  <img src=".github/assets/banner.svg" alt="رسن — Rasan" width="100%">
</p>

# رسن — Rasan

> **"خيطٌ يربط، لا يقطع"** — تطبيق دردشة حديث يجمع خير WhatsApp + Telegram + Signal، ويحل عيوبهم: الثقل، التبعية للرقم، وضعف E2EE.

## ما هو رسن؟ ولمن؟

- **المشكلة**: تطبيقات المراسلة السائدة تفرض رقم هاتف (كشف هوية)، أو سحابة مغلقة، أو عملاء ثقيلة — وفي الشبكات الضعيفة تنكسر التجربة كلها.
- **الحل**: دردشة **E2EE حقيقي** (ECDH P-256 + AES-GCM + TOFU) بواجهة ويب خفيفة (~7KB gzipped) **بلا رقم هاتف**، مع تطبيق جوال Flutter للإشعارات الآمنة، وتجربة صلة (sila) معزولة للشبكات المحلية.
- **لمن**: الأفراد والمجتمعات الذين يريدون مراسلة خاصة بلا هوية هاتفية — والمطورون الذين يريدون مرجعاً عربياً كاملاً لبناء E2EE من الصفر.
- **الحالة بصراحة**: الميزات الجوهرية مكتملة وموثقة في CHANGELOG (P1–P7: مكالمات، تفاعلات، ردود، حظر، بحث محلي، استطلاعات، إشراف كامل، خصوصية P6، صفحة تجربة P7، بنية MLS أسبوع 3) — **426 اختباراً** (379 خادم + 47 جوال). الفجوة الحالية نحو منتج منشور: صيغة السلك الرسمية RFC 9420 ونشر المتاجر.

<p align="center">
  <a href="https://github.com/tibatechapp-ship-it/Rasan/actions/workflows/ci.yml"><img src="https://github.com/tibatechapp-ship-it/Rasan/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/Node.js-%E2%89%A520-339933?logo=node.js&logoColor=white" alt="Node ≥20">
  <img src="https://img.shields.io/badge/%D8%A7%D9%84%D9%84%D8%BA%D8%A7%D8%AA-12-blue" alt="12 languages">
  <img src="https://img.shields.io/badge/%D8%AD%D8%AC%D9%85%20%D8%A7%D9%84%D9%88%D8%A7%D8%AC%D9%87%D8%A9-~7KB%20gzipped-orange" alt="7KB gzipped">
</p>

---

## 🎯 ما هذا؟ ولمن هذا؟

- **ما هو**: تطبيق دردشة جماعية مشفّر طرفاً-لطرف **بلا رقم هاتف** — اسم مستخدم فقط، عربي RTL أولاً، واجهة ~7KB مضغوطة تعمل حتى على شبكات ضعيفة، ومفتوح المصدر قابل للاستضافة الذاتية.
- **لمن**: مجتمعات عربية تحتاج الخصوصية كاملة (صحفيون، جماعات حساسة، عائلات، فِرق ميدانية) — ومن يستضيف بنفسه ويرفض ربط دردشته برقم هاتفه وسحابة مزوّد.
- **وعدٌ مميز** عن البدائل: WhatsApp ثقيل ومرتبط بالرقم، Signal متطلب متجر، Telegram ليس E2EE افتراضياً — رسن يجمع: خفّة + بلا رقم + تشفير افتراضي + إشراف مجتمعي + أوضاع طوارئ (مسح ذعر، PTT، LoRa).

## ✅ يعمل اليوم — بالدليل (2026-10-31)

| القدرة | الدليل القابل للتحقق |
|---|---|
| **426 اختباراً زمنياً أخضر** | الخادم `vitest run` = **379/379** (24 ملفاً) + الجوال `flutter test` = **47/47** + E2E Playwright = **3/3** رحلة زائر كاملة |
| CI نشر حقيقي | `ci` أخضر → `deploy-render.yml` ينشر ويُثبت الإصدار عبر `/health` بمطابقة SHA — لا يكتفي بـ200 |
| أمان مُصمّم | ECDH P-256 + AES-GCM + TOFU + forward secrecy + AAD anti-replay — موثق في [SECURITY.md](SECURITY.md) بنموذج تهديد كامل |
| تطبيق جوال حقيقي | Flutter: بوابة مصادقة، جلسات، ثيم ثلاثي، FCM بقوالب مطابقة حرفياً للخادم — **47 اختبار widget/unit** |
| إشعار طوارئ مطابق | قالب `emergency` متطابق بايت-بايت بين الخادم والجوال، مع اختبار رجعي يمنع الانجراف |

## الميزات

- ✅ E2EE (ECDH P-256 + AES-GCM + TOFU identity + per-session forward secrecy + AAD anti-replay)
- ✅ تحقق من الهوية (TOFU + أرقام أمان + QR) — vendored qrcode-generator (MIT, ~20KB)
- ✅ بدون رقم هاتف (اسم مستخدم)
- ✅ قنوات بث (50K) + مجموعات (50K)
- ✅ Stories 24h
- ✅ رسائل تختفي (TTL)
- ✅ حجم تحميل أولي ~21KB (gzipped ~7KB)
- ✅ Vanilla JS (لا build step، لا node_modules للعميل)
- ✅ i18n — 12 لغة من اليوم الأول (ar/en/fr/es/tr/ru/zh/ja/ko/de/pt/it)
- ✅ PWA قابل للتثبيت
- ✅ وصولية a11y: تنقل كامل بالكيبورد، aria-live، تباين AA، مقياس خط rem (WCAG 1.4.4)
- ✅ مفتوح المصدر، قابل للاستضافة الذاتية
- ✅ يعمل على WiFi (LAN) والإنترنت
- ✅ إشعارات Push آمنة المحتوى (FCM بقوالب ثابتة — لا يرى الخادم نصوصاً)
- ✅ مكالمات صوت/مرئي 1:1 (WebRTC — الوسائط P2P مشفّرة DTLS-SRTP)
- ✅ **مكالمات جماعية** (WebRTC mesh حتى 8 مشاركين — للمجموعات والقنوات، وسائط P2P مشفّرة لا يراها الخادم)
- ✅ **وضع للّكة PTT** (نمط Zello/واتساب): استمرار الضغط للتحدث → إرسال مشفّر فوري، سحب خارج الزر = إلغاء
- ✅ **أدوات إشراف** (درس FireChat): حظر/رفع حظر، ترقية مشرفين (مالك)، تثبيت رسالة، حذف إشرافي، وقنوات للقراءة فقط
- ✅ إنذار طوارئ بث جماعي (نمط Zello) + مذكرات صوتية مشفّرة + طابور أوفلاين بمؤشرات تسليم
- ✅ **مسح ذعر + وضع إضطرار** (نمط Briar): قفل برمز، رمز إضطرار يمسح كل بيانات الجهاز فوراً ويعرض شاشة فارغة، مسح الحساب عن بُعد بكلمة المرور
- ✅ **لوحة مشتركة CRDT** في صلة (نمط Offline Protocol): عدّاد + قائمة تتقارب بين كل العقد عبر Mesh/P2P/الخادم
- ✅ **بوابة LoRa اختيارية** (نمط Meshtastic): جسر MQTT لعقد خارجية — معطلة بلا `LORA_MQTT_URL` وانقطاعها لا يمس صلة أبداً
- ✅ **تفاعلات الإيموجي** (نمط WhatsApp): شريط 8 إيموجي بقائمة بيضاء مغلقة، تحية حية عبر Socket، وميتاداتا بلا محتوى لا تلمس E2EE
- ✅ **ردود باقتباس E2EE**: النص المقتبس داخل التشفير — الخادم يخزن مرجعاً فقط، مع اقتباس قابل للنقر يقفز للأصل
- ✅ **حظر المستخدمين** (نمط WhatsApp/Telegram): يمنع فتح DM جديدة وإضافة الأعضاء ورسائل DM القائمة — بثلاث بوابات صريحة
- ✅ **بحث محلي** (نمط Signal): يبحث في النصوص المفكوكة على جهازك فقط — الخادم لا يرى ولا يبحث شيئاً
- ✅ **محفوظات + أرشفة** (نمط Telegram): قائمة ⭐ بقفز للرسالة وأرشفة محادثات بقائمة سياق — محلية على الجهاز
- ✅ **مشاركة الموقع** (نمط Meshtastic GPS): إحداثيات مشفّرة E2EE مع رقاقة OpenStreetMap بلا أي بلاطات خارجية

## البنية

```
Rasan/
├── server/     Express + Socket.IO + better-sqlite3 + bcrypt + JWT
├── web/        Vanilla JS + Web Crypto + i18n + PWA (no build step)
├── mobile/     Flutter: بوابة مصادقة + إشعارات FCM + ثيم — 47 اختباراً خضراً
├── sila/       وحدة الاتصال الميداني (CRDT لوحة مشتركة + LoRa) — وُلدت من دمج wifi-chat
└── data/       SQLite DB + uploads (gitignored)
```

## التشغيل

```bash
# 1) مفتاح JWT
export JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")

# 2) الخادم
cd server
npm install
npm start
# → Rasan on http://localhost:3000

# 3) افتح http://localhost:3000
# على WiFi: http://IP-جهازك:3000
```

> ⚠️ **الإنتاج:** `JWT_SECRET` إلزامي (فارغ ⇒ إيقاف فوري fail-closed). اقرأ [SECURITY.md](SECURITY.md) قبل النشر.

## لقطات

| الواجهة | الميزة المعروضة |
|---|---|
| ![Rasan banner](.github/assets/banner.svg) | الواجهة الرئيسية — دردشة E2EE بلا رقم هاتف |

<!-- 💡 لقطات حقيقية: أضف PNG من التطبيق الحي في .github/assets/ وأدرجها هنا -->

## النشر — مسار واحد فقط

كل شيء يُنشر كـ **عملية Node واحدة** على Render: هي التي تخدم الواجهة (`web/`) وواجهة REST وSocket.IO
من **نفس الأصل (same origin)**، وقاعدة SQLite على قرص مُثبَّت. لهذا لا يوجد مسار نشر ثانٍ:

- **Vercel غير صالح لهذا التطبيق**: لا قرص دائم لـ SQLite، ولا خادم Socket.IO طويل العمر، والعميل
  مكتوب على `/api/...` و`io()` بنفس الأصل — نشر الواجهة وحدها يعطي دردشة بلا خادم.
- النشر لا يحدث بمجرد push: `autoDeploy: false` في `render.yaml`، والـCI هو من يقرر.

الإعداد لمرة واحدة:

```bash
# 1) Render → rasan-server → Settings → Deploy Hook → انسخ الرابط
gh secret set RENDER_DEPLOY_HOOK -R tibatechapp-ship-it/Rasan
# 2) عنوان الخدمة (يُستخدم لإثبات أن النسخة الجديدة هي الحيّة)
gh variable set RASAN_SITE_URL -R tibatechapp-ship-it/Rasan --body https://<service>.onrender.com
# 3) Render → Environment: أضف DATA_DIR=/opt/render/project/src/data (المُثبّت في blueprint)
```

بعد الدمج في `main`: إذا نجح `ci` يرسل `deploy-render.yml` طلب النشر، ثم ينتظر `/health` حتى يعلن
`commit` مطابقاً للـSHA المدفوع. **HTTP 200 لا يكفي** كدليل — النسخة القديمة تُرجع 200 أيضاً.

- مثيل واحد (`numInstances: 1`) بقصد: Socket.IO في الذاكرة + قرص SQLite = عملية واحدة.
  التوسّع الأفقي يحتاج مخزناً مشتركاً وقاعدة بيانات حقيقية أولاً.
- خطة `starter` ضرورية: الخطة المجانية على Render بلا قرص دائم → قاعدة البيانات تُمسح عند كل نشر.

فحص سريع للإنتاج:

```bash
curl -fsS https://<service>.onrender.com/health   # {"ok":true,"uptime":…,"version":"1.0.0","commit":"abc1234"}
```

## 🗺️ الطريق نحو المتاجر

الواجهة PWA اليوم، والجوال Flutter حقيقي. المتبقي معلن في [خارطة المنتَجة](https://github.com/tibatechapp-ship-it/vixona-github-profile/blob/main/docs/productization-plan.md):
1. ✅ **AAB موقّع** يُبنى تلقائياً في CI على كل tag (أسبوع 1 — منجز ومُتحقق منه على `v0.0.5-aab-test`)
2. ✅ **صفحة demo عامة** بجلسة زائر فورية ومسح تلقائي + E2E Playwright للرحلة الكاملة (أسبوع 2 — جربها على `/demo`)
3. ✅ **بنية MLS للمجموعات** (روح RFC 9420): إبوكات + أغلفة إفيمرالية لكل عضو + أي-عضو يصدر commit + commitment يكشف العبث — نسخة موازية اختيارية `mls_enabled` فوق بنية `group_keys`، مع **اختبار ميداني موثق** (`docs/MLS_FIELD_TEST.md` — 22 اختبار محاكاة/عقود؛ صيغة السلك الرسمية مؤجلة بوعي — راجع حدودها الموثقة)

## التوثيق

| الملف | المحتوى |
|---|---|
| [CONTRIBUTING.md](CONTRIBUTING.md) | كيف تساهم: بيئة التطوير، سير العمل، معايير القبول |
| [SECURITY.md](SECURITY.md) | سياسة الإبلاغ عن الثغرات ونموذج التهديد |
| [CHANGELOG.md](CHANGELOG.md) | سجل التغييرات الإصداري |

## الترخيص

MIT © TibaTech / Vixona Technologies
