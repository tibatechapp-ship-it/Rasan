const path = require("path");
const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, "rasan.db"));
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL COLLATE NOCASE,
  email TEXT UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  public_key TEXT,
  locale TEXT DEFAULT 'ar',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK(type IN ('dm','group','channel')),
  name TEXT,
  description TEXT,
  owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  current_key_version INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT DEFAULT 'member',
  joined_at INTEGER NOT NULL,
  last_read_id INTEGER DEFAULT 0,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE SET NULL,
  type TEXT DEFAULT 'text',
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  ephemeral_ttl INTEGER DEFAULT 0,
  time INTEGER NOT NULL,
  key_version INTEGER DEFAULT 1,
  attachment_id TEXT,
  deleted INTEGER DEFAULT 0,
  edited_at INTEGER,
  edit_ciphertext TEXT,
  edit_iv TEXT
);
CREATE INDEX IF NOT EXISTS idx_msg_conv_time ON messages(conversation_id, time DESC);
CREATE TABLE IF NOT EXISTS group_keys (
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wrapped_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wrapped_key TEXT NOT NULL,
  iv TEXT NOT NULL,
  key_version INTEGER DEFAULT 1,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE TABLE IF NOT EXISTS stories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  type TEXT DEFAULT 'text',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS story_views (
  story_id INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  viewer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  viewed_at INTEGER NOT NULL,
  PRIMARY KEY (story_id, viewer_id)
);
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  uploader_id INTEGER NOT NULL REFERENCES users(id) ON DELETE SET NULL,
  size_bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_att_conv ON attachments(conversation_id);
CREATE TABLE IF NOT EXISTS key_backups (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  salt TEXT NOT NULL,
  iterations INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS device_tokens (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_token_user ON device_tokens(user_id);
CREATE TABLE IF NOT EXISTS conversation_bans (
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  banned_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE TABLE IF NOT EXISTS message_reactions (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_reactions_msg ON message_reactions(message_id);
CREATE TABLE IF NOT EXISTS blocked_users (
  blocker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id)
);
CREATE INDEX IF NOT EXISTS idx_blocked_target ON blocked_users(blocked_id);
CREATE TABLE IF NOT EXISTS poll_votes (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  option_index INTEGER NOT NULL CHECK(option_index >= 0 AND option_index <= 9),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_poll_votes_msg ON poll_votes(message_id);
`);

// تنظيف تلقائي لتفاعلات الرسائل وأصوات الاستطلاعات عند حذفها — يعمل على كل
// مسارات الحذف القائمة (الرسائل المتلاشية، حذف المرسل عبر socket، الحذف
// الإشرافي الناعم deleted=1) بلا تعديل أي سطر منها: الزناد يلتقط DELETE
// الصريح وUPDATE الحذف الناعم معاً. (P5: أُضيف مسح poll_votes إلى الزنادين
// عبر إعادة إنشائهما — القاعدة القائمة ترث التنظيف بلا تغيير في المسارات.)
db.exec(`
DROP TRIGGER IF EXISTS trg_msg_reactions_on_delete;
DROP TRIGGER IF EXISTS trg_msg_reactions_on_softdelete;
CREATE TRIGGER trg_msg_reactions_on_delete
AFTER DELETE ON messages
BEGIN
  DELETE FROM message_reactions WHERE message_id = OLD.id;
  DELETE FROM poll_votes WHERE message_id = OLD.id;
END;
CREATE TRIGGER trg_msg_reactions_on_softdelete
AFTER UPDATE OF deleted ON messages
WHEN NEW.deleted = 1
BEGIN
  DELETE FROM message_reactions WHERE message_id = NEW.id;
  DELETE FROM poll_votes WHERE message_id = NEW.id;
END;
`);

// ترحيلات تدريجية — ALTER TABLE يفشل إن وُجد العمود فعلًا (قاعدة قائمة) فنهمشه.
// pinned_message_id: رسالة واحدة مثبّتة لكل محادثة (أدوات الإشراف — درس FireChat
// في docs/FEATURE_RESEARCH.md §6: قنوات بلا إشراف لا تدوم).
try {
  db.exec("ALTER TABLE conversations ADD COLUMN pinned_message_id INTEGER");
} catch (e) {
  if (!String(e.message).includes("duplicate column name")) throw e;
}
// reply_to_id: الردود — مرجع معرّف الرسالة الأصل فقط (E2EE: النص المقتبس
// يبقى داخل ciphertext العميل ولا يراه الخادم إطلاقاً).
try {
  db.exec("ALTER TABLE messages ADD COLUMN reply_to_id INTEGER");
} catch (e) {
  if (!String(e.message).includes("duplicate column name")) throw e;
}
// ttl_seconds (P6 — نمط Signal «Disappearing Messages» الافتراضي): مؤقت متلاشية
// على مستوى المحادثة كله — الرسائل الجديدة ترثه إن لم تحدد المرسل مدة أطول.
// 0 = معطّل (الافتراضي؛ المحادثات القائمة تبقى كما هي بلا سلوك مفاجئ).
try {
  db.exec("ALTER TABLE conversations ADD COLUMN ttl_seconds INTEGER DEFAULT 0");
} catch (e) {
  if (!String(e.message).includes("duplicate column name")) throw e;
}
// dm_accepted (P6 — نمط WhatsApp/Signal «Message Requests»): طلبات الرسائل.
// DM يبدؤها شخص غريب تصل صاحبها الثانية كـ«طلب» يقبله صراحةً (أو يرد فتُقبل
// تلقائياً). القيمة 1 للقديمة وللمجموعات وللقنوات — صفر فقط لDM جديدة بضيف.
try {
  db.exec("ALTER TABLE conversations ADD COLUMN dm_accepted INTEGER DEFAULT 1");
} catch (e) {
  if (!String(e.message).includes("duplicate column name")) throw e;
}
// token_version (P6 — نمط إدارة الجلسات في Signal/WhatsApp): يُرفع عند تغيير
// كلمة المرور أو «خروج من كل الأجهزة» فتموت كل توكنات JWT الصادرة قبل ذلك —
// بلا قائمة revocation خادمية (تصميم بلا حالة يحافظ على بساطة النشر).
try {
  db.exec("ALTER TABLE users ADD COLUMN token_version INTEGER DEFAULT 0");
} catch (e) {
  if (!String(e.message).includes("duplicate column name")) throw e;
}
// is_demo + demo_last_used (P7 — أسبوع 2 من خارطة المنتَجة): حسابات الزوار
// التجريبية لصفحة /demo («افتح، جرّب، امسح»). is_demo يميّز الحساب (لا يمكنه
// تغيير كلمة المرور؛ بياناته تُمسح دورياً)، وdemo_last_used يدير التناوب
// بين حسابات المسبح (الأقدم استخداماً يُمنح للزائر التالي) — العمودان
// على users نفسه بلا جدول جديد ليبقى التصميم بسيطاً.
try {
  db.exec("ALTER TABLE users ADD COLUMN is_demo INTEGER DEFAULT 0");
} catch (e) {
  if (!String(e.message).includes("duplicate column name")) throw e;
}
try {
  db.exec("ALTER TABLE users ADD COLUMN demo_last_used INTEGER DEFAULT 0");
} catch (e) {
  if (!String(e.message).includes("duplicate column name")) throw e;
}

module.exports = { db, DATA_DIR, UPLOAD_DIR };
