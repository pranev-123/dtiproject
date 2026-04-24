// Load .env from same directory as server.js (so OPENAI_API_KEY etc. are always found)
const path = require('path');
try {
  require('dotenv').config({ path: path.join(__dirname, '.env') });
} catch (_) { /* dotenv optional */ }
const { applySecretsFromFiles } = require('./lib/secrets');
applySecretsFromFiles();
const fs = require('fs');
const os = require('os');
const https = require('https');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
let createSocketRedisAdapter = null;
try { ({ createAdapter: createSocketRedisAdapter } = require('@socket.io/redis-adapter')); } catch (_) { createSocketRedisAdapter = null; }
let createRedisClient = null;
try { ({ createClient: createRedisClient } = require('redis')); } catch (_) { createRedisClient = null; }
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const nodemailer = require('nodemailer');
const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');
const bcrypt = require('bcrypt');
const multer = require('multer');
let MongoClient;
try { ({ MongoClient } = require('mongodb')); } catch (_) { MongoClient = null; }
let QRCode;
try { QRCode = require('qrcode'); } catch (_) { QRCode = null; }

// ---- Security module: AES, RSA, HMAC, hashing, secure tokens ----
const security = require('./lib/security');

// ---- Strong encryption & security ----
// bcrypt: keep configurable for demo-time speed tuning; clamp to safe range.
const BCRYPT_ROUNDS = Math.max(8, Math.min(12, Number(process.env.BCRYPT_ROUNDS || 8)));
const VERIFICATION_TOKEN_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours
const TOKEN_HASH_ALGO = 'sha256';
function hashToken(token) {
  return crypto.createHash(TOKEN_HASH_ALGO).update(String(token)).digest('hex');
}

// ---- Module 2: Smart login security constants ----
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 10 * 60 * 1000; // 10 minutes
const LOGIN_OTP_EXPIRY_MS = 3 * 60 * 1000; // 3 minutes
const LOGIN_OTP_MAX_ATTEMPTS = 5;
const LOGIN_OTP_RESEND_COOLDOWN_MS = 10 * 1000; // 10 seconds between OTP emails
const GOOGLE_CLIENT_ID = String(process.env.GOOGLE_CLIENT_ID || '').trim();
const FACULTY_EMAIL_SUFFIX = '@rajalakshmi.edu.in';
const FACULTY_EMAIL_SUFFIX_ALIASES = ['@raajalakshmi.edu.in'];
const FACULTY_STUDENT_DUAL_ROLE_ALLOWLIST = new Set([
  '231001509@rajalakshmi.edu.in',
]);
const NUMERIC_EMAIL_LOCALPART_REGEX = /^\d+$/;
// Keep AI automation disabled by default until explicitly enabled from dashboard/settings.
const AUTO_ENABLE_AI_AGENT_ON_SIGNIN = String(process.env.AUTO_ENABLE_AI_AGENT_ON_SIGNIN || 'false').trim().toLowerCase() === 'true';

function normalizeFacultyEmailForAuth(emailRaw) {
  const email = String(emailRaw || '').trim().toLowerCase();
  if (!email) return '';
  if (email.endsWith(FACULTY_EMAIL_SUFFIX)) return email;
  for (const alias of FACULTY_EMAIL_SUFFIX_ALIASES) {
    if (email.endsWith(alias)) {
      return email.slice(0, -alias.length) + FACULTY_EMAIL_SUFFIX;
    }
  }
  return email;
}

function isAllowedFacultyEmail(emailRaw) {
  const email = normalizeFacultyEmailForAuth(emailRaw);
  return !!email && email.endsWith(FACULTY_EMAIL_SUFFIX);
}

function isFacultyStudentDualRoleAllowed(emailRaw) {
  const email = normalizeFacultyEmailForAuth(emailRaw);
  if (!email || !email.endsWith(FACULTY_EMAIL_SUFFIX)) return false;
  if (FACULTY_STUDENT_DUAL_ROLE_ALLOWLIST.has(email)) return true;
  const localPart = email.slice(0, -FACULTY_EMAIL_SUFFIX.length);
  return NUMERIC_EMAIL_LOCALPART_REGEX.test(localPart);
}

/** WhatsApp support deeplink for profile menus & Smart Assist (digits only, include country code). */
const WHATSAPP_SUPPORT_PHONE = String(process.env.WHATSAPP_SUPPORT_PHONE || '916383596165').replace(/\D/g, '');
const WHATSAPP_PREFILL_MESSAGE = (() => {
  const t = String(process.env.WHATSAPP_PREFILL_MESSAGE || 'REC SmartAssist query').trim();
  return t || 'REC SmartAssist query';
})();

function getWhatsAppSupportPayload() {
  if (!WHATSAPP_SUPPORT_PHONE) return null;
  const waUrl = `https://wa.me/${WHATSAPP_SUPPORT_PHONE}?text=${encodeURIComponent(WHATSAPP_PREFILL_MESSAGE)}`;
  let phoneDisplay = WHATSAPP_SUPPORT_PHONE;
  if (WHATSAPP_SUPPORT_PHONE.length >= 12 && WHATSAPP_SUPPORT_PHONE.startsWith('91')) {
    phoneDisplay = WHATSAPP_SUPPORT_PHONE.slice(-10);
  }
  return { waUrl, phoneDisplay };
}

// ---- Module 3: AI attention prediction constants ----
const PREDICTION_HISTORY_SIZE = 10;
const PREDICTION_SAMPLE_INTERVAL_MS = 5 * 1000; // 5 seconds
const PREDICTION_CONSECUTIVE_NEGATIVE = 4;
const PREDICTION_COOLDOWN_MS = 2 * 60 * 1000; // 2 minutes
const ATTENTION_MIN_PUSH_INTERVAL_MS = Math.max(1000, Number(process.env.ATTENTION_MIN_PUSH_INTERVAL_MS || 3000));

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.disable('x-powered-by');
const trustProxyRaw = String(process.env.TRUST_PROXY ?? '1').trim();
let trustProxySetting = 1;
if (trustProxyRaw === 'true' || trustProxyRaw === '1') trustProxySetting = true;
else if (trustProxyRaw === 'false' || trustProxyRaw === '0') trustProxySetting = false;
else if (/^\d+$/.test(trustProxyRaw)) trustProxySetting = parseInt(trustProxyRaw, 10);
app.set('trust proxy', trustProxySetting);

const BEHIND_REVERSE_PROXY = String(process.env.BEHIND_REVERSE_PROXY || '').trim().toLowerCase() === 'true';

// Optional HTTPS server (needed for camera/hand-raise on phones over LAN).
// When BEHIND_REVERSE_PROXY=true, terminate TLS at nginx/Caddy and bind Node to HTTP only.
// Enable embedded HTTPS by providing cert files:
// - certs/key.pem
// - certs/cert.pem
let httpsServer = null;
let httpsPort = null;
if (!BEHIND_REVERSE_PROXY) {
  try {
    const keyPath = process.env.HTTPS_KEY_PATH || path.join(__dirname, 'certs', 'key.pem');
    const certPath = process.env.HTTPS_CERT_PATH || path.join(__dirname, 'certs', 'cert.pem');
    const portCandidate = Number(process.env.HTTPS_PORT || 3443);
    if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
      const key = fs.readFileSync(keyPath);
      const cert = fs.readFileSync(certPath);
      httpsServer = https.createServer({ key, cert }, app);
      httpsPort = portCandidate;
      // Attach socket.io to HTTPS as well so clients can connect securely.
      io.attach(httpsServer);
    }
  } catch (e) {
    httpsServer = null;
    httpsPort = null;
  }
}

const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production';
// Strong session secret: production must set SESSION_SECRET or SESSION_SECRET_FILE (>= 32 chars).
let sessionSecretCandidate = String(process.env.SESSION_SECRET || '').trim();
if (!sessionSecretCandidate || sessionSecretCandidate.length < 32) {
  if (isProduction) {
    console.error('FATAL: In production set SESSION_SECRET (>= 32 chars) or SESSION_SECRET_FILE (Docker/K8s secret mount).');
    process.exit(1);
  }
  sessionSecretCandidate = crypto.randomBytes(32).toString('hex');
}
const SESSION_SECRET = sessionSecretCandidate;
const sessionCookieTrustProxy = BEHIND_REVERSE_PROXY
  || String(process.env.SESSION_COOKIE_TRUST_PROXY || '').trim().toLowerCase() === 'true';
const useObfuscatedBuild = process.argv.includes('--use-obfuscated');
const obfPublicDirCandidate = path.join(__dirname, 'build', 'public');
const obfAssetsDirCandidate = path.join(__dirname, 'build', 'assets');
const PUBLIC_DIR = useObfuscatedBuild && fs.existsSync(obfPublicDirCandidate)
  ? obfPublicDirCandidate
  : path.join(__dirname, 'public');
const ASSETS_DIR = useObfuscatedBuild && fs.existsSync(obfAssetsDirCandidate)
  ? obfAssetsDirCandidate
  : path.join(__dirname, 'assets');
function publicPath(...parts) {
  return path.join(PUBLIC_DIR, ...parts);
}

// In-memory stores (for demo / project use only)
const users = {}; // { email: { password, name, staffId, department, designation } } — faculty (must register first)
const studentRegistrations = {}; // { email: { registerNumber } } — students must register before login
// sessions: { sessionId: { id, ownerEmail, topic, venue, startTime, endTime, attentionHistory, alerts, deviceIds, closed, summary } }
const sessions = {};
// Smart attendance (hand-raise): key = `${sessionId}:${registerNumber}` → { sessionId, registerNumber, date, status, odProofUrl? }
const attendanceRecords = {};
// Support/contact messages from dashboard users.
const supportRequests = [];
// Campus feed posts visible across dashboards.
const campusFeedPosts = [];
// Audit trail for automation actions/toggles.
const automationAuditLogs = [];
// Firewall-style network access logs for dashboard users.
const firewallNetworkLogs = [];
// Demo control:
// - Smart Attendance (hand-raise) ENABLED
// - Allow OD proof upload
const ATTENDANCE_SYSTEM_DISABLED = true;
const HAND_RAISE_DISABLED = ATTENDANCE_SYSTEM_DISABLED || false;
const OD_UPLOAD_DISABLED = false;
// Module 1: token -> { type: 'faculty'|'student', email: string } for email verification
const verificationTokens = {};
// One-time / paste credential reveal for faculty (encrypted password via email): tokenId -> { encryptedPayload, exp }
const revealCredentialTokens = {};
const REVEAL_CREDENTIAL_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours
// Short-lived OTP challenges for dashboard logins.
const loginOtpChallenges = {}; // challengeId -> { role, email, otpHash, exp, attempts, sessionData, meta }
// Global classroom session flag: true when any session is actively broadcast for students.
// This is used by the student UI to block camera/stream until faculty explicitly starts a session.
let globalSessionActive = false;
function sessionRoomId(sessionId) {
  return `session:${String(sessionId || '').trim()}`;
}

function emitSessionScoped(eventName, sessionId, payload) {
  const sid = String(sessionId || '').trim();
  if (sid) {
    io.to(sessionRoomId(sid)).emit(eventName, payload);
    return;
  }
  io.emit(eventName, payload);
}
// Full college address for email footers (plain text: newlines; HTML: use COLLEGE_FOOTER_HTML)
const COLLEGE_FOOTER_TEXT = `Rajalakshmi Engineering College (An Autonomous Institution)
Rajalakshmi Nagar, Thandalam, Sriperumbudur
Chennai - 602 105, Tamil Nadu, India`;
const COLLEGE_FOOTER_HTML = COLLEGE_FOOTER_TEXT.replace(/\n/g, '<br>');
/** Branded header line for institutional emails (matches public college name). */
const COLLEGE_HEADER_AUTONOMOUS = 'Rajalakshmi Engineering College (An Autonomous Institution)';

/** Client IP for audit lines in transactional email (honours X-Forwarded-For when set). */
function clientIpFromReq(req) {
  if (!req) return '';
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  if (xf) return xf;
  return String(req.ip || req.socket?.remoteAddress || '').trim() || '';
}

// Persist registered users and students to a simple JSON "database" so registrations
// survive server restarts (prevents duplicate registration after restart).
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const MONGO_URI = String(process.env.MONGODB_URI || process.env.MONGO_URI || '').trim();
const MONGO_DB_NAME = String(process.env.MONGODB_DB || 'dti').trim();
const REDIS_URL = String(process.env.REDIS_URL || '').trim();
let mongoClient = null;
let mongoDb = null;
let mongoCollections = null;
let redisPubClient = null;
let redisSubClient = null;
const OD_DIR = path.join(DATA_DIR, 'od-proofs');
const OD_VERIFICATION_DIR = path.join(DATA_DIR, 'od-verification-proofs');
const PROFILE_DIR = path.join(DATA_DIR, 'profile-images');
const STUDENT_DOCS_DIR = path.join(DATA_DIR, 'student-documents');
const FEED_MEDIA_DIR = path.join(DATA_DIR, 'feed-media');
const SLEEP_ALERT_DIR = path.join(DATA_DIR, 'sleep-alerts');
try {
  if (!fs.existsSync(OD_VERIFICATION_DIR)) {
    fs.mkdirSync(OD_VERIFICATION_DIR, { recursive: true });
  }
  if (!fs.existsSync(PROFILE_DIR)) {
    fs.mkdirSync(PROFILE_DIR, { recursive: true });
  }
  if (!fs.existsSync(STUDENT_DOCS_DIR)) {
    fs.mkdirSync(STUDENT_DOCS_DIR, { recursive: true });
  }
  if (!fs.existsSync(FEED_MEDIA_DIR)) {
    fs.mkdirSync(FEED_MEDIA_DIR, { recursive: true });
  }
  if (!fs.existsSync(SLEEP_ALERT_DIR)) {
    fs.mkdirSync(SLEEP_ALERT_DIR, { recursive: true });
  }
} catch (_) {
  // Directory creation is best-effort.
}
const upload = multer({
  dest: OD_DIR,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
});
const odVerificationUpload = multer({
  dest: OD_VERIFICATION_DIR,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
});
const profileStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, PROFILE_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(String(file.originalname || '')).toLowerCase();
    const safeExt = ext && ext.length <= 8 ? ext : '.jpg';
    cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${safeExt}`);
  },
});
const profileUpload = multer({
  storage: profileStorage,
  limits: { fileSize: 3 * 1024 * 1024 }, // 3 MB
  fileFilter: (_req, file, cb) => {
    const mime = String(file.mimetype || '').toLowerCase();
    cb(null, mime.startsWith('image/'));
  },
});

const STUDENT_DOC_ALLOWED_MIMES = new Set([
  'application/pdf',
  'text/plain',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/jpeg',
  'image/png',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);
const studentDocsStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, STUDENT_DOCS_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(String(file.originalname || '')).toLowerCase();
    const safeExt = ext && ext.length <= 10 ? ext : '.bin';
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${safeExt}`);
  },
});
const studentDocsUpload = multer({
  storage: studentDocsStorage,
  limits: { fileSize: 6 * 1024 * 1024 }, // 6 MB each
  fileFilter: (_req, file, cb) => {
    const mime = String(file.mimetype || '').toLowerCase();
    if (STUDENT_DOC_ALLOWED_MIMES.has(mime)) return cb(null, true);
    return cb(new Error('Unsupported file type. Use PDF/DOC/DOCX/TXT/JPG/PNG/XLS/XLSX.'));
  },
});

const feedMediaStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, FEED_MEDIA_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(String(file.originalname || '')).toLowerCase();
    const safeExt = ext && ext.length <= 10 ? ext : '.bin';
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${safeExt}`);
  },
});
const feedMediaUpload = multer({
  storage: feedMediaStorage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const mime = String(file.mimetype || '').toLowerCase();
    if (mime.startsWith('image/') || mime.startsWith('video/')) return cb(null, true);
    return cb(new Error('Only image and video files are allowed.'));
  },
});

function loadDatabase() {
  try {
    if (!fs.existsSync(DB_FILE)) return;
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    if (!raw || !raw.trim()) return;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      if (parsed.users && typeof parsed.users === 'object') {
        Object.assign(users, parsed.users);
      }
      if (parsed.studentRegistrations && typeof parsed.studentRegistrations === 'object') {
        Object.assign(studentRegistrations, parsed.studentRegistrations);
      }
      if (parsed.attendanceRecords && typeof parsed.attendanceRecords === 'object') {
        Object.assign(attendanceRecords, parsed.attendanceRecords);
      }
      if (Array.isArray(parsed.supportRequests)) {
        supportRequests.splice(0, supportRequests.length, ...parsed.supportRequests);
      }
      if (Array.isArray(parsed.campusFeedPosts)) {
        campusFeedPosts.splice(0, campusFeedPosts.length, ...parsed.campusFeedPosts);
      }
      if (Array.isArray(parsed.automationAuditLogs)) {
        automationAuditLogs.splice(0, automationAuditLogs.length, ...parsed.automationAuditLogs);
      }
      if (Array.isArray(parsed.firewallNetworkLogs)) {
        firewallNetworkLogs.splice(0, firewallNetworkLogs.length, ...parsed.firewallNetworkLogs);
      }
    }
    console.log('Loaded users, student registrations and attendance from db.json');
  } catch (err) {
    console.error('Failed to load database file db.json:', err);
  }
}

function saveDatabase() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    const payload = {
      users,
      studentRegistrations,
      attendanceRecords,
      supportRequests,
      campusFeedPosts,
      automationAuditLogs,
      firewallNetworkLogs,
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(payload, null, 2), 'utf8');
    persistAppStateToMongo(payload);
  } catch (err) {
    console.error('Failed to save database file db.json:', err);
  }
}

// Load persisted registrations (if any) at startup.
loadDatabase();
runBackgroundTask('Initialize MongoDB', async () => {
  await initMongo();
});
runBackgroundTask('Initialize Socket.IO Redis adapter', async () => {
  await initSocketRedisAdapter();
});

async function initSocketRedisAdapter() {
  if (!REDIS_URL) return;
  if (!createRedisClient || !createSocketRedisAdapter) {
    console.warn('REDIS_URL is set but redis adapter dependencies are missing. Continuing with in-memory Socket.IO adapter.');
    return;
  }
  try {
    redisPubClient = createRedisClient({ url: REDIS_URL });
    redisSubClient = redisPubClient.duplicate();
    await Promise.all([redisPubClient.connect(), redisSubClient.connect()]);
    io.adapter(createSocketRedisAdapter(redisPubClient, redisSubClient));
    console.log(`Socket.IO Redis adapter connected (${REDIS_URL})`);
  } catch (err) {
    console.error('Socket.IO Redis adapter init failed; continuing with in-memory adapter:', err.message || err);
    if (redisPubClient) {
      try { await redisPubClient.quit(); } catch (_) {}
    }
    if (redisSubClient) {
      try { await redisSubClient.quit(); } catch (_) {}
    }
    redisPubClient = null;
    redisSubClient = null;
  }
}

async function initMongo() {
  if (!MONGO_URI || !MongoClient) {
    if (MONGO_URI && !MongoClient) {
      console.warn('MongoDB URI is set, but mongodb package is not installed. Continuing with db.json only.');
    }
    return;
  }
  try {
    mongoClient = new MongoClient(MONGO_URI, { maxPoolSize: 20 });
    await mongoClient.connect();
    mongoDb = mongoClient.db(MONGO_DB_NAME);
    mongoCollections = {
      appState: mongoDb.collection('appState'),
      sessions: mongoDb.collection('sessions'),
      attentionEvents: mongoDb.collection('attentionEvents'),
    };
    await Promise.all([
      mongoCollections.sessions.createIndex({ sessionId: 1 }, { unique: true }),
      mongoCollections.sessions.createIndex({ ownerEmail: 1, createdAt: -1 }),
      mongoCollections.attentionEvents.createIndex({ sessionId: 1, timestamp: -1 }),
      mongoCollections.attentionEvents.createIndex({ sessionId: 1, studentRegisterNumber: 1, timestamp: -1 }),
      mongoCollections.attentionEvents.createIndex({ studentId: 1, timestamp: -1 }),
      mongoCollections.attentionEvents.createIndex({ studentRegisterNumber: 1, timestamp: -1 }),
    ]);
    await hydratePersistentStateFromMongo();
    console.log(`MongoDB connected (${MONGO_DB_NAME})`);
  } catch (err) {
    console.error('MongoDB init failed; using db.json fallback only:', err.message || err);
    mongoCollections = null;
    if (mongoClient) {
      try { await mongoClient.close(); } catch (_) {}
    }
    mongoClient = null;
    mongoDb = null;
  }
}

function mongoReady() {
  return !!(mongoCollections && mongoCollections.sessions && mongoCollections.attentionEvents && mongoCollections.appState);
}

async function hydratePersistentStateFromMongo() {
  if (!mongoReady()) return;
  const doc = await mongoCollections.appState.findOne({ _id: 'primary' });
  if (!doc || typeof doc !== 'object') return;
  if (doc.users && typeof doc.users === 'object') {
    Object.keys(users).forEach((k) => delete users[k]);
    Object.assign(users, doc.users);
  }
  if (doc.studentRegistrations && typeof doc.studentRegistrations === 'object') {
    Object.keys(studentRegistrations).forEach((k) => delete studentRegistrations[k]);
    Object.assign(studentRegistrations, doc.studentRegistrations);
  }
  if (doc.attendanceRecords && typeof doc.attendanceRecords === 'object') {
    Object.keys(attendanceRecords).forEach((k) => delete attendanceRecords[k]);
    Object.assign(attendanceRecords, doc.attendanceRecords);
  }
  if (Array.isArray(doc.supportRequests)) {
    supportRequests.splice(0, supportRequests.length, ...doc.supportRequests);
  }
  if (Array.isArray(doc.campusFeedPosts)) {
    campusFeedPosts.splice(0, campusFeedPosts.length, ...doc.campusFeedPosts);
  }
  if (Array.isArray(doc.automationAuditLogs)) {
    automationAuditLogs.splice(0, automationAuditLogs.length, ...doc.automationAuditLogs);
  }
  if (Array.isArray(doc.firewallNetworkLogs)) {
    firewallNetworkLogs.splice(0, firewallNetworkLogs.length, ...doc.firewallNetworkLogs);
  }
  console.log('Hydrated persistent app state from MongoDB.');
}

function persistAppStateToMongo(snapshotPayload) {
  if (!mongoReady()) return;
  const payload = snapshotPayload && typeof snapshotPayload === 'object' ? snapshotPayload : {
    users,
    studentRegistrations,
    attendanceRecords,
    supportRequests,
    campusFeedPosts,
    automationAuditLogs,
    firewallNetworkLogs,
  };
  runBackgroundTask('Persist app state in MongoDB', async () => {
    await mongoCollections.appState.updateOne(
      { _id: 'primary' },
      {
        $set: {
          users: payload.users || {},
          studentRegistrations: payload.studentRegistrations || {},
          attendanceRecords: payload.attendanceRecords || {},
          supportRequests: Array.isArray(payload.supportRequests) ? payload.supportRequests : [],
          campusFeedPosts: Array.isArray(payload.campusFeedPosts) ? payload.campusFeedPosts : [],
          automationAuditLogs: Array.isArray(payload.automationAuditLogs) ? payload.automationAuditLogs : [],
          firewallNetworkLogs: Array.isArray(payload.firewallNetworkLogs) ? payload.firewallNetworkLogs : [],
          updatedAt: new Date(),
        },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true },
    );
  });
}

function persistSessionToMongo(sessionObj) {
  if (!mongoReady() || !sessionObj) return;
  const doc = {
    sessionId: String(sessionObj.id || ''),
    ownerEmail: String(sessionObj.ownerEmail || ''),
    topic: String(sessionObj.topic || ''),
    venue: String(sessionObj.venue || ''),
    startTime: String(sessionObj.startTime || ''),
    endTime: String(sessionObj.endTime || ''),
    createdAt: sessionObj.createdAt ? new Date(sessionObj.createdAt) : new Date(),
    closed: !!sessionObj.closed,
    sessionMode: String(sessionObj.sessionMode || 'lecture'),
    updatedAt: new Date(),
  };
  runBackgroundTask('Persist session in MongoDB', async () => {
    await mongoCollections.sessions.updateOne(
      { sessionId: doc.sessionId },
      { $set: doc, $setOnInsert: { insertedAt: new Date() } },
      { upsert: true },
    );
  });
}

function persistAttentionEventToMongo(sessionObj, payload) {
  if (!mongoReady() || !sessionObj || !payload) return;
  const ts = payload.timestamp ? new Date(payload.timestamp) : new Date();
  const doc = {
    sessionId: String(sessionObj.id || ''),
    ownerEmail: String(sessionObj.ownerEmail || ''),
    timestamp: ts,
    score: Number(payload.score || 0),
    source: String(payload.source || 'unknown'),
    studentRegisterNumber: payload.studentRegisterNumber ? String(payload.studentRegisterNumber) : null,
    studentId: payload.studentRegisterNumber ? String(payload.studentRegisterNumber) : null,
    sourceType: payload.sourceType ? String(payload.sourceType) : null,
    deviceHash: payload.deviceHash ? String(payload.deviceHash) : null,
    createdAt: new Date(),
  };
  runBackgroundTask('Persist attention event in MongoDB', async () => {
    await mongoCollections.attentionEvents.insertOne(doc);
    await mongoCollections.sessions.updateOne(
      { sessionId: String(sessionObj.id || '') },
      { $set: { closed: !!sessionObj.closed, updatedAt: new Date() } },
      { upsert: true },
    );
  });
}

// Prune device IDs older than 2 minutes so we count only recent contributors
const DEVICE_ID_TTL_MS = 2 * 60 * 1000;
function pruneDeviceIds(s) {
  if (!s.deviceIds) return 0;
  const now = Date.now();
  for (const id of Object.keys(s.deviceIds)) {
    if (now - new Date(s.deviceIds[id]).getTime() > DEVICE_ID_TTL_MS) delete s.deviceIds[id];
  }
  return Object.keys(s.deviceIds).length;
}

// Simple mapping of rooms to underlying camera sources (IP/RTSP/device paths).
// In this demo we only declare a few sample rooms; extend as required for real hardware.
const cameraSources = {
  A101: '/dev/video1',
  A102: '/dev/video2',
  A203: '/dev/video3',
  B301: '/dev/video4',
  C204: '/dev/video5',
  D402: '/dev/video6',
};

// Mailer: sends username + password via Gmail (or other SMTP) for faculty and student registration
const smtpConfigured = !!(process.env.SMTP_USER && process.env.SMTP_PASS);
const isGmail = (process.env.SMTP_HOST || 'smtp.gmail.com').toLowerCase().includes('gmail');
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: Number(process.env.SMTP_PORT) || 587,
  secure: process.env.SMTP_SECURE === 'true',
  requireTLS: isGmail,
  auth: smtpConfigured
    ? {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      }
    : undefined,
});

const PASSWORD_FORMAT_MODE = String(process.env.PASSWORD_FORMAT_MODE || 'fixed').trim().toLowerCase();
const RANDOM_PASSWORD_LENGTH = Math.min(32, Math.max(10, Number(process.env.RANDOM_PASSWORD_LENGTH) || 14));

function generateRandomCredentialPassword(length = RANDOM_PASSWORD_LENGTH) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789@#$%&*+-_!';
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) out += chars[bytes[i] % chars.length];
  return out;
}

function normalizeStudentDepartmentCode(departmentRaw) {
  const code = String(departmentRaw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  return code || '';
}

/**
 * Student initial/reset password format based on entered department.
 * Example: department "eee", register number "231001509" => Rec.eee@+1509$
 */
function generateStudentInitialPassword(departmentRaw, registerNumberRaw) {
  const dept = normalizeStudentDepartmentCode(departmentRaw) || 'student';
  const regDigits = String(registerNumberRaw || '').replace(/\D/g, '');
  let tail = '000';
  if (regDigits.length >= 9) tail = regDigits.slice(-4);
  else if (regDigits.length >= 8) tail = regDigits.slice(-3);
  else if (regDigits.length >= 4) tail = regDigits.slice(-4);
  else if (regDigits.length >= 1) tail = regDigits;
  return `Rec.${dept}@+${tail}$`;
}

function getInitialPasswordForRole(role, opts = {}) {
  const mode = PASSWORD_FORMAT_MODE === 'random' ? 'random' : 'fixed';
  if (mode === 'random') return generateRandomCredentialPassword();
  if (role === 'faculty' || role === 'leadership') {
    return buildStaffPhonePassword(opts.staffId, opts.mobile || '');
  }
  if (role === 'student') {
    return generateStudentInitialPassword(opts.departmentCode || '', opts.registerNumber || '');
  }
  return '';
}

/**
 * Send login credentials email after registration.
 * Faculty: password is encrypted; email contains encrypted credential + one-time reveal link (no plain password).
 * Student: password is encrypted (same reveal flow as faculty).
 * @param {string} email - Recipient email (validated by caller)
 * @param {string} username - Login username
 * @param {string} password - Initial password (hashed on server; sent only inside encrypted payload in email)
 * @param {'student'|'faculty'} role - Role for template selection
 * @param {string} [baseUrlOverride] - Base URL for reveal-credentials link
 * @param {'registration'|'password_reset'|object} [loginOpts] - Context string, or { emailContext, verifyUrl }
 * @returns {Promise<boolean>} - true if sent, false if SMTP not configured or send failed
 */
async function sendLoginEmail(email, username, password, role, baseUrlOverride, loginOpts) {
  if (!smtpConfigured) {
    console.log('Login credential email skipped: SMTP not configured.');
    return false;
  }
  const { emailContext, verifyUrl } = parseSendLoginEmailOptions(loginOpts);
  const isStudent = role === 'student';
  const baseUrl =
    baseUrlOverride ||
    normalizeEmailBaseUrl(process.env.PUBLIC_BASE_URL) ||
    normalizeEmailBaseUrl(process.env.SERVER_URL) ||
    `http://localhost:${PORT}`;
  warnIfLocalhostEmailLinks(baseUrl, 'Login credential links');
  const portalBits = accessPortalEmailSnippet(baseUrl);
  const footerWithLogo = `
  <div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid #eee; text-align: center; font-size: 12px; color: #555;">
    <img src="cid:rec-logo" alt="REC Logo" style="max-height: 60px; width: auto; margin-bottom: 10px;" /><br>
    ${COLLEGE_FOOTER_HTML}
  </div>`;

  let subject;
  let textBody;
  let htmlBody;

  {
    const ctx = emailContext === 'password_reset' ? 'password_reset' : 'registration';
    const verifyBlockHtml = verifyUrl && ctx === 'registration' ? emailVerifyEmailCtaHtml(verifyUrl) : '';
    const verifyTextExtra =
      verifyUrl && ctx === 'registration'
        ? `Important — verify your college email before signing in:\n${verifyUrl}\n\n`
        : '';
    // Encrypt password and send encrypted credential + one-time reveal link (no plain password in email)
    const payload = { email, username, password, role: isStudent ? 'student' : 'faculty' };
    const encryptedHex = security.encryptData(JSON.stringify(payload));
    const tokenId = crypto.randomBytes(16).toString('hex');
    revealCredentialTokens[tokenId] = {
      encryptedPayload: encryptedHex,
      exp: Date.now() + REVEAL_CREDENTIAL_EXPIRY_MS,
    };
    const revealUrl = `${baseUrl}/reveal-credentials?t=${tokenId}`;
    const revealPageUrl = `${baseUrl}/reveal-credentials`;

    if (isStudent && ctx === 'registration') {
      subject = 'Login Credentials for Student Dashboard (Encrypted)';
      textBody = `Hello Student,

Your account for the AI Classroom Attention System has been successfully created.

${verifyTextExtra}Your password is sent in encrypted form for security.

1) One-time link (valid 24 hours) — click to view your credentials now:
${revealUrl}

2) Encrypted credential (permanent). To view your password later, go to ${revealPageUrl} and paste the value below:

${encryptedHex}

You can now access the Student Dashboard after revealing your password. Please change your password after your first login.
${portalBits.text}
${COLLEGE_FOOTER_TEXT}`;
      htmlBody = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 560px;">
  <p>Hello Student,</p>
  <p>Your account for the AI Classroom Attention System has been successfully created.</p>
  <p>Your password is sent in <strong>encrypted form</strong> for security.</p>
  ${verifyBlockHtml}
  <p><strong>1)</strong> One-time link (valid 24 hours) — click to view your credentials now:</p>
  <p><a href="${escapeHtml(revealUrl)}">View my credentials</a></p>
  <p><strong>2)</strong> Encrypted credential (permanent). To view your password later, go to <a href="${escapeHtml(revealPageUrl)}">${escapeHtml(revealPageUrl)}</a> and paste the value below:</p>
  <p style="word-break: break-all; font-family: monospace; font-size: 11px; background: #f5f5f5; padding: 8px;">${escapeHtml(encryptedHex)}</p>
  <p>You can now access the Student Dashboard after revealing your password. Please change your password after your first login.</p>
  ${portalBits.html}
  ${footerWithLogo}
</body>
</html>`;
    } else if (isStudent && ctx === 'password_reset') {
      subject = 'REC Classroom Attention — Student password reset (Encrypted)';
      textBody = `Hello Student,

Your student dashboard login password has been reset.

Your new password is sent in encrypted form for security.

1) One-time link (valid 24 hours) — click to view your credentials now:
${revealUrl}

2) Encrypted credential (permanent). To view your password later, go to ${revealPageUrl} and paste the value below:

${encryptedHex}

You can now access the Student Dashboard after revealing your password. Please change your password after your next login.
${portalBits.text}
${COLLEGE_FOOTER_TEXT}`;
      htmlBody = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 560px;">
  <p>Hello Student,</p>
  <p>Your student dashboard login password has been <strong>reset</strong>.</p>
  <p>Your new password is sent in <strong>encrypted form</strong> for security.</p>
  <p><strong>1)</strong> One-time link (valid 24 hours) — click to view your credentials now:</p>
  <p><a href="${escapeHtml(revealUrl)}">View my credentials</a></p>
  <p><strong>2)</strong> Encrypted credential (permanent). To view your password later, go to <a href="${escapeHtml(revealPageUrl)}">${escapeHtml(revealPageUrl)}</a> and paste the value below:</p>
  <p style="word-break: break-all; font-family: monospace; font-size: 11px; background: #f5f5f5; padding: 8px;">${escapeHtml(encryptedHex)}</p>
  <p>You can now access the Student Dashboard after revealing your password. Please change your password after your next login.</p>
  ${portalBits.html}
  ${footerWithLogo}
</body>
</html>`;
    } else {
      subject = 'Login Credentials for Faculty Dashboard (Encrypted)';
      textBody = `Hello Faculty Member,

Your account for the AI Classroom Attention System has been successfully created.

${verifyTextExtra}Your password is sent in encrypted form for security.

1) One-time link (valid 24 hours) — click to view your credentials now:
${revealUrl}

2) Encrypted credential (permanent; keep this safe). To view your password later, go to ${revealPageUrl} and paste the value below (paste as one line — remove spaces or line breaks if your email app wrapped the text):

${encryptedHex}

You can now access the Faculty Dashboard after revealing your password. Please change your password after your first login.
${portalBits.text}
${COLLEGE_FOOTER_TEXT}`;
      htmlBody = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 560px;">
  <p>Hello Faculty Member,</p>
  <p>Your account for the AI Classroom Attention System has been successfully created.</p>
  <p>Your password is sent in <strong>encrypted form</strong> for security.</p>
  ${verifyBlockHtml}
  <p><strong>1)</strong> One-time link (valid 24 hours) — click to view your credentials now:</p>
  <p><a href="${escapeHtml(revealUrl)}">View my credentials</a></p>
  <p><strong>2)</strong> Encrypted credential (permanent). To view your password later, go to <a href="${escapeHtml(revealPageUrl)}">${escapeHtml(revealPageUrl)}</a> and paste the value below. If copy-paste fails, remove any spaces or line breaks — some email apps wrap long lines.</p>
  <p style="word-break: break-all; font-family: monospace; font-size: 11px; background: #f5f5f5; padding: 8px;">${escapeHtml(encryptedHex)}</p>
  <p>You can now access the Faculty Dashboard after revealing your password. Please change your password after your first login.</p>
  ${portalBits.html}
  ${footerWithLogo}
</body>
</html>`;
    }
  }

  const mailOptions = {
    from: process.env.FROM_EMAIL || process.env.SMTP_USER,
    to: email,
    subject,
    text: textBody,
    html: htmlBody,
  };
  const logoPath = publicPath('rec-logo.jpg');
  if (fs.existsSync(logoPath)) {
    mailOptions.attachments = [
      { filename: 'rec-logo.jpg', content: fs.readFileSync(logoPath), cid: 'rec-logo' },
    ];
  }

  try {
    await transporter.sendMail(mailOptions);
    console.log(`Login credentials email sent to ${role}:`, email);
    return true;
  } catch (err) {
    console.error(`Error sending ${role} login credentials email to ${email}:`, err);
    return false;
  }
}

/** Resolve student login email from register number (for OD approval notifications). */
function findStudentEmailByRegisterNumber(registerNumber) {
  const r = String(registerNumber || '').trim();
  if (!r) return null;
  for (const email of Object.keys(studentRegistrations)) {
    const entry = studentRegistrations[email];
    if (!entry || typeof entry !== 'object') continue;
    const reg = entry.registerNumber != null ? String(entry.registerNumber).trim() : '';
    if (reg === r) return email;
  }
  const synthetic = r + STUDENT_EMAIL_SUFFIX;
  if (studentRegistrations[synthetic]) return synthetic;
  return null;
}

/**
 * Email student when OD proof is fully approved (AHOD + HOD accepted). Uses configured SMTP.
 */
async function sendOdFullyApprovedStudentEmail(studentEmail, opts) {
  const to = String(studentEmail || '').trim().toLowerCase();
  if (!to || !smtpConfigured) {
    if (!smtpConfigured) console.log('OD approval email skipped: SMTP not configured.');
    return false;
  }
  const registerNumber = String(opts.registerNumber || '').trim();
  const topic = opts.topic ? String(opts.topic) : 'your class session';
  const subject = 'REC Classroom Attention — OD proof approved (AHOD & HOD)';
  const textBody = `Hello,

Your On Duty (OD) proof has been approved by the Assistant Head of Department and the Head of Department.

Register number: ${registerNumber}
Session / topic: ${topic}

Your faculty can now see the approved proof link and finalize your OD attendance in Smart Attendance.

This is an automated message from the AI Attention System.

${COLLEGE_FOOTER_TEXT}`;
  const footerHtml = `<div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid #eee; text-align: center; font-size: 12px; color: #555;"><img src="cid:rec-logo" alt="REC Logo" style="max-height: 60px; width: auto; margin-bottom: 10px;" /><br>${COLLEGE_FOOTER_HTML}</div>`;
  const htmlBody = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 560px;">
  <p>Hello,</p>
  <p>Your <strong>On Duty (OD)</strong> proof has been <strong>approved</strong> by the <strong>Assistant Head of Department</strong> and the <strong>Head of Department</strong>.</p>
  <p><strong>Register number:</strong> ${escapeHtml(registerNumber)}<br><strong>Session / topic:</strong> ${escapeHtml(topic)}</p>
  <p>Your faculty can now see the approved proof link and finalize your OD attendance in Smart Attendance.</p>
  <p style="font-size: 12px; color: #555;">This is an automated message from the AI Attention System.</p>
  ${footerHtml}</body></html>`;
  const mailOptions = {
    from: process.env.FROM_EMAIL || process.env.SMTP_USER,
    to,
    subject,
    text: textBody,
    html: htmlBody,
  };
  const logoPath = publicPath('rec-logo.jpg');
  if (fs.existsSync(logoPath)) {
    mailOptions.attachments = [{ filename: 'rec-logo.jpg', content: fs.readFileSync(logoPath), cid: 'rec-logo' }];
  }
  try {
    await transporter.sendMail(mailOptions);
    console.log('OD fully approved email sent to student:', to);
    return true;
  } catch (err) {
    console.error('Error sending OD approval email to student', err);
    return false;
  }
}

/** Assistant Head of Department (AHoD) designation matcher. */
function isAssistantHoDDesignation(designation) {
  const d = String(designation || '').trim().toLowerCase();
  if (d === 'ahod') return true;
  if (d.includes('assistant') && (d.includes('head of department') || d.includes('hod'))) return true;
  if ((d.includes('asst') || d.includes('assistant')) && d.includes('hod')) return true;
  return false;
}

/** Department Coordinator designation matcher. */
function isDepartmentCoordinatorDesignation(designation) {
  const d = String(designation || '').trim().toLowerCase();
  return d === 'department coordinator' || d.includes('department coordinator');
}

/** Head of Department designation matcher. */
function isHeadOfDepartmentDesignation(designation) {
  const d = String(designation || '').trim().toLowerCase();
  return (
    d === 'hod' ||
    d.includes('head of department') ||
    d.includes('head of the department')
  );
}

/**
 * Get leadership role label from designation (and department / staffId where needed).
 * Returns null if not a leadership designation.
 */
function getLeadershipCredentials(designationRaw, department, staffIdRaw) {
  const designation = String(designationRaw || '').trim().toLowerCase();
  const deptCode = String(department || '').trim().toLowerCase();
  const staffId = String(staffIdRaw || '').trim().toLowerCase();
  if (designation === 'principal') {
    return { roleLabel: 'Principal' };
  }
  if (designation === 'director' || designation === 'directors') {
    return { roleLabel: 'Director' };
  }
  if (isAssistantHoDDesignation(designationRaw)) {
    if (!deptCode) return null;
    return { roleLabel: `Asst. HoD – ${deptCode.toUpperCase()}` };
  }
  if (isDepartmentCoordinatorDesignation(designationRaw)) {
    if (!deptCode || !staffId) return null;
    return { roleLabel: `Dept. Coordinator – ${deptCode.toUpperCase()}` };
  }
  if (isHeadOfDepartmentDesignation(designationRaw)) {
    if (!deptCode) return null;
    return { roleLabel: `HoD – ${deptCode.toUpperCase()}` };
  }
  if (designation === 'vice principal' || designation === 'vp' || designation === 'vice-principal') {
    return { roleLabel: 'Vice Principal' };
  }
  if (
    designation === 'dean(studentaffairs)' ||
    designation === 'dean (studentaffairs)' ||
    designation === 'dean(student affairs)' ||
    designation === 'dean (student affairs)' ||
    designation === 'dean-studentaffairs' ||
    designation === 'dean studentaffairs' ||
    designation === 'dean sa'
  ) {
    return { roleLabel: 'Dean (Student Affairs)' };
  }
  if (designation === 'dean' || designation.includes('dean')) {
    if (!staffId) return null;
    const roleLabel =
      designation.includes('academics')
        ? 'Dean (Academics)'
        : (designation.includes('department') ? 'Dean (Department)' : 'Dean');
    return { roleLabel };
  }
  return null;
}

/**
 * Send login credentials for Leadership Dashboard via SMTP (same pattern as student/faculty).
 * Called when a faculty registers with a leadership designation (Principal, Director, HoD, Vice Principal).
 */
async function sendLeadershipLoginEmail(email, username, password, roleLabel, baseUrlOverride) {
  if (!smtpConfigured) {
    console.log('Leadership login credentials email skipped: SMTP not configured.');
    return false;
  }
  const baseUrl =
    baseUrlOverride ||
    normalizeEmailBaseUrl(process.env.PUBLIC_BASE_URL) ||
    normalizeEmailBaseUrl(process.env.SERVER_URL) ||
    `http://localhost:${PORT}`;
  warnIfLocalhostEmailLinks(baseUrl, 'Leadership login links');
  const loginUrl = `${baseUrl}/leadership-login`;
  const portalBits = accessPortalEmailSnippet(baseUrl);
  const subject = 'Login Credentials for Leadership Dashboard';
  const textBody = `Hello,

Your Leadership Dashboard account is ready.

Login Details (Leadership Dashboard):

Login URL: ${loginUrl}
Username: ${username}
Password: ${password}
Role: ${roleLabel}

You can access the Leadership Dashboard (REC Insight) at the link above. Use the same official @rajalakshmi.edu.in email and the password above.
${portalBits.text}
${COLLEGE_FOOTER_TEXT}`;

  const footerWithLogo = `
  <div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid #eee; text-align: center; font-size: 12px; color: #555;">
    <img src="cid:rec-logo" alt="REC Logo" style="max-height: 60px; width: auto; margin-bottom: 10px;" /><br>
    ${COLLEGE_FOOTER_HTML}
  </div>`;
  const htmlBody = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 560px;">
  <p>Hello,</p>
  <p>Your Leadership Dashboard account is ready.</p>
  <p><strong>Login Details (Leadership Dashboard):</strong></p>
  <p>Login URL: <a href="${escapeHtml(loginUrl)}">${escapeHtml(loginUrl)}</a><br>
  Username: ${escapeHtml(username)}<br>
  Password: ${escapeHtml(password)}<br>
  Role: ${escapeHtml(roleLabel)}</p>
  <p>You can access the Leadership Dashboard (REC Insight) at the link above. Use the same official @rajalakshmi.edu.in email and the password above.</p>
  ${portalBits.html}
  ${footerWithLogo}
</body></html>`;

  const mailOptions = {
    from: process.env.FROM_EMAIL || process.env.SMTP_USER,
    to: email,
    subject,
    text: textBody,
    html: htmlBody,
  };
  const logoPath = publicPath('rec-logo.jpg');
  const logoPathAlt = publicPath('rajalakshmi_engineering_college_logo.jpg');
  const logoFile = fs.existsSync(logoPath) ? logoPath : fs.existsSync(logoPathAlt) ? logoPathAlt : null;
  if (logoFile) {
    mailOptions.attachments = [
      { filename: 'rec-logo.jpg', content: fs.readFileSync(logoFile), cid: 'rec-logo' },
    ];
  }

  try {
    await transporter.sendMail(mailOptions);
    console.log('Leadership login credentials email sent to:', email);
    return true;
  } catch (err) {
    console.error('Error sending leadership login credentials email to', email, err);
    return false;
  }
}

/** Characters used for emailed 6-digit verification codes (no I, O, 0, 1). */
const VERIFICATION_EMAIL_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Six-character code derived from the verification token; stored on the account for code-based verify. */
function verificationEmailDisplayCode(token) {
  const buf = crypto.createHash('sha256').update(String(token), 'utf8').digest();
  let out = '';
  const n = VERIFICATION_EMAIL_CODE_ALPHABET.length;
  for (let i = 0; i < 6; i += 1) out += VERIFICATION_EMAIL_CODE_ALPHABET[buf[i] % n];
  return out;
}

function normalizeVerificationCodeInput(raw) {
  const u = String(raw || '').toUpperCase().replace(/[^A-Z2-9]/g, '');
  const allowed = new Set([...VERIFICATION_EMAIL_CODE_ALPHABET]);
  const clean = [...u].filter((c) => allowed.has(c)).join('');
  if (clean.length !== 6) return null;
  return clean;
}

/** Twilio-style panel: headline, verification code block, optional IP line, verification link (no button). */
function emailVerificationTwilioPanelHtml(verifyUrl, displayCode, clientIp, verifyCodePageUrl) {
  const u = escapeHtml(verifyUrl);
  const code = escapeHtml(displayCode);
  const ipLine = clientIp
    ? `<p style="margin:20px 0 0;font-size:12px;line-height:1.5;color:#9ca3af;">The request for this verification originated from IP address <span style="word-break:break-all;">${escapeHtml(String(clientIp))}</span></p>`
    : '';
  const btnBlock = `
  <div style="margin:24px 0 0;padding:3px;border-radius:16px;background:linear-gradient(90deg,#22c55e,#06b6d4,#a855f7,#22c55e);">
    <div style="border-radius:14px;background:#f0fdf4;padding:18px 16px;text-align:center;border:1px solid rgba(34,197,94,0.35);">
      <p style="margin:0 0 12px;font-size:12px;line-height:1.5;color:#166534;">Open this link in your browser to confirm your email address:</p>
      <p style="margin:0;font-size:12px;line-height:1.45;color:#4b5563;word-break:break-all;"><a href="${u}" style="color:#2563eb;font-weight:700;">${u}</a></p>
    </div>
  </div>`;
  return `
  <h1 style="margin:0 0 12px;font-size:22px;font-weight:600;color:#111827;letter-spacing:-0.02em;">Verify your email address</h1>
  <p style="margin:0 0 18px;font-size:15px;line-height:1.55;color:#374151;">You need to verify your email address to continue using your REC dashboard account. Enter the following code to verify your email address:</p>
  <div style="font-size:26px;font-weight:700;letter-spacing:8px;font-family:ui-monospace,SFMono-Regular,Consolas,'Liberation Mono',Menlo,monospace;color:#111827;padding:18px 14px;background:#f3f4f6;border:1px solid #e5e7eb;border-radius:10px;text-align:center;">${code}</div>
  ${ipLine}
  ${btnBlock}
  <p style="margin:16px 0 0;font-size:12px;line-height:1.5;color:#374151;">You can also open <a href="${escapeHtml(verifyCodePageUrl)}" style="color:#2563eb;font-weight:600;">the verification page</a> and enter the code above.</p>
  <p style="margin:18px 0 0;font-size:12px;line-height:1.5;color:#6b7280;">If you were not registering for the REC dashboard, change your password after signing in, review your account settings, or contact college IT support.</p>`;
}

/**
 * Module 1: Send username and password via Gmail (SMTP) for both faculty and students.
 * Twilio-style verification section (logo + code + CTA) plus login summary.
 * Optional clientIp: shown in the message when provided (registration request).
 */
async function sendVerificationEmail(email, username, password, token, role, baseUrlOverride, clientIp) {
  if (!smtpConfigured) {
    console.log('Verification email skipped: SMTP not configured. Set SMTP_USER and SMTP_PASS in .env for Gmail.');
    return false;
  }
  const baseUrl =
    baseUrlOverride ||
    normalizeEmailBaseUrl(process.env.PUBLIC_BASE_URL) ||
    normalizeEmailBaseUrl(process.env.SERVER_URL) ||
    `http://localhost:${PORT}`;
  warnIfLocalhostEmailLinks(baseUrl, 'Verification links');
  const verifyUrl = `${baseUrl}/verify-email?token=${encodeURIComponent(token)}`;
  const displayCode = verificationEmailDisplayCode(token);
  const portalBits = accessPortalEmailSnippet(baseUrl);
  const isStudent = role === 'student';
  const subject = 'Verify your email address | Rajalakshmi Engineering College';
  const ipPlain = clientIp ? `\n\nThe request for this verification originated from IP address: ${clientIp}` : '';
  const textBody = isStudent
    ? `Rajalakshmi Engineering College (An Autonomous Institution)

Verify your email address

You need to verify your email address to continue using your REC dashboard account.

Your verification code: ${displayCode}

Open this link to verify (required to activate your account):
${verifyUrl}${ipPlain}

Or go to: ${String(baseUrl).replace(/\/$/, '')}/verify-email-code.html
and enter your 6-character code.

If you were not registering for the REC dashboard, change your password after signing in, review your account settings, or contact college IT support.

---

Your account for the AI Classroom Attention System has been created.

Login details (save these):
Username: ${username}
Password: Sent separately in encrypted form by email.

${portalBits.text}

${COLLEGE_FOOTER_TEXT}`
    : `Rajalakshmi Engineering College (An Autonomous Institution)

Verify your email address

You need to verify your email address to continue using your REC dashboard account.

Your verification code: ${displayCode}

Open this link to verify (required to activate your account):
${verifyUrl}${ipPlain}

Or go to: ${String(baseUrl).replace(/\/$/, '')}/verify-email-code.html
and enter your 6-character code.

If you were not registering for the REC dashboard, change your password after signing in, review your account settings, or contact college IT support.

---

Your Faculty Dashboard account has been created.

Login details (save these):
Username: ${username}
Password: Sent separately in encrypted form by email.

Please change your password after you sign in.

${portalBits.text}

${COLLEGE_FOOTER_TEXT}`;

  const logoPath = publicPath('rec-logo.jpg');
  const logoPathAlt = publicPath('rajalakshmi_engineering_college_logo.jpg');
  const logoFile = fs.existsSync(logoPath) ? logoPath : fs.existsSync(logoPathAlt) ? logoPathAlt : null;
  const headerLogoHtml = logoFile
    ? '<img src="cid:rec-logo" alt="Rajalakshmi Engineering College" style="max-height:56px;width:auto;display:block;margin:0 auto 12px;" />'
    : '';
  const introHtml = isStudent
    ? `<p style="margin:0 0 8px;font-size:15px;line-height:1.5;color:#374151;">Hello,</p><p style="margin:0 0 22px;font-size:15px;line-height:1.55;color:#374151;">Your account for the <strong>AI Classroom Attention System</strong> has been created.</p>`
    : `<p style="margin:0 0 8px;font-size:15px;line-height:1.5;color:#374151;">Hello,</p><p style="margin:0 0 22px;font-size:15px;line-height:1.55;color:#374151;">Your <strong>Faculty Dashboard</strong> account has been created. Please change your password after you sign in.</p>`;
  const accountBlock = `
  <hr style="border:none;border-top:1px solid #e5e7eb;margin:28px 0 22px;">
  <p style="margin:0 0 10px;font-size:14px;font-weight:700;color:#111827;">Your login details (save these)</p>
  <p style="margin:0;font-size:14px;line-height:1.65;color:#374151;">Username: <strong>${escapeHtml(username)}</strong><br>Password: <strong>Sent separately in encrypted form by email.</strong></p>`;
  const footerBlock = `
  <div style="padding:20px 24px;background:#fafafa;border-top:1px solid #ececec;text-align:center;font-size:12px;line-height:1.55;color:#6b7280;">
    ${COLLEGE_FOOTER_HTML}
  </div>`;
  const verifyCodePageUrl = `${String(baseUrl).replace(/\/$/, '')}/verify-email-code.html`;
  const panelHtml = emailVerificationTwilioPanelHtml(verifyUrl, displayCode, clientIp, verifyCodePageUrl);
  const htmlBody = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="margin:0;background:#eceff1;font-family:Arial,Helvetica,sans-serif;line-height:1.5;color:#333;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eceff1;padding:28px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" style="max-width:520px;background:#ffffff;border-radius:10px;border:1px solid #e5e7eb;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.06);">
<tr><td style="padding:22px 24px 18px;text-align:center;background:#fafafa;border-bottom:1px solid #ececec;">
  ${headerLogoHtml}
  <div style="font-size:15px;font-weight:700;color:#1f2937;line-height:1.35;">Rajalakshmi Engineering College</div>
  <div style="font-size:12px;font-weight:600;color:#6b7280;margin-top:4px;">(An Autonomous Institution)</div>
</td></tr>
<tr><td style="padding:26px 24px 8px;">
  ${introHtml}
  ${panelHtml}
  ${accountBlock}
  ${portalBits.html}
</td></tr>
<tr><td style="padding:0;">
  ${footerBlock}
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;

  const mailOptions = {
    from: process.env.FROM_EMAIL || process.env.SMTP_USER,
    to: email,
    subject,
    text: textBody,
    html: htmlBody,
  };
  if (logoFile) {
    mailOptions.attachments = [
      { filename: 'rec-logo.jpg', content: fs.readFileSync(logoFile), cid: 'rec-logo' },
    ];
  }

  try {
    await transporter.sendMail(mailOptions);
    console.log(`Verification + login summary email sent to ${role}:`, email);
    return true;
  } catch (err) {
    console.error(`Error sending verification email to ${email}:`, err);
    return false;
  }
}

/**
 * Module 2: Send security alert when login from new device or IP.
 */
async function sendSecurityAlertEmail(email, device, ip) {
  if (!smtpConfigured) {
    console.log('Security alert email skipped: SMTP not configured.');
    return false;
  }
  const subject = 'Security Alert – REC Dashboard';
  const textBody = `Hello,

A login to your account was detected from a new device.

Device: ${device}
IP Address: ${ip}

If this was not you, please reset your password immediately.

${COLLEGE_FOOTER_TEXT}`;

  const footerWithLogo = `
  <div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid #eee; text-align: center; font-size: 12px; color: #555;">
    <img src="cid:rec-logo" alt="REC Logo" style="max-height: 60px; width: auto; margin-bottom: 10px;" /><br>
    ${COLLEGE_FOOTER_HTML}
  </div>`;

  try {
    const logoPath = publicPath('rec-logo.jpg');
    const logoPathAlt = publicPath('rajalakshmi_engineering_college_logo.jpg');
    const logoFile = fs.existsSync(logoPath) ? logoPath : fs.existsSync(logoPathAlt) ? logoPathAlt : null;

    const mailOptions = {
      from: process.env.FROM_EMAIL || process.env.SMTP_USER,
      to: email,
      subject,
      text: textBody,
      html: `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 560px;"><p>Hello,</p><p>A login to your account was detected from a new device.</p><p><strong>Device:</strong> ${escapeHtml(device)}<br><strong>IP Address:</strong> ${escapeHtml(ip)}</p><p>If this was not you, please reset your password immediately.</p>${footerWithLogo}</body></html>`,
    };
    if (logoFile) {
      mailOptions.attachments = [
        { filename: 'rec-logo.jpg', content: fs.readFileSync(logoFile), cid: 'rec-logo' },
      ];
    }

    await transporter.sendMail(mailOptions);
    console.log('Security alert email sent to:', email);
    return true;
  } catch (err) {
    console.error('Error sending security alert email:', err);
    return false;
  }
}

function generateNumericOtp() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function maskEmailForUi(email) {
  const value = String(email || '').trim().toLowerCase();
  const at = value.indexOf('@');
  if (at <= 1) return value;
  const name = value.slice(0, at);
  const domain = value.slice(at + 1);
  const safeName = name.length <= 2 ? (name[0] + '*') : (name[0] + '*'.repeat(Math.max(1, name.length - 2)) + name[name.length - 1]);
  return `${safeName}@${domain}`;
}

async function sendLoginOtpEmail(email, otp, role) {
  if (!smtpConfigured) return false;
  const roleLabel = role === 'student' ? 'Student' : role === 'leadership' ? 'Leadership' : 'Faculty';
  const expiryMinutes = Math.max(1, Math.round(LOGIN_OTP_EXPIRY_MS / 60000));
  // Keep help-center link reachable even when old PUBLIC_BASE_URL IPs become stale.
  // Priority: explicit HELP_CENTER_URL > explicit HTTPS URL > live detected LAN URL > localhost.
  const helpCenterBase = String(
    process.env.HELP_CENTER_URL
      || process.env.PUBLIC_HTTPS_URL
      || process.env.HTTPS_BASE_URL
      || dynamicLanBaseUrl()
      || `http://localhost:${PORT}`
  ).trim();
  const helpCenterUrl = (helpCenterBase.replace(/\/+$/, '') || `http://localhost:${PORT}`) + '/frequently-asked-questions';
  const subject = 'Your authentication code';
  const textBody = `Your authentication code for REC ${roleLabel} dashboard login:

${otp}

This code expires in ${expiryMinutes} minute${expiryMinutes === 1 ? '' : 's'}.
Do not share this code with anyone.
If you have any questions please contact us through our help center:
${helpCenterUrl}

Rajalakshmi Engineering College ( An Autonomous Institution)`;
  const footerWithLogo = `
  <div style="margin-top: 26px; padding-top: 14px; border-top: 1px solid #e5e7eb; text-align: center;">
    <img src="cid:rec-logo" alt="REC Logo" style="max-height: 54px; width: auto; margin-bottom: 8px;" />
    <div style="font-size: 12px; color: #4b5563;">Rajalakshmi Engineering College ( An Autonomous Institution)</div>
  </div>`;
  const htmlBody = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="font-family: Arial, sans-serif; line-height: 1.55; color: #1f2937; max-width: 560px; margin: 0 auto; padding: 12px 8px;">
    <h2 style="margin: 0 0 14px; font-size: 32px; letter-spacing: -0.01em; color: #111827;">Your authentication code</h2>
    <p style="margin: 0 0 10px;">Please use the following code to help verify your identity for <strong>${escapeHtml(roleLabel)}</strong> dashboard login:</p>
    <div style="display: inline-block; margin: 6px 0 14px; padding: 10px 16px; border-radius: 8px; border: 1px solid #d1d5db; background: #f9fafb;">
      <span style="font-size: 30px; letter-spacing: 6px; font-weight: 700; color: #111827;">${escapeHtml(otp)}</span>
    </div>
    <p style="margin: 0 0 4px; color: #4b5563; font-size: 13px;">This code expires in ${expiryMinutes} minute${expiryMinutes === 1 ? '' : 's'}.</p>
    <p style="margin: 0 0 10px; color: #4b5563; font-size: 13px;">Do not share this code with anyone.</p>
    <p style="margin: 0 0 10px; color: #4b5563; font-size: 13px;">If you have any questions please contact us through our <a href="${escapeHtml(helpCenterUrl)}" style="color:#2563eb;text-decoration:underline;">help center</a>.</p>
    ${footerWithLogo}
  </body></html>`;
  const mailOptions = {
    from: process.env.FROM_EMAIL || process.env.SMTP_USER,
    to: email,
    subject,
    text: textBody,
    html: htmlBody,
  };
  const logoPath = publicPath('rec-logo.jpg');
  if (fs.existsSync(logoPath)) {
    mailOptions.attachments = [{ filename: 'rec-logo.jpg', content: fs.readFileSync(logoPath), cid: 'rec-logo' }];
  }
  try {
    const info = await transporter.sendMail(mailOptions);
    const accepted = Array.isArray(info && info.accepted) ? info.accepted : [];
    const rejected = Array.isArray(info && info.rejected) ? info.rejected : [];
    if (!accepted.length || rejected.length) {
      console.error(
        `Login OTP delivery issue for ${String(email || '').trim().toLowerCase()} (${roleLabel}). accepted=${JSON.stringify(accepted)} rejected=${JSON.stringify(rejected)} response=${info && info.response ? info.response : ''}`
      );
      return false;
    }
    console.log(
      `Login OTP email sent to ${String(email || '').trim().toLowerCase()} (${roleLabel}). messageId=${info && info.messageId ? info.messageId : '-'} accepted=${accepted.join(',')}`
    );
    return true;
  } catch (err) {
    console.error(`Error sending login OTP email to ${String(email || '').trim().toLowerCase()} (${roleLabel}):`, err && err.message ? err.message : err);
    return false;
  }
}

async function issueLoginOtpChallenge(role, email, sessionData, meta) {
  if (!smtpConfigured) {
    return {
      ok: false,
      status: 503,
      message: 'OTP login requires SMTP to be configured.',
    };
  }

  const otp = generateNumericOtp();
  const showDebugOtp = process.env.NODE_ENV !== 'production' || process.env.ALLOW_OTP_DEBUG === 'true';
  const sentEmail = await sendLoginOtpEmail(email, otp, role);
  if (!sentEmail) {
    return { ok: false, status: 500, message: 'Unable to send OTP email. Please try again.' };
  }

  const challengeId = crypto.randomBytes(24).toString('hex');
  loginOtpChallenges[challengeId] = {
    role,
    email: String(email).trim().toLowerCase(),
    otpHash: hashToken(otp),
    exp: Date.now() + LOGIN_OTP_EXPIRY_MS,
    attempts: 0,
    lastOtpSentAt: Date.now(),
    sessionData: sessionData && typeof sessionData === 'object' ? sessionData : {},
    meta: meta && typeof meta === 'object' ? meta : {},
  };

  const emailPart = maskEmailForUi(email);
  return {
    ok: true,
    otpRequired: true,
    challengeId,
    message: `OTP sent to ${emailPart}. Enter the 6-digit OTP to continue.`,
    sentTo: emailPart,
    otpChannel: 'email',
    debugOtp: showDebugOtp ? otp : undefined,
  };
}

function verifyLoginOtpChallenge(role, challengeId, otp) {
  const id = String(challengeId || '').trim();
  const code = String(otp || '').replace(/[^\d]/g, '');
  if (!id || !code) return { ok: false, status: 400, message: 'OTP and challenge ID are required.' };
  if (code.length !== 6) return { ok: false, status: 400, message: 'Enter a valid 6-digit OTP.' };
  const entry = loginOtpChallenges[id];
  if (!entry || entry.role !== role) {
    return { ok: false, status: 400, message: 'Invalid OTP challenge.' };
  }
  if (Date.now() > entry.exp) {
    delete loginOtpChallenges[id];
    return { ok: false, status: 400, message: 'OTP expired. Please login again.' };
  }
  entry.attempts = Number(entry.attempts || 0) + 1;
  if (entry.attempts > LOGIN_OTP_MAX_ATTEMPTS) {
    delete loginOtpChallenges[id];
    return { ok: false, status: 429, message: 'Too many OTP attempts. Please login again.' };
  }
  if (hashToken(code) !== entry.otpHash) {
    return { ok: false, status: 401, message: 'Invalid OTP.' };
  }
  delete loginOtpChallenges[id];
  return { ok: true, entry };
}

async function resendLoginOtpChallenge(role, challengeId) {
  const id = String(challengeId || '').trim();
  if (!id) return { ok: false, status: 400, message: 'Challenge ID is required.' };
  const entry = loginOtpChallenges[id];
  if (!entry || entry.role !== role) {
    return { ok: false, status: 400, message: 'Invalid or expired login session. Please sign in again.' };
  }
  if (Date.now() > entry.exp) {
    delete loginOtpChallenges[id];
    return { ok: false, status: 400, message: 'OTP expired. Please sign in again.' };
  }
  const lastSent = Number(entry.lastOtpSentAt || 0);
  if (lastSent && Date.now() - lastSent < LOGIN_OTP_RESEND_COOLDOWN_MS) {
    const waitSec = Math.ceil((LOGIN_OTP_RESEND_COOLDOWN_MS - (Date.now() - lastSent)) / 1000);
    return { ok: false, status: 429, message: `Please wait ${waitSec}s before requesting another OTP.` };
  }

  if (!smtpConfigured) {
    return { ok: false, status: 503, message: 'OTP resend requires SMTP configuration.' };
  }
  const otp = generateNumericOtp();
  const sent = await sendLoginOtpEmail(entry.email, otp, role);
  if (!sent) {
    return { ok: false, status: 500, message: 'Unable to resend OTP email. Please try again.' };
  }
  entry.otpHash = hashToken(otp);
  entry.exp = Date.now() + LOGIN_OTP_EXPIRY_MS;
  entry.attempts = 0;
  entry.lastOtpSentAt = Date.now();
  return {
    ok: true,
    message: 'A new OTP has been sent to your email.',
  };
}

function verifyGoogleIdTokenWithGoogle(idToken) {
  return new Promise((resolve, reject) => {
    const token = String(idToken || '').trim();
    if (!token) return reject(new Error('Missing Google token.'));
    const req = https.request(
      {
        hostname: 'oauth2.googleapis.com',
        path: `/tokeninfo?id_token=${encodeURIComponent(token)}`,
        method: 'GET',
        timeout: 10000,
      },
      (resp) => {
        let body = '';
        resp.on('data', (ch) => { body += ch; });
        resp.on('end', () => {
          if (resp.statusCode < 200 || resp.statusCode >= 300) {
            return reject(new Error('Google token validation failed.'));
          }
          let data;
          try {
            data = JSON.parse(body || '{}');
          } catch (_) {
            return reject(new Error('Invalid response from Google token endpoint.'));
          }
          if (!data || !data.email || data.email_verified !== 'true') {
            return reject(new Error('Google account email is not verified.'));
          }
          if (GOOGLE_CLIENT_ID && String(data.aud || '') !== GOOGLE_CLIENT_ID) {
            return reject(new Error('Google token audience mismatch.'));
          }
          resolve({
            email: String(data.email).trim().toLowerCase(),
            hostedDomain: String(data.hd || '').trim().toLowerCase(),
          });
        });
      }
    );
    req.on('error', (err) => reject(err));
    req.on('timeout', () => req.destroy(new Error('Google token verification timed out.')));
    req.end();
  });
}

function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Normalize public site base URL (no trailing slash). */
function normalizeEmailBaseUrl(u) {
  const s = String(u || '').trim();
  if (!s) return null;
  const out = s.replace(/\/$/, '');
  try {
    const host = new URL(out).hostname;
    // Auto-replace stale hardcoded host with current LAN base.
    if (host === '100.114.181.81') {
      const dyn = dynamicLanBaseUrl();
      if (dyn) return dyn;
    }
  } catch (_) {
    // Keep original string if it is not a fully qualified URL.
  }
  return out;
}

function isPrivateOrCarrierGradeIp(hostname) {
  const h = String(hostname || '').trim();
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(h)) return false;
  const p = h.split('.').map((x) => Number(x));
  if (p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false;
  // RFC1918 + CGNAT 100.64.0.0/10
  if (p[0] === 10) return true;
  if (p[0] === 192 && p[1] === 168) return true;
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
  if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;
  return false;
}

function detectPrimaryLanIpv4() {
  const nets = os.networkInterfaces ? os.networkInterfaces() : {};
  const preferred = [];
  const fallback = [];
  for (const [name, rows] of Object.entries(nets || {})) {
    const n = String(name || '').toLowerCase();
    const looksVirtual =
      n.includes('virtual') || n.includes('vmware') || n.includes('vbox') || n.includes('hyper-v') || n.includes('loopback');
    if (looksVirtual) continue;
    for (const row of rows || []) {
      if (!row || row.internal) continue;
      const family = String(row.family || '').toLowerCase();
      if (!(family === 'ipv4' || row.family === 4)) continue;
      const ip = String(row.address || '').trim();
      if (!ip || ip.startsWith('169.254.')) continue;
      if (isPrivateOrCarrierGradeIp(ip)) preferred.push(ip);
      else fallback.push(ip);
    }
  }
  return preferred[0] || fallback[0] || null;
}

function dynamicLanBaseUrl() {
  const ip = detectPrimaryLanIpv4();
  if (!ip) return null;
  if (httpsServer && httpsPort) return `https://${ip}:${httpsPort}`;
  return `http://${ip}:${PORT}`;
}

/**
 * Base URL for verification + credential links in outbound email.
 * Prefer PUBLIC_BASE_URL or SERVER_URL; if the registration request used localhost,
 * fall back to PUBLIC_HTTPS_URL / HTTPS_BASE_URL so phone/Gmail clients can open links.
 */
function revealLinksBaseUrl(req) {
  const explicit =
    normalizeEmailBaseUrl(process.env.PUBLIC_BASE_URL) ||
    normalizeEmailBaseUrl(process.env.SERVER_URL);
  if (explicit) return explicit;

  const xfHost = (req.headers['x-forwarded-host'] || '').split(',')[0].trim();
  const hostHeader = xfHost || (typeof req.get === 'function' ? req.get('host') : '') || '';
  const isLocalHost =
    !hostHeader ||
    /^localhost(:\d+)?$/i.test(hostHeader) ||
    /^127\.0\.0\.1(:\d+)?$/.test(hostHeader);

  if (isLocalHost) {
    const httpsLan =
      normalizeEmailBaseUrl(process.env.PUBLIC_HTTPS_URL) ||
      normalizeEmailBaseUrl(process.env.HTTPS_BASE_URL);
    if (httpsLan) return httpsLan;
    const dyn = dynamicLanBaseUrl();
    if (dyn) return dyn;
  }

  const xfProto = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const proto = xfProto || (req.protocol || 'http');
  const host = hostHeader || `localhost:${PORT}`;
  return `${proto}://${host}`;
}

/** Gmail and other clients may wrap hex lines; strip whitespace before decrypt. */
function normalizeEncryptedCredentialInput(raw) {
  return String(raw || '').replace(/[\s\r\n]+/g, '').trim();
}

function warnIfLocalhostEmailLinks(baseUrl, contextLabel) {
  try {
    const h = new URL(baseUrl).hostname;
    if (h === 'localhost' || h === '127.0.0.1') {
      console.warn(
        `[email] ${contextLabel || 'Links'} use ${baseUrl} — other devices cannot open localhost. Set PUBLIC_BASE_URL (or SERVER_URL) or PUBLIC_HTTPS_URL in .env, or register while using your LAN/HTTPS URL.`
      );
    }
  } catch (_) {
    // ignore
  }
}

/**
 * Primary + optional HTTPS portal URLs for emails and portal page hints.
 * Set PUBLIC_HTTPS_URL in .env (e.g. https://192.168.1.5:3443) for phone camera access.
 */
function resolvePortalUrls(baseUrlOverride) {
  const primary =
    normalizeEmailBaseUrl(baseUrlOverride)
    || normalizeEmailBaseUrl(process.env.PUBLIC_BASE_URL)
    || normalizeEmailBaseUrl(process.env.SERVER_URL)
    || `http://localhost:${PORT}`;
  const portalPrimary = `${primary}/portal`;
  let httpsPortal = '';
  const envHttps = normalizeEmailBaseUrl(process.env.PUBLIC_HTTPS_URL || process.env.HTTPS_BASE_URL || '');
  if (envHttps) {
    httpsPortal = `${envHttps}/portal`;
  } else {
    try {
      const u = new URL(primary);
      if (u.protocol === 'http:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') {
        u.protocol = 'https:';
        const p = u.port;
        if (!p || p === '80' || p === '3000') u.port = '3443';
        httpsPortal = `${u.origin}/portal`;
      }
    } catch (_) {
      // ignore
    }
  }
  return { primary, portalPrimary, httpsPortal };
}

/** HTML + plain-text block: “Access portal” for registration / credential emails. */
function accessPortalEmailSnippet(baseUrlOverride) {
  const { portalPrimary, httpsPortal } = resolvePortalUrls(baseUrlOverride);
  const text = [
    '',
    '--- Access portal (open this first if a direct link fails; it picks the correct server address) ---',
    portalPrimary,
    httpsPortal ? `HTTPS portal (phones / student camera): ${httpsPortal}` : '',
    '',
  ]
    .filter((line) => line !== '')
    .join('\n');
  const html = `
  <div style="margin:22px 0;padding:3px;border-radius:16px;background:linear-gradient(90deg,#d946ef,#06b6d4,#facc15,#a855f7,#d946ef);">
    <div style="border-radius:14px;background:#faf8ff;padding:18px 16px;text-align:center;border:1px solid rgba(147,51,234,0.35);">
      <p style="margin:0 0 14px;font-size:14px;font-weight:800;color:#24135f;">Access portal — Student, Faculty &amp; Leadership</p>
      <a href="${escapeHtml(portalPrimary)}" style="display:inline-block;padding:14px 32px;font-weight:800;font-size:15px;color:#ffffff !important;text-decoration:none;border-radius:999px;background:linear-gradient(120deg,#5c2eb8,#24135f);border:2px solid #c026d3;letter-spacing:0.02em;box-shadow:0 0 18px rgba(192,38,211,0.55),0 0 36px rgba(6,182,212,0.35),inset 0 1px 0 rgba(255,255,255,0.25);text-shadow:0 0 12px rgba(255,255,255,0.5);">Open access portal</a>
      ${httpsPortal ? `<p style="margin:14px 0 0;font-size:12px;line-height:1.45;color:#4b5563;">HTTPS (recommended on phones for student camera):<br><a href="${escapeHtml(httpsPortal)}" style="color:#2563eb;font-weight:700;">${escapeHtml(httpsPortal)}</a></p>` : ''}
    </div>
  </div>`;
  return { text, html };
}

/** Green-bordered verification block with link only (no button — better for strict email clients). */
function emailVerifyEmailCtaHtml(verifyUrl) {
  const u = escapeHtml(verifyUrl);
  return `
  <div style="margin:22px 0;padding:3px;border-radius:16px;background:linear-gradient(90deg,#22c55e,#06b6d4,#a855f7,#22c55e);">
    <div style="border-radius:14px;background:#f0fdf4;padding:18px 16px;text-align:center;border:1px solid rgba(34,197,94,0.35);">
      <p style="margin:0 0 14px;font-size:14px;font-weight:800;color:#14532d;">Verify your college email</p>
      <p style="margin:0 0 12px;font-size:12px;line-height:1.5;color:#166534;">Open the link below to confirm your address. You must verify before you can sign in.</p>
      <p style="margin:0;font-size:12px;line-height:1.45;color:#4b5563;word-break:break-all;"><a href="${u}" style="color:#2563eb;font-weight:700;">${u}</a></p>
    </div>
  </div>`;
}

/** Normalize mobile to E.164 for storage on user records (no SMS provider). */
function normalizeMobileForSms(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (s.startsWith('+')) {
    const d = s.slice(1).replace(/\D/g, '');
    if (d.length >= 10 && d.length <= 15) return `+${d}`;
    return null;
  }
  const only = s.replace(/\D/g, '');
  const cc = String(process.env.SMS_DEFAULT_COUNTRY_CODE || '91').replace(/\D/g, '') || '91';
  if (only.length === 10) return `+${cc}${only}`;
  if (only.length >= 11 && only.length <= 15) return `+${only}`;
  return null;
}

function buildStaffPhonePassword(staffIdRaw, mobileRaw) {
  const staffId = String(staffIdRaw || '').trim();
  const phoneDigits = String(mobileRaw || '').replace(/\D/g, '');
  return `${staffId}${phoneDigits}`;
}

function parseSendLoginEmailOptions(sixth) {
  let emailContext = 'registration';
  let verifyUrl = null;
  if (typeof sixth === 'string' && sixth) {
    emailContext = sixth;
  } else if (sixth && typeof sixth === 'object') {
    if (sixth.emailContext) emailContext = String(sixth.emailContext);
    if (sixth.verifyUrl) verifyUrl = String(sixth.verifyUrl).trim();
  }
  return { emailContext, verifyUrl };
}

// Fire-and-forget helper so HTTP responses are not blocked by SMTP latency.
function runBackgroundTask(taskLabel, task) {
  Promise.resolve()
    .then(task)
    .catch((err) => {
      console.error(`${taskLabel} failed:`, err);
    });
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Security headers to prevent XSS, clickjacking, MIME sniffing (strong encryption posture)
app.use(helmet({
  contentSecurityPolicy: false, // allow inline scripts for existing frontend; tighten in production if needed
  crossOriginEmbedderPolicy: false,
}));

// Allow camera and microphone in Student, Faculty, and Leadership dashboards (same origin and when embedded from other origins)
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self)');
  next();
});

// Rate limiting: prevent brute-force and abuse (limits per IP)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30, // max requests per window per IP for auth routes
  message: { ok: false, message: 'Too many attempts. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/login', authLimiter);
app.use('/api/student-login', authLimiter);
app.use('/api/register', authLimiter);
app.use('/api/student-register', authLimiter);
app.use('/api/leadership-login', authLimiter);
app.use('/verify-email', rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false }));
app.use(
  '/api/verify-email-code',
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 40,
    message: { ok: false, message: 'Too many attempts. Try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
  }),
);

// Extra hardening for sensitive endpoints (brute-force prevention).
const strictAuthLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 12,
  message: { ok: false, message: 'Too many sensitive requests. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/login/verify-otp', strictAuthLimiter);
app.use('/api/student-login/verify-otp', strictAuthLimiter);
app.use('/api/leadership-login/verify-otp', strictAuthLimiter);
app.use('/api/login/resend-otp', strictAuthLimiter);
app.use('/api/student-login/resend-otp', strictAuthLimiter);
app.use('/api/leadership-login/resend-otp', strictAuthLimiter);
app.use('/api/change-password', strictAuthLimiter);
app.use('/api/student-change-password', strictAuthLimiter);
app.use('/api/firewall/login', strictAuthLimiter);

function isTrustedRequestOrigin(req) {
  const origin = String(req.headers.origin || '').trim();
  if (!origin) return true; // allow tools/native clients that don't send Origin
  const host = String(req.headers.host || '').trim().toLowerCase();
  if (!host) return false;
  const normalizedOrigin = origin.toLowerCase();
  if (normalizedOrigin === `http://${host}` || normalizedOrigin === `https://${host}`) return true;
  if (normalizedOrigin.startsWith('http://localhost:') || normalizedOrigin.startsWith('https://localhost:')) return true;
  if (normalizedOrigin.startsWith('http://127.0.0.1:') || normalizedOrigin.startsWith('https://127.0.0.1:')) return true;
  return false;
}

// CSRF-style guard for state-changing API calls.
app.use((req, res, next) => {
  const method = String(req.method || 'GET').toUpperCase();
  if (!String(req.path || '').startsWith('/api/')) return next();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();
  if (!isTrustedRequestOrigin(req)) {
    return res.status(403).json({ ok: false, message: 'Blocked request origin.' });
  }
  return next();
});

app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    proxy: sessionCookieTrustProxy, // trust X-Forwarded-Proto from reverse proxy for Secure cookies
    name: 'rec.sid', // avoid default connect.sid fingerprinting
    cookie: {
      httpOnly: true,   // prevent XSS from reading session cookie
      secure: isProduction, // HTTPS only in production (requires TLS termination or embedded HTTPS)
      sameSite: 'lax',   // reduce CSRF risk
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
    },
  })
);

// Invalidate old sessions when account sessionVersion is bumped (logout all devices).
app.use((req, res, next) => {
  if (!req.session) return next();
  const isApi = String(req.path || '').startsWith('/api/');

  if (req.session.userEmail) {
    const email = String(req.session.userEmail).trim().toLowerCase();
    const user = users[email];
    if (!user || typeof user !== 'object') {
      req.session.destroy(() => {
        if (isApi) return res.status(401).json({ ok: false, message: 'Session expired. Please sign in again.' });
        return res.redirect('/login');
      });
      return;
    }
    const requiredVersion = Number(user.sessionVersion || 0);
    const currentVersion = Number(req.session.accountSessionVersion || 0);
    if (requiredVersion !== currentVersion) {
      const targetLogin = req.session.leadership ? '/leadership-login' : '/login';
      req.session.destroy(() => {
        if (isApi) return res.status(401).json({ ok: false, message: 'You were signed out from another device.' });
        return res.redirect(targetLogin);
      });
      return;
    }
  }

  if (req.session.studentEmail) {
    const resolved = resolveStudentRecordFromSession(req);
    const student = resolved && resolved.rec;
    if (!student || typeof student !== 'object') {
      req.session.destroy(() => {
        if (isApi) return res.status(401).json({ ok: false, message: 'Session expired. Please sign in again.' });
        return res.redirect('/student/login');
      });
      return;
    }
    const requiredVersion = Number(student.sessionVersion || 0);
    const currentVersion = Number(req.session.accountSessionVersion || 0);
    if (requiredVersion !== currentVersion) {
      req.session.destroy(() => {
        if (isApi) return res.status(401).json({ ok: false, message: 'You were signed out from another device.' });
        return res.redirect('/student/login');
      });
      return;
    }
  }

  return next();
});

// Enforce HTTPS for all student pages/APIs so students only use secure portal.
function isSecureRequest(req) {
  if (req.secure || req.protocol === 'https') return true;
  const xfProto = String(req.headers['x-forwarded-proto'] || '').toLowerCase();
  return xfProto.split(',').map((v) => v.trim()).includes('https');
}
function isStudentOnlyRoute(urlPath) {
  return (
    urlPath.startsWith('/student') ||
    urlPath.startsWith('/api/student') ||
    urlPath === '/api/attendance/od-proof' ||
    urlPath === '/api/attendance/od-status'
  );
}
app.use((req, res, next) => {
  const pathName = String(req.path || '');
  if (!isStudentOnlyRoute(pathName)) return next();
  if (isSecureRequest(req)) return next();
  if (!httpsServer || !httpsPort) {
    return res.status(503).json({
      ok: false,
      message: 'Student portal is available only via HTTPS. Please contact admin to enable HTTPS.',
    });
  }
  const hostName = (req.hostname || 'localhost').replace(/^\[|\]$/g, '');
  const targetUrl = `https://${hostName}:${httpsPort}${req.originalUrl || pathName}`;
  if (req.method === 'GET' || req.method === 'HEAD') {
    return res.redirect(302, targetUrl);
  }
  return res.status(426).json({
    ok: false,
    message: 'Use HTTPS student portal only.',
    httpsUrl: targetUrl,
  });
});

// PWA manifest with correct MIME type (before static to take precedence)
app.get('/manifest.json', (req, res) => {
  res.type('application/manifest+json');
  res.sendFile(publicPath('manifest.json'));
});
app.get('/manifest-app.json', (req, res) => {
  res.type('application/manifest+json');
  res.sendFile(publicPath('manifest-app.json'));
});
// App launcher page (installable PWA - no auth required)
app.get('/app', (req, res) => {
  res.sendFile(publicPath('app.html'));
});

// Android TWA: Digital Asset Links (optional - set TWA_PACKAGE_NAME + TWA_SHA256_FINGERPRINT to enable)
const ASSET_LINKS_PATH = publicPath('.well-known', 'assetlinks.json');
app.get('/.well-known/assetlinks.json', (req, res) => {
  const pkg = process.env.TWA_PACKAGE_NAME;
  const fingerprint = process.env.TWA_SHA256_FINGERPRINT;
  if (pkg && fingerprint) {
    const site =
      normalizeEmailBaseUrl(process.env.PUBLIC_BASE_URL) ||
      process.env.BASE_URL ||
      `${req.protocol || 'https'}://${req.get('host') || ''}`;
    const origin = site.replace(/\/$/, '');
    res.type('application/json');
    return res.json([
      { relation: ['delegate_permission/common.handle_all_urls'], target: { namespace: 'web', site: origin } },
      { relation: ['delegate_permission/common.handle_all_urls'], target: { namespace: 'android_app', package_name: pkg, sha256_cert_fingerprints: [fingerprint] } },
    ]);
  }
  if (fs.existsSync(ASSET_LINKS_PATH)) {
    res.type('application/json');
    return res.sendFile(ASSET_LINKS_PATH);
  }
  res.status(404).end();
});

// ---- Module 1: Email verification (tokens stored as SHA-256 hash to prevent theft) ----
// When verificationTokens is empty (e.g. after server restart), look up user/student by stored token hash so links still work.
// verificationDisplayCode (6 chars) is stored on the account for /verify-email-code.html + POST /api/verify-email-code.

/** Full HTML page for invalid/expired verification links (matches verify-email-code visual style). */
function verifyEmailFlowErrorPageHtml(opts) {
  const title = escapeHtml(opts.title || 'Verification error');
  const detail = opts.detail ? `<p class="err-detail">${escapeHtml(opts.detail)}</p>` : '';
  const year = new Date().getFullYear();
  const linksHtml = (opts.links || [])
    .map(
      (l) =>
        `<a class="link-pill" href="${escapeHtml(l.href)}">${escapeHtml(l.label)}</a>`,
    )
    .join('');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} | REC</title>
<link rel="stylesheet" href="/styles.css" />
<style>
.login-shell{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;position:relative;}
.verify-flow-bg{position:absolute;inset:0;background-image:url("https://dli6r6oycdqaz.cloudfront.net/college-510/user-1343861/d9d7ec54446f49b68b99409f86efeb9f_20250714_121042_510_1343861_Banner1.jpeg");background-size:cover;background-position:center;background-repeat:no-repeat;background-color:#2c3e50;z-index:0;}
.verify-flow-overlay{position:absolute;inset:0;background:rgba(36,19,95,0.5);z-index:1;}
.login-card{width:100%;max-width:440px;background:#fff;border-radius:22px;padding:26px 24px 22px;position:relative;z-index:2;box-shadow:0 0 15px rgba(255,0,255,0.35),0 0 30px rgba(0,229,255,0.3),0 20px 50px rgba(15,9,59,0.25);animation:errCardGlow 3s ease-in-out infinite;}
@keyframes errCardGlow{0%,100%{box-shadow:0 0 15px rgba(168,85,247,0.4),0 0 28px rgba(0,229,255,0.35),0 20px 50px rgba(15,9,59,0.25);}50%{box-shadow:0 0 22px rgba(253,184,19,0.35),0 0 38px rgba(192,38,211,0.4),0 20px 50px rgba(15,9,59,0.25);}}
.login-header{display:flex;align-items:center;gap:14px;margin-bottom:20px;}
.header-logo{height:68px;width:auto;object-fit:contain;flex-shrink:0;}
.header-text{min-width:0;}
.institution-neon{font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:0.06em;line-height:1.35;background:linear-gradient(90deg,#60269e,#fdb813,#00e5ff,#c026d3,#60269e);background-size:300% 100%;-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;animation:neonMove 2.4s linear infinite;filter:drop-shadow(0 0 10px rgba(96,38,158,0.55)) drop-shadow(0 0 16px rgba(253,184,19,0.35));}
.institution-neon-sub{font-size:11px;font-weight:700;margin-top:6px;letter-spacing:0.04em;background:linear-gradient(90deg,#a78bfa,#22d3ee,#fbbf24,#e879f9,#a78bfa);background-size:300% 100%;-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;animation:neonMove 2.8s linear infinite;}
@keyframes neonMove{0%{background-position:0% 50%;}100%{background-position:300% 50%;}}
.err-title{font-size:17px;font-weight:800;color:#991b1b;text-align:center;margin:0 0 10px;line-height:1.35;}
.err-detail{font-size:14px;color:#374151;text-align:center;line-height:1.55;margin:0 0 20px;}
.link-row{display:flex;flex-wrap:wrap;justify-content:center;align-items:center;gap:10px 12px;}
.link-pill{display:inline-block;padding:10px 18px;border-radius:999px;font-size:13px;font-weight:700;text-decoration:none;color:#fff !important;background:linear-gradient(120deg,#5c2eb8,#24135f);box-shadow:0 0 12px rgba(92,46,184,0.45);}
.link-pill:hover{filter:brightness(1.08);}
.login-footer{margin-top:22px;padding-top:16px;border-top:1px solid rgba(36,19,95,0.1);text-align:center;font-size:12px;color:#756f94;}
</style>
</head>
<body>
<div class="login-shell">
  <div class="verify-flow-bg"></div>
  <div class="verify-flow-overlay"></div>
  <div class="login-card">
    <div class="login-header">
      <img src="/rec-logo.jpg" alt="Rajalakshmi Engineering College" class="header-logo" onerror="this.onerror=null;this.src='/rajalakshmi_engineering_college_logo.jpg';" />
      <div class="header-text">
        <div class="institution-neon">Rajalakshmi Engineering College</div>
        <div class="institution-neon-sub">(An Autonomous Institution)</div>
      </div>
    </div>
    <h1 class="err-title">${title}</h1>
    ${detail}
    <div class="link-row">${linksHtml}</div>
    <div class="login-footer">© ${year} Rajalakshmi Engineering College · Internal portal</div>
  </div>
</div>
</body>
</html>`;
}

function findPendingVerificationByCode(codeNorm) {
  const now = Date.now();
  for (const email of Object.keys(users)) {
    const u = users[email];
    if (
      u &&
      !u.emailVerified &&
      u.verificationDisplayCode === codeNorm &&
      u.verificationTokenHash &&
      u.tokenExpiry &&
      u.tokenExpiry >= now
    ) {
      return { type: 'faculty', email, tokenHash: u.verificationTokenHash };
    }
  }
  for (const id of Object.keys(studentRegistrations)) {
    const s = studentRegistrations[id];
    if (
      s &&
      !s.emailVerified &&
      s.verificationDisplayCode === codeNorm &&
      s.verificationTokenHash &&
      s.tokenExpiry &&
      s.tokenExpiry >= now
    ) {
      return { type: 'student', email: id, tokenHash: s.verificationTokenHash };
    }
  }
  return null;
}

function tryFinalizeEmailVerification(type, emailKey, tokenHash) {
  const now = Date.now();
  if (type === 'faculty') {
    const u = users[emailKey];
    if (!u || u.verificationTokenHash !== tokenHash) {
      return { ok: false, reason: 'invalid', student: false };
    }
    if (u.tokenExpiry && u.tokenExpiry < now) {
      delete verificationTokens[tokenHash];
      return { ok: false, reason: 'expired', student: false };
    }
    u.emailVerified = true;
    u.verificationTokenHash = undefined;
    u.tokenExpiry = undefined;
    u.verificationDisplayCode = undefined;
    delete verificationTokens[tokenHash];
    return { ok: true, to: 'login' };
  }
  const s = studentRegistrations[emailKey];
  if (!s || s.verificationTokenHash !== tokenHash) {
    return { ok: false, reason: 'invalid', student: true };
  }
  if (s.tokenExpiry && s.tokenExpiry < now) {
    delete verificationTokens[tokenHash];
    return { ok: false, reason: 'expired', student: true };
  }
  s.emailVerified = true;
  s.verificationTokenHash = undefined;
  s.tokenExpiry = undefined;
  s.verificationDisplayCode = undefined;
  delete verificationTokens[tokenHash];
  return { ok: true, to: 'student-login' };
}

app.get('/verify-email', (req, res) => {
  const token = (req.query.token || '').trim();
  if (!token) {
    return res.redirect(302, '/verify-email-code.html');
  }
  const tokenHash = hashToken(token);
  const now = Date.now();
  let type = null;
  let email = null;

  const entry = verificationTokens[tokenHash];
  if (entry) {
    type = entry.type;
    email = entry.email;
  } else {
    for (const e of Object.keys(users)) {
      const u = users[e];
      if (u && u.verificationTokenHash === tokenHash && u.tokenExpiry && u.tokenExpiry >= now) {
        type = 'faculty';
        email = e;
        break;
      }
    }
    if (!type) {
      for (const e of Object.keys(studentRegistrations)) {
        const s = studentRegistrations[e];
        if (s && s.verificationTokenHash === tokenHash && s.tokenExpiry && s.tokenExpiry >= now) {
          type = 'student';
          email = e;
          break;
        }
      }
    }
  }

  if (!type || !email) {
    return res.status(400).type('html').send(
      verifyEmailFlowErrorPageHtml({
        title: 'Invalid or expired verification token',
        detail: 'This link is no longer valid. Enter the code from your email or sign in below.',
        links: [
          { href: '/verify-email-code.html', label: 'Enter verification code' },
          { href: '/login', label: 'Faculty login' },
          { href: '/student/login', label: 'Student login' },
        ],
      }),
    );
  }

  const result = tryFinalizeEmailVerification(type, email, tokenHash);
  if (!result.ok) {
    if (result.reason === 'expired') {
      const href = result.student ? '/student/login' : '/login';
      return res.status(400).type('html').send(
        verifyEmailFlowErrorPageHtml({
          title: 'Verification link has expired',
          detail: 'Links are valid for a limited time. Register again or contact college IT if you need help.',
          links: [{ href, label: 'Go to login' }],
        }),
      );
    }
    const href = result.student ? '/student/login' : '/login';
    return res.status(400).type('html').send(
      verifyEmailFlowErrorPageHtml({
        title: 'Invalid or expired token',
        detail: 'We could not confirm this verification request. Try the code page or sign in if you already verified.',
        links: [
          { href: '/verify-email-code.html', label: 'Enter verification code' },
          { href, label: 'Go to login' },
        ],
      }),
    );
  }
  saveDatabase();
  res.redirect('/verify-email-success?to=' + encodeURIComponent(result.to));
});

app.post('/api/verify-email-code', (req, res) => {
  const responseFormat = String(req.query.format || '').trim().toLowerCase();
  const acceptHeader = String(req.headers.accept || '').toLowerCase();
  const userAgent = String(req.headers['user-agent'] || '').toLowerCase();
  const wantsHtml = responseFormat === 'html'
    || (responseFormat !== 'json' && (acceptHeader.includes('text/html') || userAgent.includes('mozilla')));
  const renderHtmlResult = (ok, message, redirectUrl) => {
    const status = ok ? 'VERIFIED' : 'VERIFICATION FAILED';
    const statusColor = ok ? '#166534' : '#991b1b';
    const statusBg = ok ? '#dcfce7' : '#fee2e2';
    const safeMessage = escapeHtml(String(message || ''));
    const safeRedirect = redirectUrl ? escapeHtml(String(redirectUrl)) : '';
    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Email Verification | REC</title>
  <style>
    body{margin:0;background:#f6f8ff;font-family:Segoe UI,Arial,sans-serif;color:#1f2937}
    .wrap{max-width:860px;margin:26px auto;padding:0 14px}
    .card{background:#fff;border:1px solid #dbe3ff;border-radius:14px;box-shadow:0 16px 34px rgba(20,15,51,.12);padding:18px}
    .head{display:flex;gap:12px;align-items:center}
    .logo{width:64px;height:64px;border-radius:10px;object-fit:contain;background:#fff;border:1px solid #e5e7eb}
    .college{font-size:22px;font-weight:800;color:#1f2a78;line-height:1.2}
    .sub{font-size:13px;color:#6b7280;margin-top:4px}
    .badge{display:inline-block;margin-top:14px;padding:6px 12px;border-radius:999px;font-size:12px;font-weight:700}
    .msg{margin-top:12px;font-size:15px}
    .cta{display:inline-block;margin-top:16px;padding:10px 16px;border-radius:10px;text-decoration:none;color:#fff;background:#24135f;font-weight:700}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="head">
        <img class="logo" src="/rec-logo.jpg" alt="REC logo" />
        <div>
          <div class="college">Rajalakshmi Engineering College ( An Autonomous Institution)</div>
          <div class="sub">Email Verification Status</div>
        </div>
      </div>
      <span class="badge" style="color:${statusColor};background:${statusBg};border:1px solid ${statusColor}33;">${status}</span>
      <div class="msg">${safeMessage}</div>
      ${safeRedirect ? `<a class="cta" href="${safeRedirect}">Continue</a>` : ''}
    </div>
  </div>
</body>
</html>`;
    return res.status(ok ? 200 : 400).type('html').send(html);
  };
  const codeNorm = normalizeVerificationCodeInput(req.body && req.body.code);
  if (!codeNorm) {
    const msg = 'Enter the 6-character code from your email (letters A–Z and digits 2–9).';
    if (wantsHtml) return renderHtmlResult(false, msg, '/verify-email-code.html');
    return res.status(400).json({ ok: false, message: msg });
  }
  const found = findPendingVerificationByCode(codeNorm);
  if (!found) {
    const msg = 'Invalid or expired code. Use the link in your email, or check the code and try again.';
    if (wantsHtml) return renderHtmlResult(false, msg, '/verify-email-code.html');
    return res.status(400).json({ ok: false, message: msg });
  }
  const result = tryFinalizeEmailVerification(found.type, found.email, found.tokenHash);
  if (!result.ok) {
    if (result.reason === 'expired') {
      const msg = 'This verification code has expired.';
      if (wantsHtml) return renderHtmlResult(false, msg, '/verify-email-code.html');
      return res.status(400).json({ ok: false, message: msg });
    }
    const msg = 'Could not verify. Try the link in your email.';
    if (wantsHtml) return renderHtmlResult(false, msg, '/verify-email-code.html');
    return res.status(400).json({ ok: false, message: msg });
  }
  saveDatabase();
  const redirect = `/verify-email-success?to=${encodeURIComponent(result.to)}`;
  if (wantsHtml) {
    return renderHtmlResult(true, 'Email verification completed successfully.', redirect);
  }
  return res.json({
    ok: true,
    redirect,
  });
});

// Module 1: Force password change on first login (faculty)
app.get('/change-password', ensureAuthenticated, (req, res) => {
  res.sendFile(publicPath('change-password.html'));
});

// Email verification success page (box with logo and college name; ?to=login or to=student-login)
app.get('/verify-email-success', (req, res) => {
  res.sendFile(publicPath('verify-email-success.html'));
});

// Reveal credentials: one-time link or paste encrypted credential from email (AES-256 encrypted password)
function revealCredentialsPageHtml(headTitle, mainHtml) {
  const t = escapeHtml(headTitle || 'Reveal credentials');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${t}</title>
<link rel="stylesheet" href="/styles.css" />
<style>
.reveal-shell{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;position:relative;font-family:system-ui,-apple-system,Segoe UI,sans-serif}
.reveal-shell .background-image{position:absolute;inset:0;z-index:0}
.reveal-shell::after{content:'';position:absolute;inset:0;background:rgba(36,19,95,.5);z-index:1}
.reveal-card{position:relative;z-index:2;width:100%;max-width:560px;background:#fff;border-radius:22px;box-shadow:0 20px 50px rgba(0,0,0,.35);padding:26px 26px 22px}
.reveal-login-header{display:flex;align-items:center;gap:14px;margin-bottom:18px}
.reveal-header-logo{display:block;height:70px;width:auto;max-width:120px;object-fit:contain;flex-shrink:0}
.neon-college{font-size:14px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;line-height:1.4;
  background:linear-gradient(90deg,#ff00ff,#00e5ff,#ffff00,#c026d3,#00e5ff,#ff00ff);
  background-size:400% 100%;
  -webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;
  animation:neonRevealShift 4s linear infinite}
@keyframes neonRevealShift{0%{background-position:0% 50%}100%{background-position:400% 50%}}
.reveal-body{color:#333;line-height:1.6;font-size:14px}
.reveal-body h2{font-size:17px;color:#24135f;margin:0 0 12px;font-weight:700}
.reveal-body textarea{width:100%;box-sizing:border-box;font-family:ui-monospace,monospace;font-size:12px;border-radius:12px;border:1px solid rgba(36,19,95,.18);padding:10px 12px;min-height:120px}
.reveal-body .primary{display:inline-flex;align-items:center;justify-content:center;padding:10px 28px;border-radius:10px;border:1px solid #5c2eb8;cursor:pointer;font-size:14px;font-weight:700;text-transform:uppercase;color:#fff;background:#5c2eb8;margin-top:4px}
.reveal-body .primary:hover{background:#4f26a4}
.reveal-body a{color:#5c2eb8;font-weight:600}
.reveal-footer-links{margin-top:16px;font-size:13px;color:#756f94}
.reveal-body code{background:#f3f2ff;padding:4px 10px;border-radius:6px;font-size:13px;word-break:break-all}
</style>
</head>
<body>
<div class="reveal-shell">
  <div class="background-image" aria-hidden="true" style="background-image: url('https://dli6r6oycdqaz.cloudfront.net/college-510/user-1343861/d9d7ec54446f49b68b99409f86efeb9f_20250714_121042_510_1343861_Banner1.jpeg'); background-size: cover; background-position: center; background-repeat: no-repeat; background-color: rgb(44, 62, 80); transition: background-image 0.3s ease-in-out;"></div>
  <div class="reveal-card">
    <div class="reveal-login-header">
      <img src="/rec-logo.jpg" alt="Rajalakshmi Engineering College" class="reveal-header-logo" width="120" height="70" />
      <div class="header-text">
        <div class="neon-college">Rajalakshmi Engineering College (An Autonomous Institution)</div>
      </div>
    </div>
    <div class="reveal-body">${mainHtml}</div>
  </div>
</div>
</body></html>`;
}

function renderRevealResult(username, password, roleLabel) {
  const role = String(roleLabel || 'faculty').toLowerCase();
  const isStudent = role === 'student';
  const loginHref = isStudent ? '/student/login' : '/login';
  const loginLabel = isStudent ? 'Go to Student login' : 'Go to Faculty login';
  const audience = isStudent ? 'Student' : 'Faculty';
  const inner = `<h2>Your login credentials</h2>
  <p><strong>Username:</strong> ${escapeHtml(username)}</p>
  <p><strong>Password:</strong> <code>${escapeHtml(password)}</code></p>
  <p>Use these to log in to the ${escapeHtml(audience)} Dashboard. Change your password after first login.</p>
  <p><a href="${loginHref}">${escapeHtml(loginLabel)}</a></p>`;
  return revealCredentialsPageHtml('Your login credentials', inner);
}

app.get('/reveal-credentials', (req, res) => {
  const tokenId = (req.query.t || '').trim();
  if (tokenId) {
    const entry = revealCredentialTokens[tokenId];
    delete revealCredentialTokens[tokenId];
    if (!entry || Date.now() > entry.exp) {
      const expiredInner = `<h2>Link expired</h2>
<p>This link has expired or has already been used.</p>
<p><a href="/reveal-credentials">Reveal credentials (paste encrypted value from email)</a></p>
<p class="reveal-footer-links"><a href="/login">Faculty login</a> · <a href="/student/login">Student login</a></p>`;
      return res.status(400).send(revealCredentialsPageHtml('Link expired', expiredInner));
    }
    try {
      const decrypted = security.decryptData(entry.encryptedPayload);
      const payload = JSON.parse(decrypted);
      if (payload.username && payload.password) {
        return res.send(renderRevealResult(payload.username, payload.password, payload.role || 'faculty'));
      }
    } catch (e) {
      console.warn('Reveal credential decrypt failed:', e);
    }
    const badCredInner = `<h2>Invalid credential</h2>
<p>Invalid or corrupted credential.</p>
<p class="reveal-footer-links"><a href="/login">Faculty login</a> · <a href="/student/login">Student login</a></p>`;
    return res.status(400).send(revealCredentialsPageHtml('Invalid credential', badCredInner));
  }
  // No token: show form to paste encrypted credential
  const formInner = `<h2>Reveal your password</h2>
  <p>Paste the encrypted credential from your registration email below. If Gmail or another app inserted line breaks or spaces in the long hex string, paste it anyway — the server removes spaces automatically.</p>
  <form method="post" action="/reveal-credentials">
    <textarea name="encrypted" rows="6" placeholder="Paste the full hex value from your email (spaces OK)"></textarea>
    <p><button type="submit" class="primary">Reveal credentials</button></p>
  </form>
  <p class="reveal-footer-links"><a href="/login">Faculty login</a> · <a href="/student/login">Student login</a></p>`;
  res.send(revealCredentialsPageHtml('Reveal credentials', formInner));
});

app.post('/reveal-credentials', express.urlencoded({ extended: true }), (req, res) => {
  const encrypted = normalizeEncryptedCredentialInput(req.body && req.body.encrypted);
  if (!encrypted) {
    return res.redirect('/reveal-credentials');
  }
  try {
    const decrypted = security.decryptData(encrypted);
    const payload = JSON.parse(decrypted);
    if (payload.username && payload.password) {
      return res.send(renderRevealResult(payload.username, payload.password, payload.role || 'faculty'));
    }
  } catch (e) {
    console.warn('Reveal credential (paste) decrypt failed:', e);
  }
  const pasteErrInner = `<h2>Could not decrypt</h2>
<p>Invalid or corrupted encrypted value. Copy the full hex block from your email and remove any extra spaces if problems persist.</p>
<p class="reveal-footer-links"><a href="/reveal-credentials">Try again</a> · <a href="/login">Faculty login</a> · <a href="/student/login">Student login</a></p>`;
  res.status(400).send(revealCredentialsPageHtml('Reveal credentials', pasteErrInner));
});

// Camera streaming endpoint placeholder: in production, this should proxy/pipe an IP camera or RTSP feed.
app.get('/streams/:room', (req, res) => {
  const room = (req.params.room || '').trim();
  const src = cameraSources[room];
  if (!src) {
    return res.status(404).send('No dedicated camera configured for this room.');
  }
  // NOTE: Implement actual streaming (e.g. MJPEG/HLS) here, using src to identify the underlying camera.
  // For this project template we just return a simple message so the frontend can be wired without errors.
  res
    .status(501)
    .send('Camera streaming for ' + room + ' is not implemented in this demo. Configure IP/RTSP cameras on the server to enable this.');
});

// Faculty-only: block students from faculty dashboard and APIs. Faculty get permanent access when logged in.
function hasTwoStepVerifiedSession(req, expectedRole) {
  if (!req || !req.session) return false;
  if (req.session.mfaVerified !== true) return false;
  const role = String(req.session.mfaRole || '').trim().toLowerCase();
  return role === String(expectedRole || '').trim().toLowerCase();
}

function ensureAuthenticated(req, res, next) {
  if (req.session && req.session.studentEmail && !req.session.userEmail) {
    return res.redirect('/student?denied=faculty');
  }
  if (req.session && req.session.userEmail) {
    if (!hasTwoStepVerifiedSession(req, 'faculty') && !hasTwoStepVerifiedSession(req, 'leadership')) {
      req.session.destroy(() => res.redirect('/login'));
      return;
    }
    const email = String(req.session.userEmail).trim().toLowerCase();
    const u = users[email];
    if (u && u.hashedPassword && !u.emailVerified) {
      req.session.destroy(() => res.redirect('/_login?notice=verify-email'));
      return;
    }
    return next();
  }
  return res.redirect('/login');
}

function isAdminDesignation(designation) {
  return String(designation || '').trim().toLowerCase() === 'admin';
}

function ensureAdmin(req, res, next) {
  if (!req.session || !req.session.userEmail) {
    return res.status(401).json({ ok: false, message: 'Unauthorized.' });
  }
  const email = String(req.session.userEmail || '').trim().toLowerCase();
  const rec = users[email];
  if (!rec || !isAdminDesignation(rec.designation)) {
    return res.status(403).json({ ok: false, message: 'Admin access required.' });
  }
  return next();
}

function isAdminSession(req) {
  if (!req.session || !req.session.userEmail) return false;
  const email = String(req.session.userEmail || '').trim().toLowerCase();
  const rec = users[email];
  return !!(rec && isAdminDesignation(rec.designation));
}

// Student dashboard: require student session; if not logged in as student, show student login (not faculty).
function ensureStudentAuthenticated(req, res, next) {
  if (req.session && req.session.studentEmail) {
    if (!hasTwoStepVerifiedSession(req, 'student')) {
      req.session.destroy(() => res.redirect('/student/login'));
      return;
    }
    const resolved = resolveStudentRecordFromSession(req);
    const rec = resolved && resolved.rec;
    if (rec && rec.hashedPassword && !rec.emailVerified) {
      req.session.destroy(() => res.redirect('/_student-login?notice=verify-email'));
      return;
    }
    return next();
  }
  return res.redirect('/student/login');
}

// Leadership-only: Principal, Directors, HoDs, Vice Principals (separate dashboard & login).
function ensureLeadership(req, res, next) {
  if (!req.session || !req.session.userEmail || !req.session.leadership) {
    return res.redirect('/leadership-login');
  }
  if (!hasTwoStepVerifiedSession(req, 'leadership')) {
    req.session.destroy(() => res.redirect('/leadership-login'));
    return;
  }
  const email = String(req.session.userEmail).trim().toLowerCase();
  const u = users[email];
  if (u && u.hashedPassword && !u.emailVerified) {
    req.session.destroy(() => res.redirect('/_leadership-login?notice=verify-email'));
    return;
  }
  return next();
}

function resolveProfileActor(req) {
  if (req.session && req.session.userEmail) {
    const email = String(req.session.userEmail).trim().toLowerCase();
    const rec = users[email];
    if (rec && typeof rec === 'object') return { role: 'faculty_or_leadership', email, rec };
  }
  if (req.session && req.session.studentEmail) {
    const resolved = resolveStudentRecordFromSession(req);
    const email = String(req.session.studentEmail).trim().toLowerCase();
    const rec = resolved && resolved.rec;
    if (rec && typeof rec === 'object') return { role: 'student', email, rec };
  }
  return null;
}

function ensureAnyDashboardAuth(req, res, next) {
  const actor = resolveProfileActor(req);
  if (!actor) return res.status(401).json({ ok: false, message: 'Please sign in.' });
  req.profileActor = actor;
  return next();
}

function canCreateCampusFeedPost(req) {
  const actor = resolveProfileActor(req);
  if (!actor || actor.role !== 'faculty_or_leadership') return false;
  if (isAdminSession(req)) return false;
  return true;
}

function getCampusFeedRole(req) {
  if (req.session && req.session.leadership) return 'leadership';
  return 'faculty';
}

function sanitizeClassroomActivityForClient(a) {
  if (!a || typeof a !== 'object') return null;
  return {
    id: String(a.id || ''),
    type: String(a.type || ''),
    question: String(a.question || ''),
    options: Array.isArray(a.options) ? a.options.map((x) => String(x || '')) : [],
    optionCounts: Array.isArray(a.optionCounts) ? a.optionCounts.map((n) => Number(n || 0)) : [],
    createdAt: String(a.createdAt || ''),
    sessionId: String(a.sessionId || ''),
  };
}

function sanitizeCampusFeedPost(post, viewerEmail) {
  const reactions = (post && post.reactions && typeof post.reactions === 'object') ? post.reactions : {};
  const comments = Array.isArray(post && post.comments) ? post.comments : [];
  const viewerReaction = viewerEmail && post && post.userReactions && typeof post.userReactions === 'object'
    ? (post.userReactions[viewerEmail] || '')
    : '';
  return {
    id: String(post && post.id ? post.id : ''),
    text: String(post && post.text ? post.text : ''),
    authorName: String(post && post.authorName ? post.authorName : ''),
    authorDesignation: String(post && post.authorDesignation ? post.authorDesignation : ''),
    authorRole: String(post && post.authorRole ? post.authorRole : ''),
    createdAt: String(post && post.createdAt ? post.createdAt : ''),
    mediaUrl: String(post && post.mediaUrl ? post.mediaUrl : ''),
    mediaType: String(post && post.mediaType ? post.mediaType : ''),
    mediaName: String(post && post.mediaName ? post.mediaName : ''),
    repostOf: post && post.repostOf ? {
      id: String(post.repostOf.id || ''),
      text: String(post.repostOf.text || ''),
      authorName: String(post.repostOf.authorName || ''),
    } : null,
    reactions: {
      like: Number(reactions.like || 0),
      love: Number(reactions.love || 0),
      celebrate: Number(reactions.celebrate || 0),
      insightful: Number(reactions.insightful || 0),
    },
    viewerReaction: String(viewerReaction || ''),
    comments: comments.map((c) => ({
      id: String(c && c.id ? c.id : ''),
      text: String(c && c.text ? c.text : ''),
      authorName: String(c && c.authorName ? c.authorName : ''),
      authorRole: String(c && c.authorRole ? c.authorRole : ''),
      createdAt: String(c && c.createdAt ? c.createdAt : ''),
    })),
    repostCount: Number(post && post.repostCount ? post.repostCount : 0),
    shareCount: Number(post && post.shareCount ? post.shareCount : 0),
  };
}

const FIREWALL_USERNAME = String(process.env.FIREWALL_USERNAME || 'recfirewall').trim();
const FIREWALL_PASSWORD = String(process.env.FIREWALL_PASSWORD || 'Firewall@2026').trim();
const firewallCredentialStrong = FIREWALL_USERNAME.length >= 8 && FIREWALL_PASSWORD.length >= 12;
const PORTAL_LOGIN_PASSWORD = 'rec123';

function normalizeClientIp(req) {
  const raw = String(req.ip || req.connection?.remoteAddress || '').trim();
  if (!raw) return 'unknown';
  return raw.replace(/^::ffff:/, '');
}

function getNetworkPrefix(ip) {
  const v = String(ip || '').trim();
  if (!v || v === 'unknown') return 'unknown';
  if (v.includes(':')) {
    const parts = v.split(':').filter(Boolean);
    return parts.slice(0, 3).join(':') || 'ipv6';
  }
  const oct = v.split('.');
  if (oct.length >= 3) return `${oct[0]}.${oct[1]}.${oct[2]}`;
  return v;
}

const CAMPUS_ATTENDANCE_ENFORCED = String(process.env.CAMPUS_ATTENDANCE_ENFORCED || 'false').trim().toLowerCase() === 'true';
const CAMPUS_ATTENDANCE_ALLOWED_CIDRS = String(process.env.CAMPUS_ATTENDANCE_ALLOWED_CIDRS || '').split(',')
  .map((x) => x.trim())
  .filter(Boolean);

function ipv4ToInt(ip) {
  const parts = String(ip || '').trim().split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return (((nums[0] << 24) >>> 0) + ((nums[1] << 16) >>> 0) + ((nums[2] << 8) >>> 0) + (nums[3] >>> 0)) >>> 0;
}

function isIpv4InCidr(ip, cidr) {
  const text = String(cidr || '').trim();
  if (!text) return false;
  const slash = text.indexOf('/');
  if (slash <= 0) return false;
  const baseIp = text.slice(0, slash).trim();
  const prefix = Number(text.slice(slash + 1).trim());
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  const ipInt = ipv4ToInt(ip);
  const baseInt = ipv4ToInt(baseIp);
  if (ipInt == null || baseInt == null) return false;
  if (prefix === 0) return true;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

function isCampusAttendanceIpAllowed(req) {
  if (!CAMPUS_ATTENDANCE_ENFORCED) return true;
  if (!CAMPUS_ATTENDANCE_ALLOWED_CIDRS.length) return false;
  const ip = normalizeClientIp(req);
  if (!ip || ip === 'unknown') return false;
  // localhost is allowed for local development/testing.
  if (ip === '127.0.0.1' || ip === '::1') return true;
  return CAMPUS_ATTENDANCE_ALLOWED_CIDRS.some((cidr) => isIpv4InCidr(ip, cidr));
}

function buildNetworkSnapshot(req, rawNetwork) {
  const net = rawNetwork && typeof rawNetwork === 'object' ? rawNetwork : {};
  const ipAddress = normalizeClientIp(req);
  const networkPrefix = getNetworkPrefix(ipAddress);
  const type = String(net.type || '').trim() || 'unknown';
  const effectiveType = String(net.effectiveType || '').trim() || 'unknown';
  const downlink = Number(net.downlink || 0);
  const rtt = Number(net.rtt || 0);
  const online = net.online === false ? false : true;
  const networkLabel = String(net.networkLabel || '').trim() || `${networkPrefix} (${effectiveType})`;
  const networkKey = `${networkPrefix}|${effectiveType}|${type}`;
  return {
    ipAddress,
    networkPrefix,
    networkLabel,
    networkKey,
    type,
    effectiveType,
    downlink,
    rtt,
    online,
  };
}

function appendFirewallNetworkLog(entry) {
  const safe = entry && typeof entry === 'object' ? entry : {};
  firewallNetworkLogs.push({
    at: safe.at ? String(safe.at) : new Date().toISOString(),
    role: safe.role ? String(safe.role) : '',
    email: safe.email ? String(safe.email) : '',
    actorName: safe.actorName ? String(safe.actorName) : '',
    event: safe.event ? String(safe.event) : '',
    details: safe.details ? String(safe.details) : '',
    ipAddress: safe.ipAddress ? String(safe.ipAddress) : '',
    userAgent: safe.userAgent ? String(safe.userAgent) : '',
    networkLabel: safe.networkLabel ? String(safe.networkLabel) : '',
    networkKey: safe.networkKey ? String(safe.networkKey) : '',
  });
  if (firewallNetworkLogs.length > 1000) {
    firewallNetworkLogs.splice(0, firewallNetworkLogs.length - 1000);
  }
}

function resolveStudentRecordFromSession(req) {
  if (!req.session || !req.session.studentEmail || !req.session.studentId) return null;
  const email = String(req.session.studentEmail).trim().toLowerCase();
  const reg = String(req.session.studentId).trim();
  const rec = studentRegistrations[email] || studentRegistrations[reg + STUDENT_EMAIL_SUFFIX] || null;
  if (!rec || typeof rec !== 'object') return null;
  return { email, reg, rec };
}

function resolveAttendanceRegisterNumberFromSession(req) {
  if (!req || !req.session) return '';
  const sessionReg = String(req.session.studentId || '').trim();
  const email = String(req.session.studentEmail || '').trim().toLowerCase();
  const localPart = email.includes('@') ? email.slice(0, email.indexOf('@')).trim() : '';
  // For numeric student logins, use the logged-in id directly as attendance register number.
  if (/^\d{8,9}$/.test(localPart)) return localPart;
  return sessionReg;
}

function appendDeviceLoginSession(rec, role, req) {
  if (!rec || typeof rec !== 'object') return;
  const userAgent = String(req.headers['user-agent'] || 'Unknown');
  const ipAddress = String(req.ip || req.connection?.remoteAddress || 'Unknown');
  const at = new Date().toISOString();
  if (!Array.isArray(rec.deviceLoginSessions)) rec.deviceLoginSessions = [];
  rec.deviceLoginSessions.push({ at, role: String(role || 'user'), ipAddress, userAgent });
  if (rec.deviceLoginSessions.length > 20) {
    rec.deviceLoginSessions = rec.deviceLoginSessions.slice(-20);
  }
}

function appendAutomationLog(rec, entry) {
  if (!rec || typeof rec !== 'object') return;
  if (!Array.isArray(rec.automationLogs)) rec.automationLogs = [];
  const safe = entry && typeof entry === 'object' ? entry : {};
  rec.automationLogs.push({
    at: safe.at ? String(safe.at) : new Date().toISOString(),
    role: safe.role ? String(safe.role) : '',
    event: safe.event ? String(safe.event) : '',
    details: safe.details ? String(safe.details) : '',
  });
  if (rec.automationLogs.length > 120) {
    rec.automationLogs = rec.automationLogs.slice(-120);
  }
}

/** Turn on AI agent automations once per account after a successful dashboard login (OTP verified). */
function enableAiAgentAfterSignIn(rec, roleForLog) {
  if (!rec || typeof rec !== 'object') return;
  if (!AUTO_ENABLE_AI_AGENT_ON_SIGNIN) return;
  if (rec.automationEnabled === true) return;
  rec.automationEnabled = true;
  appendAutomationLog(rec, {
    role: roleForLog,
    event: 'automation_enabled',
    details: 'AI agent enabled automatically after successful sign-in.',
  });
}

function canSendAutomationEmail(rec, throttleKey, intervalMs) {
  if (!rec || typeof rec !== 'object') return false;
  if (!throttleKey) return true;
  const now = Date.now();
  if (!rec.automationThrottle || typeof rec.automationThrottle !== 'object') rec.automationThrottle = {};
  const lastAt = rec.automationThrottle[throttleKey] ? Number(rec.automationThrottle[throttleKey]) : 0;
  if (lastAt && intervalMs && now - lastAt < intervalMs) return false;
  rec.automationThrottle[throttleKey] = now;
  return true;
}

async function sendAutomationEmail(toEmail, subject, messageText) {
  if (!smtpConfigured) return false;
  const to = String(toEmail || '').trim();
  if (!to) return false;
  const subjectSafe = String(subject || '').trim().slice(0, 160);
  const textSafe = String(messageText || '').trim().slice(0, 8000);
  const footer = `\n\n${COLLEGE_FOOTER_TEXT}`;
  const logoPath = publicPath('rec-logo.jpg');
  const hasLogo = fs.existsSync(logoPath);
  const logoImg = hasLogo
    ? '<img src="cid:rec-logo" alt="Rajalakshmi Engineering College" style="max-height: 60px; width: auto; margin-bottom: 12px; display: inline-block;" />'
    : '';
  const footerHtml = `<div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid #e8e6f2; text-align: center; font-size: 12px; color: #555;">${logoImg}${logoImg ? '<br>' : ''}${COLLEGE_FOOTER_HTML}</div>`;
  const bodyParas = textSafe
    .split(/\n\n+/)
    .map((block) => `<p style="margin: 0 0 14px;">${escapeHtml(block).replace(/\n/g, '<br>')}</p>`)
    .join('');
  const htmlBody = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="font-family: Arial, Helvetica, sans-serif; line-height: 1.55; color: #24135f; max-width: 560px; margin: 0; padding: 16px;">${bodyParas}${footerHtml}</body></html>`;
  const mailOptions = {
    from: process.env.FROM_EMAIL || process.env.SMTP_USER,
    to,
    subject: subjectSafe,
    text: textSafe + footer,
    html: htmlBody,
  };
  if (hasLogo) {
    mailOptions.attachments = [{ filename: 'rec-logo.jpg', content: fs.readFileSync(logoPath), cid: 'rec-logo' }];
  }
  try {
    await transporter.sendMail(mailOptions);
    return true;
  } catch (_) {
    return false;
  }
}

function sanitizeStudentDocMeta(meta) {
  if (!meta || typeof meta !== 'object') return null;
  return {
    fileId: meta.fileId ? String(meta.fileId) : '',
    originalName: meta.originalName ? String(meta.originalName) : '',
    mimeType: meta.mimeType ? String(meta.mimeType) : '',
    size: Number(meta.size || 0),
    uploadedAt: meta.uploadedAt ? String(meta.uploadedAt) : '',
    sha256: meta.sha256 ? String(meta.sha256) : '',
  };
}

// Restrict Admin accounts to Admin-only area and APIs.
app.use((req, res, next) => {
  if (!isAdminSession(req)) return next();
  const p = String(req.path || '');
  const isAssetRequest = /\.[a-z0-9]+$/i.test(p);
  if (isAssetRequest) return next();

  const allowedExact = new Set([
    '/admin/registrations',
    '/api/profile/me',
    '/api/dashboard-role',
    '/api/logout',
    '/logout',
    '/change-password',
    '/api/change-password',
    '/login',
  ]);
  if (allowedExact.has(p)) return next();
  if (p.startsWith('/api/admin/')) return next();

  if (p.startsWith('/api/')) {
    return res.status(403).json({ ok: false, message: 'Admin is restricted to Admin dashboard only.' });
  }
  return res.redirect('/admin/registrations');
});

// ---- Page routes (before static so /login, /register etc. always work) ----
app.get('/', ensureAuthenticated, (req, res) => {
  if (isAdminSession(req)) return res.redirect('/admin/registrations');
  res.sendFile(publicPath('faculty.html'));
});

// Direct page routes: serve HTML without portal redirect (used by portal "open in new tab")
app.get('/_login', (req, res) => {
  res.sendFile(publicPath('login.html'));
});
app.get('/_forgot-password', (req, res) => {
  res.sendFile(publicPath('forgot-password.html'));
});
app.get('/_register', (req, res) => {
  if (req.session && req.session.userEmail) return res.redirect('/');
  res.sendFile(publicPath('register.html'));
});
app.get('/_student-login', (req, res) => {
  if (req.session && req.session.studentEmail) return res.redirect('/student');
  res.sendFile(publicPath('student-login.html'));
});
app.get('/_student-register', (req, res) => {
  if (req.session && req.session.studentEmail) return res.redirect('/student');
  res.sendFile(publicPath('student-register.html'));
});
app.get('/_student-forgot-password', (req, res) => {
  res.sendFile(publicPath('student-forgot-password.html'));
});
app.get('/_leadership-login', (req, res) => {
  if (req.session && req.session.userEmail && req.session.leadership) return res.redirect('/leadership');
  res.sendFile(publicPath('leadership-login.html'));
});
app.get('/_leadership-register', (req, res) => {
  if (req.session && req.session.userEmail) return res.redirect('/leadership');
  res.sendFile(publicPath('leadership-register.html'));
});
app.get('/_firewall-login', (req, res) => {
  const actor = resolveProfileActor(req);
  if (!actor) return res.redirect('/login');
  return res.sendFile(publicPath('firewall-login.html'));
});

app.get('/login', (req, res) => {
  if (req.session && req.session.userEmail && req.session.leadership) {
    return res.redirect('/leadership');
  }
  if (req.session && req.session.userEmail) {
    return res.redirect('/');
  }
  res.sendFile(publicPath('login.html'));
});
app.get('/portal', (req, res) => {
  res.sendFile(publicPath('portal.html'));
});
app.get('/help-center', (req, res) => {
  res.sendFile(publicPath('help-center.html'));
});
app.get('/frequently-asked-questions', (req, res) => {
  res.sendFile(publicPath('frequently-asked-questions.html'));
});
app.get('/faq', (req, res) => {
  res.redirect(302, '/frequently-asked-questions');
});
app.get('/portal-login', (req, res) => {
  res.redirect(302, '/portal');
});
app.get('/timetable-login', (req, res) => {
  res.redirect(302, '/portal');
});

app.get('/forgot-password', (req, res) => {
  res.sendFile(publicPath('forgot-password.html'));
});

app.get('/register', (req, res) => {
  if (req.session && req.session.userEmail) {
    return res.redirect('/');
  }
  res.sendFile(publicPath('register.html'));
});

app.get('/admin/registrations', ensureAuthenticated, (req, res) => {
  const email = String((req.session && req.session.userEmail) || '').trim().toLowerCase();
  const rec = users[email];
  if (!rec || !isAdminDesignation(rec.designation)) {
    return res.redirect('/');
  }
  return res.sendFile(publicPath('admin-registrations.html'));
});

app.get('/student/login', (req, res) => {
  if (req.session && req.session.studentEmail) {
    return res.redirect('/student');
  }
  res.sendFile(publicPath('student-login.html'));
});

app.get('/student/register', (req, res) => {
  if (req.session && req.session.studentEmail) {
    return res.redirect('/student');
  }
  res.sendFile(publicPath('student-register.html'));
});

app.get('/student/forgot-password', (req, res) => {
  res.sendFile(publicPath('student-forgot-password.html'));
});

app.get('/student', ensureStudentAuthenticated, (req, res) => {
  res.sendFile(publicPath('student.html'));
});

// Leadership login and dashboard pages
app.get('/leadership-login', (req, res) => {
  // If already logged in as leadership, go straight to dashboard.
  if (req.session && req.session.userEmail && req.session.leadership) {
    return res.redirect('/leadership');
  }
  res.sendFile(publicPath('leadership-login.html'));
});

app.get('/leadership', ensureLeadership, (req, res) => {
  res.sendFile(publicPath('leadership.html'));
});

app.get('/leadership-register', (req, res) => {
  if (req.session && req.session.userEmail) {
    return res.redirect('/leadership');
  }
  res.sendFile(publicPath('leadership-register.html'));
});

app.get('/firewall-login', (req, res) => {
  const actor = resolveProfileActor(req);
  if (!actor) return res.redirect('/login');
  res.sendFile(publicPath('firewall-login.html'));
});

app.get('/firewall-room', (req, res) => {
  const actor = resolveProfileActor(req);
  if (!actor) return res.redirect('/login');
  return res.sendFile(publicPath('firewall-room.html'));
});

// ---- AI voice assistants: Google Gemini API ----
function loadGeminiKey() {
  if (String(process.env.DISABLE_GEMINI || '').trim().toLowerCase() === 'true') return '';
  let key = (process.env.GEMINI_API_KEY || '').trim();
  if (key && key.length > 10) return key;
  const envPath = path.join(__dirname, '.env');
  try {
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf8');
      const m = content.match(/GEMINI_API_KEY\s*=\s*["']?([^"'\s\r\n]+)["']?/);
      if (m && m[1] && m[1].length > 10) return m[1].trim();
    }
  } catch (e) { /* ignore */ }
  return '';
}
const GEMINI_API_KEY = loadGeminiKey();
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3-flash-preview';
const CLAUDE_API_KEY = String(process.env.DISABLE_CLAUDE || '').trim().toLowerCase() === 'true'
  ? ''
  : (process.env.CLAUDE_API_KEY || '').trim();
const CLAUDE_MODEL = (process.env.CLAUDE_MODEL || 'claude-3-haiku-20240307').trim();
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();
const OPENAI_MODEL = (process.env.OPENAI_MODEL || 'gpt-4o-mini').trim();
if (!GEMINI_API_KEY && !CLAUDE_API_KEY && !OPENAI_API_KEY) {
  console.log('AI chatbot: No AI keys configured (Claude/Gemini/OpenAI). Only local answers will be used.');
} else {
  const enabled = [];
  if (CLAUDE_API_KEY) enabled.push(`claude:${CLAUDE_MODEL}`);
  if (OPENAI_API_KEY) enabled.push(`openai:${OPENAI_MODEL}`);
  if (GEMINI_API_KEY) enabled.push(`gemini:${GEMINI_MODEL}`);
  console.log('AI chatbot: enabled providers -> %s', enabled.join(', '));
}

const AI_SYSTEM_PROMPTS = {
  student: 'You are REC EduMate, a helpful AI assistant for students at Rajalakshmi Engineering College. Answer any question the user asks, the same way a general-purpose chatbot like ChatGPT would. This includes: (1) REC/dashboard: attention scores, privacy, camera, attendance, anonymous doubts, note-taking mode, college info. (2) Everything else: current time/date (use the provided server time), Python/Java/C/any language code (write or explain with examples), math, science, essays, summaries, translations, reasoning, ideas, debugging, algorithms, writing help, general knowledge, step-by-step explanations, and any other prompt. Be helpful, accurate, and clear. For code give runnable examples when asked. For long answers (essays, code) you may write more; otherwise keep it concise. Respond in English only.',
  faculty: 'You are REC Smart Assist, a helpful AI assistant for faculty at Rajalakshmi Engineering College. Answer any question the user asks, the same way a general-purpose chatbot like ChatGPT would. This includes: (1) REC/dashboard: Live Pulse, trend graph, teaching tips, sessions, reports, Smart Attendance, college info. (2) Everything else: current time/date (use the provided server time), Python/Java/any language code, math, writing, analysis, reasoning, teaching ideas, general knowledge, and any other prompt. Be helpful, accurate, and clear. For code give runnable examples when asked. For long answers you may write more; otherwise keep it concise. Respond in English only.',
  leadership: 'You are REC Insight, a helpful AI assistant for leadership at Rajalakshmi Engineering College. Answer any question the user asks, the same way a general-purpose chatbot like ChatGPT would. This includes: (1) REC/dashboard: total sessions, average attention, low-attention sessions, scope, attendance, college info. (2) Everything else: current time/date (use the provided server time), code (any language), math, analysis, writing, reasoning, general knowledge, and any other prompt. Be helpful, accurate, and clear. For code give runnable examples when asked. For long answers you may write more; otherwise keep it concise. Respond in English only.',
};

app.get('/api/ai/status', (req, res) => {
  const providers = [];
  if (CLAUDE_API_KEY) providers.push({ provider: 'claude', model: CLAUDE_MODEL });
  if (OPENAI_API_KEY) providers.push({ provider: 'openai', model: OPENAI_MODEL });
  if (GEMINI_API_KEY) providers.push({ provider: 'gemini', model: GEMINI_MODEL });
  res.json({ configured: providers.length > 0, provider: providers.length ? providers[0].provider : 'none', providers });
});

app.post('/api/ai/chat', express.json(), (req, res) => {
  if (!GEMINI_API_KEY && !CLAUDE_API_KEY && !OPENAI_API_KEY) {
    return res.status(503).json({ error: 'AI not configured', fallback: true });
  }
  const message = (req.body && req.body.message) ? String(req.body.message).trim() : '';
  const context = (req.body && req.body.context) ? String(req.body.context) : 'student';
  const requestedModel = req.body && req.body.model ? String(req.body.model).trim().toLowerCase() : 'auto';
  let systemPrompt = AI_SYSTEM_PROMPTS[context] || AI_SYSTEM_PROMPTS.student;
  const now = new Date();
  const timeStr = now.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'full', timeStyle: 'long' });
  systemPrompt += `\n\nCurrent server date and time (use this when the user asks for the time or date): ${timeStr}.`;
  if (!message) {
    return res.status(400).json({ error: 'message required' });
  }
  const rawFileContexts = Array.isArray(req.body && req.body.fileContexts) ? req.body.fileContexts : [];
  const normalizedFileContexts = rawFileContexts
    .slice(0, 3)
    .map((f) => ({
      name: String((f && f.name) || 'attachment').slice(0, 120),
      content: String((f && f.content) || '').slice(0, 12000),
    }))
    .filter((f) => f.content.trim().length > 0);
  const filesPrompt = normalizedFileContexts.length
    ? '\n\nAttached file excerpts:\n' + normalizedFileContexts.map((f, i) => `[File ${i + 1}: ${f.name}]\n${f.content}`).join('\n\n')
    : '';
  const userPromptText = message + filesPrompt;
  const fullPrompt = systemPrompt + '\n\nUser: ' + userPromptText;

  function callGemini() {
    if (!GEMINI_API_KEY) {
      return Promise.reject(new Error('GEMINI_API_KEY not configured'));
    }
    const isGemini3 = GEMINI_MODEL.startsWith('gemini-3-');
    const basePath = isGemini3 ? 'v1beta' : 'v1';
    const url = `https://generativelanguage.googleapis.com/${basePath}/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
    const body = JSON.stringify({
      contents: [ { parts: [ { text: fullPrompt } ] } ],
      generationConfig: {
        maxOutputTokens: 1500,
        temperature: 0.6,
      },
    });
    const opts = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    };
    return fetch(url, opts).then((r) =>
      r.json().then((data) => {
        if (r.ok) {
          const text = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts && data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text;
          if (!text) throw new Error('No reply from AI');
          return String(text).trim();
        }
        const errMsg = (data && data.error && data.error.message) ? data.error.message : r.statusText;
        const err = new Error(errMsg || 'Gemini error');
        err.status = r.status;
        err.source = 'gemini';
        throw err;
      })
    );
  }

  function callClaude() {
    if (!CLAUDE_API_KEY) {
      return Promise.reject(new Error('CLAUDE_API_KEY not configured'));
    }
    const url = 'https://api.anthropic.com/v1/messages';
    const body = JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1500,
      messages: [
        { role: 'user', content: fullPrompt },
      ],
    });
    const opts = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body,
    };
    return fetch(url, opts).then((r) =>
      r.json().then((data) => {
        if (r.ok) {
          const text = data && data.content && data.content[0] && data.content[0].text;
          if (!text) throw new Error('No reply from AI');
          return String(text).trim();
        }
        const errMsg = (data && data.error && data.error.message) ? data.error.message : r.statusText;
        const err = new Error(errMsg || 'Claude error');
        err.status = r.status;
        err.source = 'claude';
        throw err;
      })
    );
  }

  function callOpenAI() {
    if (!OPENAI_API_KEY) {
      return Promise.reject(new Error('OPENAI_API_KEY not configured'));
    }
    const url = 'https://api.openai.com/v1/chat/completions';
    const body = JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0.6,
      max_tokens: 1500,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPromptText },
      ],
    });
    const opts = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body,
    };
    return fetch(url, opts).then((r) =>
      r.json().then((data) => {
        if (r.ok) {
          const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
          if (!text) throw new Error('No reply from AI');
          return String(text).trim();
        }
        const errMsg = (data && data.error && data.error.message) ? data.error.message : r.statusText;
        const err = new Error(errMsg || 'OpenAI error');
        err.status = r.status;
        err.source = 'openai';
        throw err;
      })
    );
  }

  const callMap = {
    claude: { enabled: !!CLAUDE_API_KEY, fn: callClaude, model: CLAUDE_MODEL },
    openai: { enabled: !!OPENAI_API_KEY, fn: callOpenAI, model: OPENAI_MODEL },
    gemini: { enabled: !!GEMINI_API_KEY, fn: callGemini, model: GEMINI_MODEL },
  };
  let providerOrder = ['claude', 'openai', 'gemini'];
  if (requestedModel && requestedModel !== 'auto' && callMap[requestedModel]) {
    providerOrder = [requestedModel].concat(providerOrder.filter((p) => p !== requestedModel));
  }
  const chain = providerOrder.filter((p) => callMap[p] && callMap[p].enabled);
  if (!chain.length) {
    return res.status(503).json({ error: 'AI not configured', fallback: true });
  }

  function aiFetchErrorDetail(err) {
    const m = err && err.message ? String(err.message) : '';
    const c = err && err.cause;
    if (c && (c.code || c.message)) {
      return `${m}${m ? ' — ' : ''}${c.code || ''} ${c.message || c}`.trim();
    }
    return m;
  }

  let idx = 0;
  const tryNext = () => {
    const provider = chain[idx++];
    const runner = callMap[provider];
    return runner.fn()
      .then((reply) => res.json({ reply, provider, model: runner.model }))
      .catch((err) => {
        console.error('AI provider error:', provider, err.status || '', aiFetchErrorDetail(err));
        if (idx < chain.length) return tryNext();
        throw err;
      });
  };

  tryNext()
    .catch((err) => {
      const detail = aiFetchErrorDetail(err);
      console.error('AI error (final):', detail);
      const msg = detail || 'AI unavailable';
      if (err.status === 400 || err.status === 401 || err.status === 403) {
        return res.status(502).json({ error: 'Invalid or restricted AI key. Check CLAUDE_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY in .env.', fallback: true });
      }
      const isNet = /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ENETUNREACH|certificate/i.test(msg);
      const hint = isNet
        ? ' Outbound HTTPS to the AI APIs may be blocked (firewall, proxy, or no internet). Allow access to api.anthropic.com, api.openai.com, and generativelanguage.googleapis.com — or set HTTP_PROXY/HTTPS_PROXY if you use a corporate proxy.'
        : '';
      return res.status(502).json({ error: 'AI unavailable: ' + msg + hint, fallback: true });
    });
});

/** DOM scroll targets the innovation panel may reference (whitelist). */
const INNOVATION_ALLOWED_TARGETS = {
  student: [
    'studentMainLiveCard',
    'studentSessionControlsSection',
    'studentAttentionSection',
    'studentLearningModeSection',
    'studentAttendanceSection',
    'studentOdSection',
    'studentConnectionSection',
  ],
  faculty: [
    'cameraVideoWrap',
    'facultySessionDetailsSection',
    'facultyTeachingPulseSection',
    'teachingCoachSection',
    'facultySmartAttendanceSection',
  ],
  leadership: [
    'leaderE2eBanner',
    'leaderOverviewSection',
    'leaderSessionsSection',
    'leaderDeptAttendanceSection',
    'leaderOdQueueSection',
  ],
};

const INNOVATION_STATIC_FALLBACK = {
  student: [
    { id: 'studentMainLiveCard', title: 'Live preview & WebRTC', text: 'Encrypted path from your device to faculty: camera preview, streaming controls, and session status in one place.' },
    { id: 'studentSessionControlsSection', title: 'End-to-end encrypted session', text: 'Attention signals are protected in transit; session controls gate camera and streaming while class is active.' },
    { id: 'studentAttentionSection', title: 'On-device AI attention (privacy-first)', text: 'Gaze and posture signals are processed locally into an anonymised score—no facial recognition storage.' },
    { id: 'studentLearningModeSection', title: 'Learning mode (device-local)', text: 'Listening, note-taking, or discussion mode stays on this device and is not shared as identity.' },
    { id: 'studentAttendanceSection', title: 'Smart attendance & history', text: 'Hybrid Present / Absent / OD with session history and refresh—aligned with faculty and leadership views.' },
    { id: 'studentOdSection', title: 'OD proof workflow', text: 'Structured on-duty uploads with Assistant HoD / HoD visibility and status tracking on your dashboard.' },
    { id: 'studentConnectionSection', title: 'Timetable & venue awareness', text: 'Connection panel ties faculty presence to timetable-synced venue hints for the right class context.' },
  ],
  faculty: [
    { id: 'cameraVideoWrap', title: 'Live student stream', text: 'Low-latency view of the signed-in student device with connection health for teaching decisions.' },
    { id: 'facultySessionDetailsSection', title: 'Smart Classroom Locator sessions', text: 'Block–floor–room venue capture, multi-session list, and encrypted attention for each class.' },
    { id: 'facultyTeachingPulseSection', title: 'Live Teaching Pulse & Digital Twin', text: 'Rolling attention, trend chart, zone heatmap, and AI insight for formative feedback—not grading.' },
    { id: 'teachingCoachSection', title: 'Adaptive Teaching Coach', text: 'Context-aware teaching tips from current attention and classroom signals to support pacing and checks.' },
    { id: 'facultySmartAttendanceSection', title: 'Smart Attendance (hybrid)', text: 'Hand-raise window, face/attention signals, OD visibility, edit mode, and resilient refresh for busy networks.' },
  ],
  leadership: [
    { id: 'leaderE2eBanner', title: 'Encryption in transit', text: 'Leadership overview and approvals are served over HTTPS with server-side protection of session data.' },
    { id: 'leaderOverviewSection', title: 'Engagement summary', text: 'Cross-session attention aggregates, low-attention flags, and OD counts scoped to your responsibility.' },
    { id: 'leaderSessionsSection', title: 'Recent sessions lens', text: 'Topic, faculty, department, and attention snapshots for operational awareness across the college.' },
    { id: 'leaderDeptAttendanceSection', title: 'Department attendance (HoD)', text: 'Hybrid Present | Absent | OD roll-ups by session for departmental oversight.' },
    { id: 'leaderOdQueueSection', title: 'OD approval queue', text: 'Assistant HoD and HoD staged decisions with proof links—mirrors the workflow students and faculty use.' },
  ],
};

function parseInnovationAiJson(raw, allowedIds) {
  let s = String(raw || '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const obj = JSON.parse(s);
  const rows = Array.isArray(obj.items) ? obj.items : Array.isArray(obj) ? obj : [];
  const allow = new Set((allowedIds || []).map((x) => String(x)));
  const out = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row || typeof row !== 'object') continue;
    const id = String(row.id || '').trim();
    if (!allow.has(id)) continue;
    const title = String(row.title || '').trim().slice(0, 120);
    const text = String(row.text || row.body || '').trim().slice(0, 320);
    if (!title || !text) continue;
    out.push({ id, title, text });
    if (out.length >= 10) break;
  }
  return out;
}

/**
 * Single-shot text completion using the same provider order as /api/ai/chat.
 * Uses one combined prompt for Gemini/Claude; system+user split for OpenAI.
 */
function aiCompleteInnovationText(systemPrompt, userTask) {
  if (!GEMINI_API_KEY && !CLAUDE_API_KEY && !OPENAI_API_KEY) {
    return Promise.reject(new Error('AI not configured'));
  }
  const maxTokens = 900;
  const temperature = 0.35;
  const combined = `${String(systemPrompt || '').trim()}\n\n---\n\n${String(userTask || '').trim()}`;

  function callGeminiInnovation() {
    if (!GEMINI_API_KEY) return Promise.reject(new Error('GEMINI_API_KEY not configured'));
    const isGemini3 = GEMINI_MODEL.startsWith('gemini-3-');
    const basePath = isGemini3 ? 'v1beta' : 'v1';
    const url = `https://generativelanguage.googleapis.com/${basePath}/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
    const body = JSON.stringify({
      contents: [{ parts: [{ text: combined }] }],
      generationConfig: { maxOutputTokens: maxTokens, temperature },
    });
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
      .then((r) => r.json().then((data) => {
        if (r.ok) {
          const text = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts && data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text;
          if (!text) throw new Error('No reply from AI');
          return { text: String(text).trim(), provider: 'gemini' };
        }
        throw new Error((data && data.error && data.error.message) || r.statusText || 'Gemini error');
      }));
  }

  function callClaudeInnovation() {
    if (!CLAUDE_API_KEY) return Promise.reject(new Error('CLAUDE_API_KEY not configured'));
    const url = 'https://api.anthropic.com/v1/messages';
    const body = JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: combined }],
    });
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_API_KEY, 'anthropic-version': '2023-06-01' },
      body,
    }).then((r) => r.json().then((data) => {
      if (r.ok) {
        const text = data && data.content && data.content[0] && data.content[0].text;
        if (!text) throw new Error('No reply from AI');
        return { text: String(text).trim(), provider: 'claude' };
      }
      throw new Error((data && data.error && data.error.message) || r.statusText || 'Claude error');
    }));
  }

  function callOpenAIInnovation() {
    if (!OPENAI_API_KEY) return Promise.reject(new Error('OPENAI_API_KEY not configured'));
    const url = 'https://api.openai.com/v1/chat/completions';
    const body = JSON.stringify({
      model: OPENAI_MODEL,
      temperature,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: String(systemPrompt || '').trim() },
        { role: 'user', content: String(userTask || '').trim() },
      ],
    });
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
      body,
    }).then((r) => r.json().then((data) => {
      if (r.ok) {
        const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        if (!text) throw new Error('No reply from AI');
        return { text: String(text).trim(), provider: 'openai' };
      }
      throw new Error((data && data.error && data.error.message) || r.statusText || 'OpenAI error');
    }));
  }

  const chain = [];
  if (CLAUDE_API_KEY) chain.push(callClaudeInnovation);
  if (OPENAI_API_KEY) chain.push(callOpenAIInnovation);
  if (GEMINI_API_KEY) chain.push(callGeminiInnovation);
  if (!chain.length) return Promise.reject(new Error('No AI provider available'));
  let cidx = 0;
  const runNext = () => {
    if (cidx >= chain.length) return Promise.reject(new Error('All AI providers failed'));
    const fn = chain[cidx++];
    return fn().catch(() => runNext());
  };
  return runNext();
}

app.post('/api/innovation/highlights', express.json({ limit: '8kb' }), (req, res) => {
  const actor = resolveProfileActor(req);
  if (!actor) return res.status(401).json({ ok: false, message: 'Please sign in.' });

  let dashboard = String((req.body && req.body.dashboard) || '').trim().toLowerCase();
  if (!['student', 'faculty', 'leadership'].includes(dashboard)) {
    dashboard = actor.role === 'student' ? 'student' : (req.session && req.session.leadership ? 'leadership' : 'faculty');
  }
  const allowed = INNOVATION_ALLOWED_TARGETS[dashboard] || INNOVATION_ALLOWED_TARGETS.faculty;
  const staticItems = INNOVATION_STATIC_FALLBACK[dashboard] || INNOVATION_STATIC_FALLBACK.faculty;

  const systemPrompt = `You are a technical product writer for Rajalakshmi Engineering College's AI classroom attention platform.

OUTPUT RULES (strict):
- Respond with ONLY a single JSON object, no markdown fences, no commentary.
- Shape: {"items":[{"id":"...","title":"...","text":"..."}]}
- Each "id" MUST be exactly one string from this array (copy verbatim): ${JSON.stringify(allowed)}
- Include 5 to 7 items covering different ids where possible. Do not repeat the same id twice.
- "title": short headline, max 70 characters.
- "text": one or two sentences, benefit-focused for this role, max 260 characters, plain English.
Topics may include: privacy-preserving on-device attention signals, encrypted/WebRTC session paths, hybrid Smart Attendance, OD approval workflow, leadership analytics scope, teaching coach / digital twin / pulse — only where relevant to this dashboard role.`;

  const userTask = `Generate innovation highlights for the "${dashboard}" dashboard. Emphasize what is distinctive and trustworthy for this user role (student, faculty, or leadership). JSON only.`;

  if (!GEMINI_API_KEY && !CLAUDE_API_KEY && !OPENAI_API_KEY) {
    return res.json({ ok: true, source: 'static', items: staticItems, message: 'AI not configured; curated highlights.' });
  }

  aiCompleteInnovationText(systemPrompt, userTask)
    .then(({ text, provider }) => {
      let items;
      try {
        items = parseInnovationAiJson(text, allowed);
      } catch (e) {
        throw new Error('Invalid AI JSON');
      }
      if (!items || items.length < 3) throw new Error('Too few highlights');
      return res.json({ ok: true, source: 'ai', provider, items });
    })
    .catch((err) => {
      console.warn('Innovation highlights AI:', err && err.message ? err.message : err);
      return res.json({
        ok: true,
        source: 'static',
        items: staticItems,
        message: 'AI unavailable or invalid response; showing curated highlights.',
      });
    });
});

app.use(express.static(PUBLIC_DIR));
app.use('/assets', express.static(ASSETS_DIR));
// OD proofs: served only as static files (used in faculty dashboard for OD verification links).
app.use('/od-proofs', express.static(OD_DIR));
// AHOD/HOD verification proofs: served as static files.
app.use('/od-verification-proofs', express.static(OD_VERIFICATION_DIR));
// Profile pictures for faculty/students/leadership.
app.use('/profile-images', express.static(PROFILE_DIR));
// Campus feed media attachments (image/video).
app.use('/feed-media', express.static(FEED_MEDIA_DIR));

// Free rooms from REC timetable (8:00 AM – 5:00 PM). Fetches from timetable.alien501.in; fallback list if fetch fails.
const FREE_ROOMS_SOURCE = 'https://timetable.alien501.in/free-rooms';
const FREE_ROOMS_FALLBACK = ['Room 101', 'Room 102', 'Room 103', 'Room 201', 'Room 202', 'Room 301', 'Seminar Hall A', 'Library (reading area)'];

function parseRoomsFromHtml(html) {
  const rooms = new Set();
  const stripHtml = (s) => s.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
  const add = (s) => { const t = stripHtml(s).trim(); if (t && t.length < 80) rooms.add(t); };
  const liRe = /<li[^>]*>([^<]+)<\/li>/gi;
  const tdRe = /<td[^>]*>([^<]+)<\/td>/gi;
  let m;
  while ((m = liRe.exec(html)) !== null) add(m[1]);
  while ((m = tdRe.exec(html)) !== null) add(m[1]);
  const roomLikeRe = /(?:Room|Hall|Lab|Block|Seminar)\s*[A-Za-z0-9\-]+(?:\s*[-\–]\s*[A-Za-z0-9\-]+)?/gi;
  while ((m = roomLikeRe.exec(html)) !== null) add(m[0]);
  return Array.from(rooms).filter(Boolean).sort();
}

function extractVenueFromTimetablePayload(payload) {
  const text = String(payload || '');
  const roomLikeRe = /\b([A-Z]{1,3}\s*-?\s*\d{2,4}|[A-Z]\d{3}|Room\s*\d{2,4}|Seminar Hall(?:\s*[A-Z])?|Lab\s*[A-Z0-9\-]+)\b/gi;
  const m = roomLikeRe.exec(text);
  if (!m || !m[1]) return '';
  return String(m[1]).replace(/\s+/g, ' ').trim();
}

function fetchRemoteTextFromUrl(rawUrl) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(String(rawUrl || '').trim());
    } catch (_) {
      reject(new Error('Invalid URL.'));
      return;
    }
    if (!/^https?:$/i.test(parsed.protocol)) {
      reject(new Error('Only HTTP/HTTPS timetable URLs are allowed.'));
      return;
    }
    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'GET',
        timeout: 10000,
        headers: { 'User-Agent': 'REC-Student-Timetable-Sync/1.0' },
      },
      (resp) => {
        let body = '';
        resp.on('data', (ch) => { body += ch; });
        resp.on('end', () => {
          if (resp.statusCode < 200 || resp.statusCode >= 300) {
            reject(new Error(`Timetable URL returned HTTP ${resp.statusCode}.`));
            return;
          }
          resolve(body);
        });
      }
    );
    req.on('error', (err) => reject(err));
    req.on('timeout', () => { req.destroy(new Error('Timetable URL request timed out.')); });
    req.end();
  });
}

app.get('/api/free-rooms', (req, res) => {
  const url = new URL(FREE_ROOMS_SOURCE);
  const opts = { hostname: url.hostname, path: url.pathname + url.search, method: 'GET', timeout: 8000 };
  const request = https.request(opts, (resp) => {
    let body = '';
    resp.on('data', (ch) => { body += ch; });
    resp.on('end', () => {
      let rooms = [];
      try {
        const json = JSON.parse(body);
        if (Array.isArray(json)) rooms = json.map(String).filter(Boolean);
        else if (json && Array.isArray(json.rooms)) rooms = json.rooms.map(String).filter(Boolean);
      } catch (_) {
        rooms = parseRoomsFromHtml(body);
      }
      const useFallback = rooms.length === 0;
      if (useFallback) rooms = FREE_ROOMS_FALLBACK;
      res.json({ rooms, source: FREE_ROOMS_SOURCE, fallback: useFallback });
    });
  });
  request.on('error', () => res.json({ rooms: FREE_ROOMS_FALLBACK, source: FREE_ROOMS_SOURCE, fallback: true }));
  request.on('timeout', () => { request.destroy(); res.json({ rooms: FREE_ROOMS_FALLBACK, source: FREE_ROOMS_SOURCE, fallback: true }); });
  request.setTimeout(8000);
  request.end();
});

app.get('/api/auth/google-config', (_req, res) => {
  return res.json({
    ok: true,
    enabled: !!GOOGLE_CLIENT_ID,
    clientId: GOOGLE_CLIENT_ID || '',
  });
});

/** Public wa.me URL and display phone for dashboard “Ask on WhatsApp” (from .env). */
app.get('/api/whatsapp/support', (_req, res) => {
  const cfg = getWhatsAppSupportPayload();
  if (!cfg) return res.status(503).json({ ok: false, message: 'WhatsApp support is not configured.' });
  return res.json({
    ok: true,
    waUrl: cfg.waUrl,
    phoneDisplay: cfg.phoneDisplay,
    prefillMessage: WHATSAPP_PREFILL_MESSAGE,
  });
});

// ---- Auth APIs ----

// Student registration & login: only registered students can access dashboard
const STUDENT_EMAIL_SUFFIX = '@rajalakshmi.edu.in';
const STUDENT_REGISTER_PATH = '/student/register';
const STUDENT_LOGIN_PATH = '/student/login';
const REGISTER_NUMBER_REGEX = /^\d{8,9}$/; // 8 or 9 digit register number
/** Lookup by canonical key (reg@domain) or by stored official college email. */
function findStudentRegistrationByLoginEmail(trimmedEmail) {
  const e = String(trimmedEmail || '').trim().toLowerCase();
  if (!e || !e.endsWith(STUDENT_EMAIL_SUFFIX)) return null;
  if (studentRegistrations[e]) return studentRegistrations[e];
  for (const key of Object.keys(studentRegistrations)) {
    const rec = studentRegistrations[key];
    if (rec && typeof rec === 'object' && String(rec.email || '').trim().toLowerCase() === e) {
      return rec;
    }
  }
  return null;
}
/** True if this @rajalakshmi.edu.in address is already a student login id (key in studentRegistrations). */
function isRegisteredStudentLoginEmail(email) {
  return !!findStudentRegistrationByLoginEmail(email);
}

app.post('/api/student-register', async (req, res) => {
  const { email, registerNumber, name, college, department, mobile } = req.body;
  if (!email || !registerNumber || !name || !college || !department) {
    return res.status(400).json({
      ok: false,
      message: 'Register number, full name, college, department, and official college email are required.',
    });
  }
  const mobileRaw = String(mobile || '').trim();
  const mobileE164 = mobileRaw ? normalizeMobileForSms(mobileRaw) : null;
  if (!mobileRaw || !mobileE164) {
    return res.status(400).json({
      ok: false,
      message: 'Valid mobile number is required (international format e.g. +919876543210 or 10 digits).',
    });
  }
  const trimmedEmail = String(email).trim().toLowerCase();
  const regNum = String(registerNumber).trim();
  const fullName = String(name).trim();
  const collegeName = String(college).trim();
  const departmentRaw = String(department).trim();
  const departmentCode = normalizeStudentDepartmentCode(departmentRaw);
  if (fullName.length < 2 || fullName.length > 120) {
    return res.status(400).json({ ok: false, message: 'Enter your full name (2–120 characters).' });
  }
  if (collegeName.length < 2 || collegeName.length > 200) {
    return res.status(400).json({ ok: false, message: 'Enter your college name (2–200 characters).' });
  }
  if (!departmentCode || departmentCode.length < 2 || departmentCode.length > 12) {
    return res.status(400).json({
      ok: false,
      message: 'Enter a valid department (2-12 letters/numbers, e.g., eee, it, cse).',
    });
  }
  const studentUsername = regNum + STUDENT_EMAIL_SUFFIX; // Username = registerNumber@rajalakshmi.edu.in
  if (!trimmedEmail.endsWith(STUDENT_EMAIL_SUFFIX)) {
    return res.status(400).json({ ok: false, message: 'Use your official college email (@rajalakshmi.edu.in).' });
  }
  if (!REGISTER_NUMBER_REGEX.test(regNum)) {
    return res.status(400).json({ ok: false, message: 'Register number must be 8 or 9 digits.' });
  }
  if (studentRegistrations[studentUsername]) {
    return res.status(400).json({ ok: false, message: 'This register number is already registered. Please sign in.' });
  }
  if (isRegisteredStudentLoginEmail(trimmedEmail)) {
    return res.status(400).json({ ok: false, message: 'This college email is already registered. Please sign in.' });
  }
  if (users[studentUsername]) {
    return res.status(400).json({
      ok: false,
      message:
        'This register number matches a faculty/staff account that uses the same email address. Contact admin or use faculty login with that address.',
    });
  }

  // Module 1: Strong encryption — password hashed with bcrypt; token stored as SHA-256 hash only
  const initialPassword = getInitialPasswordForRole('student', { departmentCode, registerNumber: regNum });
  const hashedPassword = await bcrypt.hash(initialPassword, BCRYPT_ROUNDS);
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(token);
  const tokenExpiry = Date.now() + VERIFICATION_TOKEN_EXPIRY_MS;
  const verificationDisplayCode = verificationEmailDisplayCode(token);

  studentRegistrations[studentUsername] = {
    registerNumber: regNum,
    name: fullName,
    college: collegeName,
    department: departmentCode,
    email: trimmedEmail,
    mobileE164: mobileE164 || undefined,
    hashedPassword,
    emailVerified: false,
    verificationTokenHash: tokenHash,
    verificationDisplayCode,
    tokenExpiry,
    firstLogin: true,
    failedAttempts: 0,
    accountLockedUntil: null,
    lastDevice: null,
    lastIP: null,
    createdAt: new Date().toISOString(),
  };
  verificationTokens[tokenHash] = { type: 'student', email: studentUsername };

  const emailLinksBase = revealLinksBaseUrl(req);
  const verifyUrlForMail = `${emailLinksBase}/verify-email?token=${encodeURIComponent(token)}`;
  // Persist first, then send emails in background to reduce registration latency.
  saveDatabase();
  runBackgroundTask('Student verification/login email', async () => {
    await sendVerificationEmail(trimmedEmail, studentUsername, initialPassword, token, 'student', emailLinksBase, clientIpFromReq(req));
    await sendLoginEmail(trimmedEmail, studentUsername, initialPassword, 'student', emailLinksBase, {
      verifyUrl: verifyUrlForMail,
    });
  });
  // Do not create a session here — user must verify email, then sign in with password + OTP.
  return res.json({
    ok: true,
    message:
      'Registration successful. Open the verification link in your email, then sign in with the password sent in your encrypted credentials email.',
    requirePasswordChange: true,
  });
});

app.post('/api/student-login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ ok: false, message: 'Email and password are required.' });
  }
  const trimmedEmail = String(email).trim().toLowerCase();
  const pwd = String(password).trim();
  if (!trimmedEmail.endsWith(STUDENT_EMAIL_SUFFIX)) {
    return res.status(400).json({ ok: false, message: 'Use your official college email (@rajalakshmi.edu.in).' });
  }
  const registered = findStudentRegistrationByLoginEmail(trimmedEmail);
  if (!registered) {
    return res.status(403).json({ ok: false, message: 'Not registered. Please register first.' });
  }

  // Module 2: Lockout check
  const now = Date.now();
  if (registered.accountLockedUntil && now < registered.accountLockedUntil) {
    return res.status(429).json({ ok: false, message: 'Too many failed login attempts. Try again later.' });
  }
  // Module 1: Require email verification for new secure accounts
  if (registered.hashedPassword && !registered.emailVerified) {
    return res.status(403).json({ ok: false, message: 'Please verify your email using the link sent to you before signing in.' });
  }

  let valid = false;
  if (registered.hashedPassword) {
    valid = await bcrypt.compare(pwd, registered.hashedPassword);
  } else {
    valid = !!(registered.password && pwd === registered.password);
  }
  if (!valid) {
    registered.failedAttempts = (registered.failedAttempts || 0) + 1;
    if (registered.failedAttempts >= MAX_FAILED_ATTEMPTS) {
      registered.accountLockedUntil = now + LOCKOUT_DURATION_MS;
    }
    return res.status(401).json({
      ok: false,
      message:
        'Invalid password. Use the exact password from your encrypted credentials email.',
    });
  }

  // Module 2: New device/IP → security alert
  const device = req.headers['user-agent'] || 'Unknown';
  const ip = req.ip || req.connection?.remoteAddress || 'Unknown';
  if (registered.lastDevice !== undefined && (registered.lastDevice !== device || registered.lastIP !== ip)) {
    const sendTo = registered.email || trimmedEmail;
    await sendSecurityAlertEmail(sendTo, device, ip);
  }
  registered.failedAttempts = 0;
  registered.accountLockedUntil = null;
  registered.lastDevice = device;
  registered.lastIP = ip;

  const otpChallenge = await issueLoginOtpChallenge(
    'student',
    registered.email || trimmedEmail,
    {
      studentEmail: trimmedEmail,
      studentId: registered.registerNumber,
    },
    {
      requirePasswordChange: !!registered.firstLogin,
    },
  );
  if (!otpChallenge.ok) {
    return res.status(otpChallenge.status || 500).json({ ok: false, message: otpChallenge.message || 'Unable to start OTP login.' });
  }
  return res.json(otpChallenge);
});

app.post('/api/student-login/google', async (req, res) => {
  const idToken = String((req.body && req.body.idToken) || '').trim();
  if (!GOOGLE_CLIENT_ID) {
    return res.status(503).json({ ok: false, message: 'Google login is not configured on the server.' });
  }
  let identity;
  try {
    identity = await verifyGoogleIdTokenWithGoogle(idToken);
  } catch (err) {
    return res.status(401).json({ ok: false, message: err && err.message ? err.message : 'Invalid Google sign-in token.' });
  }
  const emailLower = String(identity.email || '').trim().toLowerCase();
  if (!emailLower.endsWith(STUDENT_EMAIL_SUFFIX)) {
    return res.status(403).json({ ok: false, message: 'Use your official college email (@rajalakshmi.edu.in).' });
  }
  const registered = findStudentRegistrationByLoginEmail(emailLower);
  if (!registered) {
    return res.status(403).json({ ok: false, message: 'Not registered. Please register first.' });
  }
  if (registered.hashedPassword && !registered.emailVerified) {
    return res.status(403).json({ ok: false, message: 'Please verify your email using the link sent to you before signing in.' });
  }
  const device = req.headers['user-agent'] || 'Unknown';
  const ip = req.ip || req.connection?.remoteAddress || 'Unknown';
  if (registered.lastDevice !== undefined && (registered.lastDevice !== device || registered.lastIP !== ip)) {
    const sendTo = registered.email || emailLower;
    await sendSecurityAlertEmail(sendTo, device, ip);
  }
  registered.failedAttempts = 0;
  registered.accountLockedUntil = null;
  registered.lastDevice = device;
  registered.lastIP = ip;
  const otpChallenge = await issueLoginOtpChallenge(
    'student',
    registered.email || emailLower,
    {
      studentEmail: emailLower,
      studentId: registered.registerNumber,
    },
    {
      requirePasswordChange: !!registered.firstLogin,
    },
  );
  if (!otpChallenge.ok) {
    return res.status(otpChallenge.status || 500).json({ ok: false, message: otpChallenge.message || 'Unable to start OTP login.' });
  }
  return res.json(otpChallenge);
});

app.post('/api/student-login/verify-otp', async (req, res) => {
  const { challengeId, otp } = req.body || {};
  const result = await verifyLoginOtpChallenge('student', challengeId, otp);
  if (!result.ok) return res.status(result.status || 400).json({ ok: false, message: result.message || 'OTP verification failed.' });
  const data = result.entry;
  const studentEmail = String(data.sessionData.studentEmail || '').trim().toLowerCase();
  const studentId = String(data.sessionData.studentId || '').trim();
  const studentRec =
    studentRegistrations[studentEmail] || studentRegistrations[studentId + STUDENT_EMAIL_SUFFIX] || null;
  if (studentRec && studentRec.hashedPassword && !studentRec.emailVerified) {
    return res.status(403).json({
      ok: false,
      message: 'Please verify your email using the link sent to you before completing sign-in.',
    });
  }
  req.session.studentEmail = studentEmail;
  req.session.studentId = studentId;
  req.session.mfaVerified = true;
  req.session.mfaRole = 'student';
  req.session.mfaAt = new Date().toISOString();
  if (studentRec) {
    if (studentRec.sessionVersion == null) studentRec.sessionVersion = 0;
    req.session.accountSessionVersion = Number(studentRec.sessionVersion || 0);
    enableAiAgentAfterSignIn(studentRec, 'student');
    appendDeviceLoginSession(studentRec, 'student', req);
    saveDatabase();
  }
  return res.json({
    ok: true,
    requirePasswordChange: !!(data.meta && data.meta.requirePasswordChange),
  });
});

app.post('/api/student-login/resend-otp', async (req, res) => {
  const { challengeId } = req.body || {};
  const out = await resendLoginOtpChallenge('student', challengeId);
  if (!out.ok) return res.status(out.status || 400).json({ ok: false, message: out.message || 'Unable to resend OTP.' });
  return res.json({ ok: true, message: out.message || 'OTP resent.' });
});

app.post('/api/student-change-password', async (req, res) => {
  if (!req.session || !req.session.studentEmail) {
    return res.status(401).json({ ok: false, message: 'Please sign in again.' });
  }
  const { currentPassword, newPassword, oldPassword } = req.body;
  const current = String(oldPassword || currentPassword || '').trim();
  const newPwd = String(newPassword || '').trim();
  const email = String(req.session.studentEmail).trim().toLowerCase();
  const reg = String(req.session.studentId || '').trim();
  const registered =
    studentRegistrations[email] || (reg && REGISTER_NUMBER_REGEX.test(reg) ? studentRegistrations[reg + STUDENT_EMAIL_SUFFIX] : null);
  if (!registered) {
    return res.status(403).json({ ok: false, message: 'Account not found.' });
  }
  let validCurrent = false;
  if (registered.hashedPassword) {
    validCurrent = await bcrypt.compare(current, registered.hashedPassword);
  } else {
    validCurrent = !!(registered.password && current === registered.password);
  }
  if (!validCurrent) {
    return res.status(400).json({ ok: false, message: 'Current password is incorrect.' });
  }
  if (newPwd.length < 6 || newPwd.length > 32) {
    return res.status(400).json({ ok: false, message: 'New password must be 6–32 characters.' });
  }
  registered.hashedPassword = await bcrypt.hash(newPwd, BCRYPT_ROUNDS);
  registered.password = undefined;
  registered.firstLogin = false;
  // Persist updated student password.
  saveDatabase();
  return res.json({ ok: true, message: 'Password updated. Use your new password next time you sign in.' });
});

app.post('/api/student-logout', (req, res) => {
  req.session.studentEmail = null;
  req.session.studentId = null;
  req.session.mfaVerified = null;
  req.session.mfaRole = null;
  req.session.mfaAt = null;
  req.session.save((err) => {
    if (err) return res.status(500).json({ ok: false });
    return res.json({ ok: true });
  });
});

// Student session info (used to prefill OD form / UI)
app.get('/api/student/me', (req, res) => {
  if (!req.session || !req.session.studentEmail || !req.session.studentId) {
    return res.status(401).json({ ok: false, message: 'Please sign in as a student.' });
  }
  const email = String(req.session.studentEmail).trim().toLowerCase();
  const reg = resolveAttendanceRegisterNumberFromSession(req) || String(req.session.studentId || '').trim();
  const s = studentRegistrations[email] || studentRegistrations[reg + STUDENT_EMAIL_SUFFIX] || null;
  return res.json({
    ok: true,
    email,
    registerNumber: reg,
    name: s && s.name ? String(s.name) : '',
    timetableUrl: s && s.timetableUrl ? String(s.timetableUrl) : '',
    syncedVenue: s && s.syncedVenue ? String(s.syncedVenue) : '',
  });
});

app.post('/api/student/timetable-sync', async (req, res) => {
  if (!req.session || !req.session.studentEmail || !req.session.studentId) {
    return res.status(401).json({ ok: false, message: 'Please sign in as a student.' });
  }
  const email = String(req.session.studentEmail).trim().toLowerCase();
  const reg = String(req.session.studentId).trim();
  const s = studentRegistrations[email] || studentRegistrations[reg + STUDENT_EMAIL_SUFFIX] || null;
  if (!s) return res.status(404).json({ ok: false, message: 'Student profile not found.' });

  const timetableUrl = String((req.body && req.body.timetableUrl) || '').trim();
  if (!timetableUrl) {
    return res.status(400).json({ ok: false, message: 'Timetable URL is required.' });
  }

  try {
    const body = await fetchRemoteTextFromUrl(timetableUrl);
    const venue = extractVenueFromTimetablePayload(body);
    if (!venue) {
      return res.status(400).json({ ok: false, message: 'Could not detect venue from the provided timetable URL.' });
    }
    s.timetableUrl = timetableUrl;
    s.syncedVenue = venue;
    s.syncedVenueAt = new Date().toISOString();
    saveDatabase();
    return res.json({ ok: true, timetableUrl, venue, syncedAt: s.syncedVenueAt });
  } catch (err) {
    return res.status(400).json({ ok: false, message: err && err.message ? err.message : 'Unable to fetch timetable URL.' });
  }
});

app.get('/api/student/documents', (req, res) => {
  const student = resolveStudentRecordFromSession(req);
  if (!student) return res.status(401).json({ ok: false, message: 'Please sign in as a student.' });
  const docs = student.rec.studentDocuments || {};
  return res.json({
    ok: true,
    resume: sanitizeStudentDocMeta(docs.resume),
    certificate: sanitizeStudentDocMeta(docs.certificate),
    academicDetailsFile: sanitizeStudentDocMeta(docs.academicDetailsFile),
    academicProfile: student.rec.academicProfile && typeof student.rec.academicProfile === 'object'
      ? {
          department: String(student.rec.academicProfile.department || ''),
          yearOfStudy: String(student.rec.academicProfile.yearOfStudy || ''),
          cgpa: String(student.rec.academicProfile.cgpa || ''),
        }
      : { department: '', yearOfStudy: '', cgpa: '' },
  });
});

app.post('/api/student/documents', (req, res) => {
  const student = resolveStudentRecordFromSession(req);
  if (!student) return res.status(401).json({ ok: false, message: 'Please sign in as a student.' });
  const runUpload = studentDocsUpload.fields([
    { name: 'resume', maxCount: 1 },
    { name: 'certificate', maxCount: 1 },
    { name: 'academicDetailsFile', maxCount: 1 },
  ]);
  return runUpload(req, res, (err) => {
    if (err) {
      const msg = err && err.message ? err.message : 'Upload failed.';
      return res.status(400).json({ ok: false, message: msg });
    }
    if (!student.rec.studentDocuments || typeof student.rec.studentDocuments !== 'object') {
      student.rec.studentDocuments = {};
    }
    const docs = student.rec.studentDocuments;
    const nextAcademic = {
      department: String((req.body && req.body.department) || '').trim().slice(0, 80),
      yearOfStudy: String((req.body && req.body.yearOfStudy) || '').trim().slice(0, 40),
      cgpa: String((req.body && req.body.cgpa) || '').trim().slice(0, 20),
    };
    student.rec.academicProfile = nextAcademic;

    const fileFieldMap = ['resume', 'certificate', 'academicDetailsFile'];
    for (const field of fileFieldMap) {
      const one = req.files && req.files[field] && req.files[field][0] ? req.files[field][0] : null;
      if (!one) continue;
      const absPath = String(one.path || '');
      let sha256 = '';
      try {
        const buf = fs.readFileSync(absPath);
        sha256 = crypto.createHash('sha256').update(buf).digest('hex');
      } catch (_) {}
      const prev = docs[field];
      docs[field] = {
        fileId: path.basename(absPath),
        originalName: String(one.originalname || 'document'),
        mimeType: String(one.mimetype || ''),
        size: Number(one.size || 0),
        uploadedAt: new Date().toISOString(),
        sha256,
        path: absPath,
      };
      if (prev && prev.path && String(prev.path) !== absPath) {
        try { if (fs.existsSync(prev.path)) fs.unlinkSync(prev.path); } catch (_) { /* best effort */ }
      }
    }

    saveDatabase();
    return res.json({
      ok: true,
      message: 'Documents and academic details saved securely.',
      resume: sanitizeStudentDocMeta(docs.resume),
      certificate: sanitizeStudentDocMeta(docs.certificate),
      academicDetailsFile: sanitizeStudentDocMeta(docs.academicDetailsFile),
      academicProfile: nextAcademic,
    });
  });
});

app.get('/api/student/documents/download', (req, res) => {
  const student = resolveStudentRecordFromSession(req);
  if (!student) return res.status(401).json({ ok: false, message: 'Please sign in as a student.' });
  const docType = String(req.query.type || '').trim();
  const allowed = new Set(['resume', 'certificate', 'academicDetailsFile']);
  if (!allowed.has(docType)) return res.status(400).json({ ok: false, message: 'Invalid document type.' });
  const docs = student.rec.studentDocuments || {};
  const doc = docs[docType];
  if (!doc || !doc.path || !fs.existsSync(doc.path)) {
    return res.status(404).json({ ok: false, message: 'Document not found.' });
  }
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return res.download(doc.path, doc.originalName || 'document');
});

app.get('/api/profile/me', (req, res) => {
  const actor = resolveProfileActor(req);
  if (!actor) return res.status(401).json({ ok: false, message: 'Please sign in.' });
  const name = actor.rec && actor.rec.name ? String(actor.rec.name).trim() : '';
  const headline = actor.rec && actor.rec.profileHeadline ? String(actor.rec.profileHeadline).trim() : '';
  const profileImageUrl = actor.rec && actor.rec.profileImageUrl ? String(actor.rec.profileImageUrl).trim() : '';
  const designation = actor.rec && actor.rec.designation ? String(actor.rec.designation).trim() : '';
  return res.json({
    ok: true,
    role: actor.role,
    email: actor.email,
    name,
    designation,
    headline,
    profileImageUrl,
  });
});

// Lightweight endpoint for UI routing: tells which dashboard the signed-in session belongs to.
app.get('/api/dashboard-role', (req, res) => {
  if (!req.session) return res.status(401).json({ ok: false, message: 'Please sign in.' });
  if (req.session.studentEmail) {
    return res.json({ ok: true, role: 'student', dashboardPath: '/student' });
  }
  if (isAdminSession(req)) {
    return res.json({ ok: true, role: 'admin', dashboardPath: '/admin/registrations' });
  }
  if (req.session.userEmail && req.session.leadership) {
    return res.json({ ok: true, role: 'leadership', dashboardPath: '/leadership' });
  }
  if (req.session.userEmail) {
    return res.json({ ok: true, role: 'faculty', dashboardPath: '/' });
  }
  return res.status(401).json({ ok: false, message: 'Please sign in.' });
});

app.get('/api/firewall/status', ensureAnyDashboardAuth, (req, res) => {
  const actor = req.profileActor;
  const role = actor.role === 'student' ? 'student' : (req.session && req.session.leadership ? 'leadership' : 'faculty');
  const unlocked = !!(req.session && req.session.firewallUnlocked);
  const network = buildNetworkSnapshot(req, {});
  return res.json({
    ok: true,
    unlocked,
    role,
    usernameHint: FIREWALL_USERNAME,
    network,
  });
});

app.post('/api/firewall/login', ensureAnyDashboardAuth, (req, res) => {
  const actor = req.profileActor;
  const role = actor.role === 'student' ? 'student' : (req.session && req.session.leadership ? 'leadership' : 'faculty');
  const username = String((req.body && req.body.username) || '').trim();
  const password = String((req.body && req.body.password) || '').trim();
  const network = buildNetworkSnapshot(req, req.body && req.body.network);
  const userAgent = String(req.headers['user-agent'] || 'Unknown');
  const actorName = actor.rec && actor.rec.name ? String(actor.rec.name).trim() : '';
  const nowIso = new Date().toISOString();

  if (!firewallCredentialStrong) {
    return res.status(503).json({
      ok: false,
      message: 'Firewall credentials are weak/default. Set strong FIREWALL_USERNAME and FIREWALL_PASSWORD in .env.',
    });
  }

  if (!network.online) {
    appendFirewallNetworkLog({
      at: nowIso, role, email: actor.email, actorName, event: 'login_blocked_offline', details: 'Internet not connected.',
      ipAddress: network.ipAddress, userAgent, networkLabel: network.networkLabel, networkKey: network.networkKey,
    });
    saveDatabase();
    return res.status(400).json({ ok: false, message: 'No internet connection detected. Connect to internet and try again.' });
  }

  if (username !== FIREWALL_USERNAME || password !== FIREWALL_PASSWORD) {
    appendFirewallNetworkLog({
      at: nowIso, role, email: actor.email, actorName, event: 'login_failed', details: 'Invalid firewall credentials.',
      ipAddress: network.ipAddress, userAgent, networkLabel: network.networkLabel, networkKey: network.networkKey,
    });
    saveDatabase();
    return res.status(401).json({ ok: false, message: 'Invalid firewall username or password.' });
  }

  req.session.firewallUnlocked = true;
  req.session.firewallNetworkKey = network.networkKey;
  req.session.firewallUnlockedAt = nowIso;
  appendFirewallNetworkLog({
    at: nowIso, role, email: actor.email, actorName, event: 'login_success', details: 'Firewall access granted.',
    ipAddress: network.ipAddress, userAgent, networkLabel: network.networkLabel, networkKey: network.networkKey,
  });
  saveDatabase();
  return res.json({
    ok: true,
    message: 'Firewall login successful.',
    network,
    roomUrl: '/firewall-room',
  });
});

app.get('/api/firewall/network-logs', ensureAnyDashboardAuth, (req, res) => {
  const onlyCurrent = String((req.query && req.query.scope) || 'current').toLowerCase() !== 'all';
  const sessionNetworkKey = String((req.session && req.session.firewallNetworkKey) || '').trim();
  const rows = firewallNetworkLogs
    .filter((x) => {
      if (!x || typeof x !== 'object') return false;
      if (!onlyCurrent) return true;
      if (!sessionNetworkKey) return true;
      return String(x.networkKey || '') === sessionNetworkKey;
    })
    .sort((a, b) => String(a.at || '') < String(b.at || '') ? 1 : -1)
    .slice(0, 300);

  const seen = new Set();
  const connectedDevices = [];
  rows.forEach((x) => {
    if (String(x.event || '') !== 'login_success') return;
    const key = `${x.email}|${x.ipAddress}|${x.networkKey}`;
    if (seen.has(key)) return;
    seen.add(key);
    connectedDevices.push({
      at: x.at,
      email: x.email,
      role: x.role,
      actorName: x.actorName,
      ipAddress: x.ipAddress,
      networkLabel: x.networkLabel,
      userAgent: x.userAgent,
    });
  });

  return res.json({
    ok: true,
    unlocked: !!(req.session && req.session.firewallUnlocked),
    scope: onlyCurrent ? 'current' : 'all',
    connectedDevices: connectedDevices.slice(0, 120),
    logs: rows,
  });
});

app.post('/api/profile/update', profileUpload.single('profilePicture'), (req, res) => {
  const actor = resolveProfileActor(req);
  if (!actor) return res.status(401).json({ ok: false, message: 'Please sign in.' });

  const rawHeadline = req.body && req.body.headline != null ? String(req.body.headline) : '';
  const headline = rawHeadline.trim().slice(0, 120);
  actor.rec.profileHeadline = headline;

  if (req.file) {
    const nextUrl = `/profile-images/${req.file.filename}`;
    const prevUrl = actor.rec.profileImageUrl ? String(actor.rec.profileImageUrl) : '';
    actor.rec.profileImageUrl = nextUrl;
    if (prevUrl.startsWith('/profile-images/')) {
      const prevPath = path.join(PROFILE_DIR, path.basename(prevUrl));
      if (prevPath !== req.file.path) {
        try { if (fs.existsSync(prevPath)) fs.unlinkSync(prevPath); } catch (_) { /* best effort */ }
      }
    }
  }

  saveDatabase();
  return res.json({
    ok: true,
    headline: actor.rec.profileHeadline || '',
    profileImageUrl: actor.rec.profileImageUrl || '',
  });
});

app.get('/api/profile/device-sessions', (req, res) => {
  const actor = resolveProfileActor(req);
  if (!actor) return res.status(401).json({ ok: false, message: 'Please sign in.' });
  const rows = Array.isArray(actor.rec.deviceLoginSessions) ? actor.rec.deviceLoginSessions : [];
  const sessions = rows
    .map((x) => ({
      at: x && x.at ? String(x.at) : '',
      role: x && x.role ? String(x.role) : '',
      ipAddress: x && x.ipAddress ? String(x.ipAddress) : '',
      userAgent: x && x.userAgent ? String(x.userAgent) : '',
    }))
    .filter((x) => !!x.at)
    .sort((a, b) => (a.at < b.at ? 1 : -1));
  return res.json({ ok: true, sessions });
});

app.post('/api/profile/logout-all', (req, res) => {
  const actor = resolveProfileActor(req);
  if (!actor) return res.status(401).json({ ok: false, message: 'Please sign in.' });
  if (actor.rec.sessionVersion == null) actor.rec.sessionVersion = 0;
  actor.rec.sessionVersion = Number(actor.rec.sessionVersion || 0) + 1;
  saveDatabase();
  req.session.destroy(() => {
    return res.json({ ok: true, message: 'Signed out from all devices.' });
  });
});

app.get('/api/automation/config', (req, res) => {
  const actor = resolveProfileActor(req);
  if (!actor) return res.status(401).json({ ok: false, message: 'Please sign in.' });
  const enabled = actor.rec.automationEnabled === true;
  return res.json({ ok: true, enabled });
});

app.post('/api/automation/config', (req, res) => {
  const actor = resolveProfileActor(req);
  if (!actor) return res.status(401).json({ ok: false, message: 'Please sign in.' });
  const enabled = !!(req.body && req.body.enabled);
  actor.rec.automationEnabled = enabled;
  appendAutomationLog(actor.rec, {
    role: actor.role === 'student' ? 'student' : (req.session && req.session.leadership ? 'leadership' : 'faculty'),
    event: enabled ? 'automation_enabled' : 'automation_disabled',
    details: enabled ? 'AI automations enabled by user.' : 'AI automations disabled by user.',
  });
  saveDatabase();
  return res.json({ ok: true, enabled });
});

app.get('/api/automation/logs', (req, res) => {
  const actor = resolveProfileActor(req);
  if (!actor) return res.status(401).json({ ok: false, message: 'Please sign in.' });
  const rows = Array.isArray(actor.rec.automationLogs) ? actor.rec.automationLogs : [];
  const logs = rows
    .map((x) => ({
      at: x && x.at ? String(x.at) : '',
      role: x && x.role ? String(x.role) : '',
      event: x && x.event ? String(x.event) : '',
      details: x && x.details ? String(x.details) : '',
    }))
    .filter((x) => !!x.at)
    .sort((a, b) => (a.at < b.at ? 1 : -1))
    .slice(0, 100);
  return res.json({ ok: true, logs });
});

/** Combined feed for dashboard notification bell (automation activity + support inbox). */
app.get('/api/notifications/panel', (req, res) => {
  const actor = resolveProfileActor(req);
  if (!actor) return res.status(401).json({ ok: false, message: 'Please sign in.' });
  const myEmail = String(actor.email || '').trim().toLowerCase();
  const items = [];

  const logRows = Array.isArray(actor.rec.automationLogs) ? actor.rec.automationLogs : [];
  logRows
    .map((x) => {
      const at = x && x.at ? String(x.at) : '';
      const ev = x && x.event ? String(x.event) : '';
      return {
        id: at && ev ? `auto:${at}:${ev}` : `auto:${at || Math.random()}`,
        kind: 'automation',
        at,
        title: ev ? ev.replace(/_/g, ' ') : 'AI agent activity',
        body: x && x.details ? String(x.details) : '',
      };
    })
    .filter((x) => !!x.at)
    .sort((a, b) => (a.at < b.at ? 1 : -1))
    .slice(0, 20)
    .forEach((x) => items.push(x));

  supportRequests
    .filter((x) => x && typeof x === 'object' && String(x.email || '').trim().toLowerCase() === myEmail)
    .map((x) => ({
      id: `support:${x.id ? String(x.id) : ''}`,
      kind: 'support',
      at: x.createdAt ? String(x.createdAt) : '',
      title: x.subject ? String(x.subject) : 'Support request',
      body: x.message ? String(x.message).slice(0, 280) : '',
    }))
    .filter((x) => !!x.at)
    .sort((a, b) => (a.at < b.at ? 1 : -1))
    .slice(0, 15)
    .forEach((x) => items.push(x));

  items.sort((a, b) => (a.at < b.at ? 1 : -1));

  const clearedRaw = actor.rec && actor.rec.notificationsPanelClearedAt;
  let clearedMs = 0;
  if (clearedRaw) {
    const d = new Date(String(clearedRaw));
    if (!Number.isNaN(d.getTime())) clearedMs = d.getTime();
  }
  const visible = items.filter((x) => {
    const t = new Date(x.at).getTime();
    return !Number.isNaN(t) && t > clearedMs;
  });

  return res.json({ ok: true, items: visible.slice(0, 35) });
});

/** Dismiss all items in the notification bell (does not delete automation logs or support tickets). */
app.post('/api/notifications/clear', express.json({ limit: '2kb' }), (req, res) => {
  const actor = resolveProfileActor(req);
  if (!actor) return res.status(401).json({ ok: false, message: 'Please sign in.' });
  if (!actor.rec || typeof actor.rec !== 'object') return res.status(500).json({ ok: false, message: 'Profile error.' });
  actor.rec.notificationsPanelClearedAt = new Date().toISOString();
  saveDatabase();
  return res.json({ ok: true, clearedAt: actor.rec.notificationsPanelClearedAt });
});

app.get('/api/feed/posts', ensureAnyDashboardAuth, (req, res) => {
  const viewerEmail = String((req.profileActor && req.profileActor.email) || '').trim().toLowerCase();
  const posts = campusFeedPosts
    .slice()
    .sort((a, b) => (String(a.createdAt || '') < String(b.createdAt || '') ? 1 : -1))
    .slice(0, 100)
    .map((p) => sanitizeCampusFeedPost(p, viewerEmail));
  return res.json({ ok: true, posts });
});

app.post('/api/feed/media-upload', ensureAnyDashboardAuth, (req, res) => {
  if (!canCreateCampusFeedPost(req)) {
    return res.status(403).json({ ok: false, message: 'Only faculty/leadership can upload media.' });
  }
  feedMediaUpload.single('media')(req, res, (err) => {
    if (err) {
      return res.status(400).json({ ok: false, message: err && err.message ? err.message : 'Media upload failed.' });
    }
    const f = req.file;
    if (!f || !f.filename) {
      return res.status(400).json({ ok: false, message: 'No media file uploaded.' });
    }
    const url = `/feed-media/${encodeURIComponent(f.filename)}`;
    return res.json({
      ok: true,
      mediaUrl: url,
      mediaType: String(f.mimetype || ''),
      mediaName: String(f.originalname || ''),
    });
  });
});

app.post('/api/feed/posts', ensureAnyDashboardAuth, express.json({ limit: '16kb' }), (req, res) => {
  if (!canCreateCampusFeedPost(req)) {
    return res.status(403).json({ ok: false, message: 'Only faculty/leadership can create feed posts.' });
  }
  const actor = req.profileActor;
  const text = String((req.body && req.body.text) || '').trim();
  const mediaUrl = String((req.body && req.body.mediaUrl) || '').trim();
  const mediaType = String((req.body && req.body.mediaType) || '').trim().toLowerCase();
  const mediaName = String((req.body && req.body.mediaName) || '').trim();
  const repostOfId = String((req.body && req.body.repostOfId) || '').trim();
  if ((!text || text.length < 2 || text.length > 1500) && !mediaUrl) {
    return res.status(400).json({ ok: false, message: 'Post text (2-1500 chars) or media is required.' });
  }
  if (mediaUrl && !mediaUrl.startsWith('/feed-media/')) {
    return res.status(400).json({ ok: false, message: 'Invalid media URL.' });
  }
  if (mediaType && !mediaType.startsWith('image/') && !mediaType.startsWith('video/')) {
    return res.status(400).json({ ok: false, message: 'Only image or video media is supported.' });
  }
  const basePost = repostOfId ? campusFeedPosts.find((x) => String(x.id) === repostOfId) : null;
  const id = `post_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const post = {
    id,
    text,
    mediaUrl,
    mediaType,
    mediaName,
    authorName: String((actor.rec && actor.rec.name) || actor.email || 'Faculty').trim(),
    authorDesignation: String((actor.rec && actor.rec.designation) || '').trim(),
    authorRole: getCampusFeedRole(req),
    createdAt: new Date().toISOString(),
    reactions: { like: 0, love: 0, celebrate: 0, insightful: 0 },
    userReactions: {},
    comments: [],
    repostCount: 0,
    shareCount: 0,
    repostOf: basePost ? {
      id: String(basePost.id || ''),
      text: String(basePost.text || ''),
      authorName: String(basePost.authorName || ''),
    } : null,
  };
  if (basePost) {
    basePost.repostCount = Number(basePost.repostCount || 0) + 1;
  }
  campusFeedPosts.unshift(post);
  if (campusFeedPosts.length > 300) campusFeedPosts.length = 300;
  saveDatabase();
  return res.json({ ok: true, post: sanitizeCampusFeedPost(post, actor.email) });
});

app.post('/api/feed/posts/:id/react', ensureAnyDashboardAuth, express.json({ limit: '4kb' }), (req, res) => {
  const id = String(req.params.id || '').trim();
  const reaction = String((req.body && req.body.reaction) || '').trim().toLowerCase();
  const allowed = new Set(['like', 'love', 'celebrate', 'insightful']);
  if (!allowed.has(reaction)) return res.status(400).json({ ok: false, message: 'Invalid reaction.' });
  const post = campusFeedPosts.find((x) => String(x.id) === id);
  if (!post) return res.status(404).json({ ok: false, message: 'Post not found.' });
  if (!post.reactions || typeof post.reactions !== 'object') post.reactions = { like: 0, love: 0, celebrate: 0, insightful: 0 };
  if (!post.userReactions || typeof post.userReactions !== 'object') post.userReactions = {};
  const email = String((req.profileActor && req.profileActor.email) || '').trim().toLowerCase();
  const old = String(post.userReactions[email] || '').trim().toLowerCase();
  if (old && post.reactions[old] > 0) post.reactions[old] -= 1;
  post.userReactions[email] = reaction;
  post.reactions[reaction] = Number(post.reactions[reaction] || 0) + 1;
  saveDatabase();
  return res.json({ ok: true, post: sanitizeCampusFeedPost(post, email) });
});

app.post('/api/feed/posts/:id/comment', ensureAnyDashboardAuth, express.json({ limit: '8kb' }), (req, res) => {
  const id = String(req.params.id || '').trim();
  const text = String((req.body && req.body.text) || '').trim();
  if (!text || text.length < 1 || text.length > 800) {
    return res.status(400).json({ ok: false, message: 'Comment text must be between 1 and 800 characters.' });
  }
  const post = campusFeedPosts.find((x) => String(x.id) === id);
  if (!post) return res.status(404).json({ ok: false, message: 'Post not found.' });
  if (!Array.isArray(post.comments)) post.comments = [];
  post.comments.push({
    id: `c_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
    text,
    authorName: String((req.profileActor.rec && req.profileActor.rec.name) || req.profileActor.email || 'User').trim(),
    authorRole: req.profileActor.role === 'student' ? 'student' : getCampusFeedRole(req),
    createdAt: new Date().toISOString(),
  });
  if (post.comments.length > 100) post.comments = post.comments.slice(post.comments.length - 100);
  saveDatabase();
  return res.json({ ok: true, post: sanitizeCampusFeedPost(post, req.profileActor.email) });
});

app.post('/api/feed/posts/:id/share', ensureAnyDashboardAuth, (req, res) => {
  const id = String(req.params.id || '').trim();
  const post = campusFeedPosts.find((x) => String(x.id) === id);
  if (!post) return res.status(404).json({ ok: false, message: 'Post not found.' });
  post.shareCount = Number(post.shareCount || 0) + 1;
  saveDatabase();
  return res.json({ ok: true, post: sanitizeCampusFeedPost(post, req.profileActor.email) });
});

app.post('/api/automation/run', (req, res) => {
  const actor = resolveProfileActor(req);
  if (!actor) return res.status(401).json({ ok: false, message: 'Please sign in.' });

  const actorRole = actor.role === 'student' ? 'student' : (req.session && req.session.leadership ? 'leadership' : 'faculty');
  const nowIso = new Date().toISOString();

  const enabled = actor.rec && actor.rec.automationEnabled === true;
  if (!enabled) {
    return res.json({ ok: true, enabled: false, at: nowIso, actions: [] });
  }

  const actions = [];
  (async () => {
    if (actorRole === 'student') {
      const studentEmail = actor.email;
      const studentName = actor.rec && actor.rec.name ? String(actor.rec.name).trim() : '';
      const reg = req.session && req.session.studentId ? String(req.session.studentId).trim() : '';

      const timetableUrl = actor.rec && actor.rec.timetableUrl ? String(actor.rec.timetableUrl).trim() : '';
      const syncedVenue = actor.rec && actor.rec.syncedVenue ? String(actor.rec.syncedVenue).trim() : '';
      const wantsTimetable = !timetableUrl || !syncedVenue;

      const actSessId = lastActiveSessionId;
      const actSess = actSessId && sessions[actSessId] ? sessions[actSessId] : null;
      const live = !!(actSess && globalSessionActive);
      actions.push({
        type: 'dashboard',
        feature: 'student.session_gate',
        dashboardPath: '/student',
        title: 'Class session',
        message: live
          ? `College session is live: "${actSess.topic || actSessId}". Use Start camera on the student dashboard when you join the class.`
          : 'No college session is broadcasting. EduMate and profile tools stay available.',
        voiceText: live
          ? 'A class session is live. Open the student dashboard and start your camera when you are in class.'
          : 'There is no active college session broadcasting right now.',
        uiActions: live
          ? ['open_chatbot', 'scroll_student_session', 'start_camera', 'start_streaming']
          : ['open_chatbot', 'scroll_student_session', 'stop_streaming', 'stop_camera'],
      });

      const docObj =
        actor.rec && actor.rec.studentDocuments && typeof actor.rec.studentDocuments === 'object'
          ? actor.rec.studentDocuments
          : {};
      const docCount = Object.keys(docObj).length;
      actions.push({
        type: 'dashboard',
        feature: 'student.documents',
        dashboardPath: '/student',
        title: 'My documents',
        message:
          docCount > 0
            ? `You have ${docCount} file(s) in My documents (resumes, OD-related uploads, etc.).`
            : 'No documents uploaded yet. Use My documents on the student dashboard to add files.',
        voiceText:
          docCount > 0 ? `You have ${docCount} documents on file.` : 'You have no documents uploaded yet.',
        uiActions: ['open_chatbot', 'open_resume_documents'],
      });

      const attRows = Object.values(attendanceRecords).filter(
        (r) => r && String(r.registerNumber || '').trim() === reg
      );
      actions.push({
        type: 'dashboard',
        feature: 'student.smart_attendance',
        dashboardPath: '/student',
        title: 'Smart attendance & OD',
        message: `The system has ${attRows.length} attendance row(s) tied to your register number. View history and OD status on the student dashboard.`,
        voiceText: `Attendance history shows ${attRows.length} entries for you.`,
        uiActions: ['open_chatbot', 'scroll_student_attendance', 'refresh_student_attendance', 'scroll_student_od', 'refresh_od_status'],
      });

      actions.push({
        type: 'dashboard',
        feature: 'student.timetable_venue',
        dashboardPath: '/student',
        title: 'Timetable & venue',
        message: wantsTimetable
          ? syncedVenue
            ? 'Add or refresh your timetable URL so venue hints stay accurate.'
            : 'Save your timetable URL and run sync so the dashboard can detect your venue.'
          : `Timetable linked; last synced venue: ${syncedVenue || '—'}.`,
        voiceText: wantsTimetable
          ? 'Please sync your timetable from the student dashboard.'
          : 'Your timetable and venue look configured.',
        uiActions: wantsTimetable
          ? ['open_chatbot', 'scroll_student_connection', 'open_timetable_sync']
          : ['open_chatbot', 'scroll_student_connection'],
      });

      // Timetable reminder.
      if (wantsTimetable) {
        const throttleKey = 'timetableReminderAt';
        const due = canSendAutomationEmail(actor.rec, throttleKey, 24 * 60 * 60 * 1000);
        actions.push({
          type: 'reminder',
          title: 'Timetable sync',
          message: due ? 'Email reminder sent (timetable not synced yet).' : 'Timetable reminder throttle active; not emailed.',
          voiceText: 'Please sync your timetable so the system can detect your venue.',
          uiActions: ['open_chatbot', 'open_timetable_sync', 'scroll_student_connection'],
        });
        if (due) {
          const subject = 'Action needed: sync your timetable';
          const messageText = `Hello ${studentName || 'student'},\n\nPlease sync your timetable URL in the Student dashboard so the system can auto-detect your venue.\n\nRegister Number: ${reg || '-'}\n\nIf you already synced recently, you can ignore this email.`;
          const ok = await sendAutomationEmail(studentEmail, subject, messageText);
          appendAutomationLog(actor.rec, { at: nowIso, role: 'student', event: 'timetable_reminder_email', details: ok ? 'Sent' : 'Send failed' });
        }
      }

      // OD reminder for the currently active session.
      const activeSessionId = lastActiveSessionId;
      if (activeSessionId && reg) {
        const key = `${activeSessionId}:${reg}`;
        const record = attendanceRecords[key];
        const sess = sessions[activeSessionId];
        const topic = sess && sess.topic ? String(sess.topic) : '';

        let shouldRemind = false;
        let reason = '';
        if (!record || record.status !== 'OD') {
          shouldRemind = true;
          reason = 'No OD proof submitted for the current session.';
        } else {
          const oa = record.odApproval || {};
          const hod = oa.hod || null;
          if (!hod || hod.decision !== 'accepted') {
            shouldRemind = true;
            if (hod && hod.decision === 'rejected') reason = 'Your OD proof was rejected (final approval required again).';
            else reason = 'Your OD proof is pending HoD final approval.';
          }
        }

        if (shouldRemind) {
          const throttleKey = 'odReminderAt:' + activeSessionId;
          const due = canSendAutomationEmail(actor.rec, throttleKey, 30 * 60 * 1000);
          actions.push({
            type: 'reminder',
            title: 'OD proof status',
            message: due ? 'Email reminder queued/sent for current OD status.' : 'OD reminder throttle active; not emailed.',
            voiceText: 'OD proof action needed. Please upload OD proof for the current session.',
            uiActions: ['open_chatbot', 'scroll_student_od', 'open_od_form', 'refresh_od_status'],
          });
          if (due) {
            const subject = 'OD proof action needed (current session)';
            const messageText = `Hello ${studentName || 'student'},\n\n${reason}\n\nCurrent session: ${topic || activeSessionId}\nRegister Number: ${reg}\n\nPlease upload your OD proof using the OD form in your Student dashboard when the class is active.`;
            const ok = await sendAutomationEmail(studentEmail, subject, messageText);
            appendAutomationLog(actor.rec, { at: nowIso, role: 'student', event: 'od_reminder_email', details: ok ? 'Sent' : 'Send failed' });
          }
        }
      }
    } else if (actorRole === 'faculty') {
      const facultyEmail = actor.email;
      const email = facultyEmail ? String(facultyEmail).trim().toLowerCase() : '';
      const mySessions = Object.values(sessions).filter(
        (s) => s && String(s.ownerEmail || '').trim().toLowerCase() === email
      );
      const openMine = mySessions.filter((s) => !s.closed);
      const openLabels = openMine.map((s) => s.topic || s.id).filter(Boolean);
      actions.push({
        type: 'dashboard',
        feature: 'faculty.sessions',
        dashboardPath: '/',
        title: 'Your sessions',
        message: openMine.length
          ? `You have ${openMine.length} open session(s)${openLabels.length ? `: ${openLabels.join(', ')}` : ''}. Start attention and smart attendance from Session details on the faculty dashboard.`
          : 'You have no open sessions. Open Session details to start attention tracking.',
        voiceText: openMine.length
          ? `You have ${openMine.length} open class sessions.`
          : 'No open sessions. Start one from session details.',
        uiActions: ['open_chatbot', 'faculty_scroll_sessions', 'faculty_scroll_classroom_camera', 'faculty_refresh_attendance'],
      });

      const activeSessionId = lastActiveSessionId;
      const sess = activeSessionId ? sessions[activeSessionId] : null;

      if (sess && sess.ownerEmail === email && !sess.closed && !sess.endTime) {
        const sixtySecAgo = Date.now() - 60 * 1000;
        const hist = (sess.attentionHistory || []).filter((p) => new Date(p.t).getTime() >= sixtySecAgo);
        const avg = hist.length
          ? hist.reduce((a, p) => a + Number(p.score || 0), 0) / hist.length
          : 0;
        const dev = pruneDeviceIds(sess);
        actions.push({
          type: 'dashboard',
          feature: 'faculty.live_teaching_pulse',
          dashboardPath: '/',
          title: 'Live Teaching Pulse',
          message: `Your active session "${sess.topic || activeSessionId}": last-minute class attention ~${avg.toFixed(1)}% · ${dev} student device(s) contributing (faculty dashboard).`,
          voiceText: `Live attention is about ${Math.round(avg)} percent from ${dev} devices.`,
          uiActions: ['open_chatbot', 'faculty_scroll_pulse', 'faculty_scroll_digital_twin', 'faculty_scroll_classroom_camera', 'faculty_refresh_attendance'],
        });

        const startedAt = sess.startTime ? new Date(sess.startTime).getTime() : Date.now();
        const ageMs = Date.now() - startedAt;
        if (ageMs > 2 * 60 * 1000) {
          const throttleKey = 'facultySessionTipAt:' + activeSessionId;
          const due = canSendAutomationEmail(actor.rec, throttleKey, 30 * 60 * 1000);
          actions.push({
            type: 'info',
            title: 'Faculty session checklist',
            message: due ? 'Faculty reminder email sent.' : 'Faculty reminder throttle active; not emailed.',
            voiceText: 'Faculty reminder. Session is active. Capture attendance and monitor OD approvals.',
            uiActions: ['open_chatbot', 'faculty_scroll_pulse', 'faculty_scroll_sessions', 'faculty_refresh_attendance'],
          });
          if (due) {
            const subject = 'Session checklist reminder';
            const messageText = `Hello ${actor.rec && actor.rec.name ? actor.rec.name : 'Faculty'},\n\nYour class session is currently active.\n\nTopic: ${sess.topic || '-'}\nVenue: ${sess.venue || '-'}\nStart: ${sess.startTime || '-'}\n\nPlease ensure attendance is captured and OD approvals are monitored via the Leadership dashboards when proofs are uploaded.`;
            const ok = await sendAutomationEmail(email, subject, messageText);
            appendAutomationLog(actor.rec, { at: nowIso, role: 'faculty', event: 'faculty_session_reminder_email', details: ok ? 'Sent' : 'Send failed' });
          }
        }
      } else {
        actions.push({
          type: 'tip',
          title: 'Session checklist',
          message: 'No active session found for your account right now.',
          voiceText: 'No active class session on your account right now. Start a session to use the attendance checklist.',
          uiActions: ['open_chatbot', 'faculty_scroll_sessions', 'faculty_scroll_classroom_camera'],
        });
      }
    } else if (actorRole === 'leadership') {
      const leaderEmail = actor.email;
      const ov = getLeadershipOverviewMetrics(req);
      const avgPart =
        ov.averageAttentionAll != null
          ? `Average recorded attention (in scope): ${ov.averageAttentionAll}%. `
          : '';
      actions.push({
        type: 'dashboard',
        feature: 'leadership.overview',
        dashboardPath: '/leadership',
        title: 'Leadership overview',
        message: `${ov.scopeDescription} ${ov.totalSessions} session(s) in scope (${ov.openSessions} open). ${avgPart}${ov.lowAttentionSessions} session(s) below the 45% attention threshold. ${ov.totalOdCount} OD row(s) across these sessions.`,
        voiceText: `Overview: ${ov.totalSessions} sessions, ${ov.openSessions} open. ${ov.lowAttentionSessions} low-attention classes. ${ov.totalOdCount} on-duty rows.`,
        uiActions: ['open_chatbot', 'leadership_scroll_overview', 'leadership_scroll_sessions', 'leadership_scroll_dept_attendance', 'leadership_scroll_od_queue', 'leadership_refresh_data'],
      });

      // Determine stage from stored designation/department on user record.
      const userDesignation = actor.rec && actor.rec.designation ? String(actor.rec.designation) : '';
      const meDeptCode = actor.rec && actor.rec.department ? String(actor.rec.department).trim().toLowerCase() : '';
      const stage = isAssistantHoDDesignation(userDesignation) ? 'ahod' : (isHeadOfDepartmentDesignation(userDesignation) ? 'hod' : null);

      if (!stage) {
        actions.push({
          type: 'info',
          title: 'OD queue automation',
          message:
            'AHOD/HoD queue emails are not enabled for your designation. You still have full Leadership dashboard access (overview, attendance, OD review where applicable).',
          voiceText: 'OD queue automation is for assistant head of department and head of department roles only.',
          uiActions: ['open_chatbot', 'leadership_scroll_overview', 'leadership_refresh_data'],
        });
      } else {
        const records = Object.values(attendanceRecords).filter((r) => r && r.status === 'OD');
        const items = [];
        records.forEach((r) => {
          const s = sessions[r.sessionId];
          if (!s) return;
          const owner = users[s.ownerEmail];
          const ownerDept = owner && owner.department ? String(owner.department).trim().toLowerCase() : '';
          if (meDeptCode && ownerDept && ownerDept !== meDeptCode) return;
          if (stage === 'ahod') {
            if (r.odApproval && r.odApproval.ahod) return;
          } else if (stage === 'hod') {
            const ahod = r.odApproval && r.odApproval.ahod ? r.odApproval.ahod : null;
            if (!ahod || ahod.decision !== 'accepted') return;
            if (r.odApproval && r.odApproval.hod) return;
          }
          items.push({ sessionId: r.sessionId, registerNumber: r.registerNumber, odName: r.odName, topic: s.topic });
        });
        const pending = items.length;
        actions.push({
          type: 'summary',
          title: 'OD approvals pending',
          message: `${pending} item(s) pending for your queue (${stage.toUpperCase()}).`,
          voiceText: `OD approvals are pending. Please review your queue in the Leadership dashboard (${stage.toUpperCase()}).`,
          uiActions:
            pending > 0
              ? ['open_chatbot', 'leadership_scroll_od_queue', 'leadership_refresh_data', 'load_od_queue']
              : ['open_chatbot', 'leadership_scroll_overview', 'leadership_refresh_data'],
        });
        if (pending > 0) {
          const throttleKey = 'leadershipOdQueueAt:' + stage + ':' + (meDeptCode || 'all');
          const due = canSendAutomationEmail(actor.rec, throttleKey, 15 * 60 * 1000);
          if (due) {
            const subject = `OD queue reminder (${stage.toUpperCase()})`;
            const sample = items.slice(0, 3).map((x) => `- ${x.registerNumber} (${x.topic || x.sessionId})`).join('\n');
            const messageText = `Hello,\n\nYou have ${pending} OD proof item(s) pending ${stage === 'ahod' ? 'Assistant HoD (AHOD)' : 'HoD'} final decision.\n\nSample items:\n${sample}\n\nPlease review the queue in the Leadership dashboard and approve/reject as required.`;
            const ok = await sendAutomationEmail(leaderEmail, subject, messageText);
            appendAutomationLog(actor.rec, { at: nowIso, role: 'leadership', event: 'leadership_od_queue_email', details: ok ? 'Sent' : 'Send failed' });
            actions.push({
              type: 'reminder',
              title: 'OD queue reminder',
              message: 'OD queue reminder sent.',
              voiceText: 'OD approvals are pending in your queue.',
              uiActions: ['open_chatbot', 'leadership_scroll_od_queue', 'leadership_refresh_data', 'load_od_queue'],
            });
          }
        }
      }
    }

    if (!actions.length) {
      const idleMessage = actorRole === 'student'
        ? 'No pending reminders right now. Timetable sync and OD status are up to date.'
        : actorRole === 'faculty'
          ? 'No pending AI agent checklist right now.'
          : 'No pending OD queue alerts right now.';
      actions.push({
        type: 'info',
        title: 'AI agent status',
        message: idleMessage,
        voiceText: idleMessage,
      });
    }

    appendAutomationLog(actor.rec, { at: nowIso, role: actorRole, event: 'automation_run', details: `Run completed with ${actions.length} action(s).` });
    saveDatabase();
    return res.json({ ok: true, at: nowIso, actions });
  })().catch((err) => {
    return res.status(500).json({ ok: false, message: err && err.message ? err.message : 'Automation run failed.' });
  });
});

app.post('/api/support/contact', async (req, res) => {
  const actor = resolveProfileActor(req);
  if (!actor) return res.status(401).json({ ok: false, message: 'Please sign in.' });

  const subject = String((req.body && req.body.subject) || '').trim().slice(0, 140);
  const message = String((req.body && req.body.message) || '').trim().slice(0, 3000);
  if (!subject) return res.status(400).json({ ok: false, message: 'Subject is required.' });
  if (!message) return res.status(400).json({ ok: false, message: 'Message is required.' });

  const actorName = actor.rec && actor.rec.name ? String(actor.rec.name).trim() : '';
  const actorRole = actor.role === 'student' ? 'student' : (req.session && req.session.leadership ? 'leadership' : 'faculty');
  const nowIso = new Date().toISOString();
  const ticketId = `SUP-${Date.now()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
  const item = {
    id: ticketId,
    createdAt: nowIso,
    role: actorRole,
    email: actor.email,
    name: actorName,
    subject,
    message,
    ip: req.ip || '',
    userAgent: String(req.headers['user-agent'] || ''),
  };
  supportRequests.push(item);
  // Prevent unbounded growth in db.json
  if (supportRequests.length > 500) supportRequests.splice(0, supportRequests.length - 500);
  saveDatabase();

  if (smtpConfigured && process.env.SMTP_USER) {
    try {
      const mailOptions = {
        from: process.env.FROM_EMAIL || process.env.SMTP_USER,
        to: process.env.SUPPORT_EMAIL || process.env.SMTP_USER,
        subject: `[Support][${actorRole}] ${subject}`,
        text:
`Support/Contact request received

Ticket ID: ${ticketId}
Time: ${nowIso}
Role: ${actorRole}
Name: ${actorName || '-'}
Email: ${actor.email}
IP: ${item.ip || '-'}
User-Agent: ${item.userAgent || '-'}

Message:
${message}`,
      };
      await transporter.sendMail(mailOptions);
    } catch (e) {
      // Keep request saved even if mail fails.
      console.error('Support email send failed:', e && e.message ? e.message : e);
    }
  }

  return res.json({ ok: true, message: 'Support request submitted successfully.', ticketId });
});

app.get('/api/support/inbox', (req, res) => {
  const actor = resolveProfileActor(req);
  if (!actor) return res.status(401).json({ ok: false, message: 'Please sign in.' });
  const myEmail = String(actor.email || '').trim().toLowerCase();
  const rows = supportRequests
    .filter((x) => x && typeof x === 'object' && String(x.email || '').trim().toLowerCase() === myEmail)
    .map((x) => ({
      id: x.id ? String(x.id) : '',
      createdAt: x.createdAt ? String(x.createdAt) : '',
      role: x.role ? String(x.role) : '',
      subject: x.subject ? String(x.subject) : '',
      message: x.message ? String(x.message) : '',
    }))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, 200);
  return res.json({ ok: true, items: rows });
});

app.post('/api/support/inbox/send', async (req, res) => {
  const actor = resolveProfileActor(req);
  if (!actor) return res.status(401).json({ ok: false, message: 'Please sign in.' });
  if (!smtpConfigured || !transporter) {
    return res.status(503).json({ ok: false, message: 'Email service is not configured.' });
  }

  const action = String((req.body && req.body.action) || '').trim().toLowerCase();
  const ticketId = String((req.body && req.body.ticketId) || '').trim().slice(0, 80);
  const subject = String((req.body && req.body.subject) || '').trim().slice(0, 200);
  const message = String((req.body && req.body.message) || '').trim().slice(0, 4000);
  const toRaw = String((req.body && req.body.to) || '').trim().toLowerCase();

  if (action !== 'reply' && action !== 'forward') {
    return res.status(400).json({ ok: false, message: 'action must be reply or forward.' });
  }
  if (!ticketId) return res.status(400).json({ ok: false, message: 'ticketId is required.' });
  if (!subject) return res.status(400).json({ ok: false, message: 'subject is required.' });
  if (!message) return res.status(400).json({ ok: false, message: 'message is required.' });

  const myEmail = String(actor.email || '').trim().toLowerCase();
  const ticket = supportRequests.find((x) => x && x.id === ticketId && String(x.email || '').trim().toLowerCase() === myEmail);
  if (!ticket) return res.status(404).json({ ok: false, message: 'Inbox ticket not found.' });

  let recipient = process.env.SUPPORT_EMAIL || process.env.SMTP_USER || '';
  if (action === 'forward') {
    const looksLikeEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(toRaw);
    if (!looksLikeEmail) return res.status(400).json({ ok: false, message: 'Valid recipient email is required for forward.' });
    recipient = toRaw;
  }
  if (!recipient) return res.status(503).json({ ok: false, message: 'No recipient email configured.' });

  const actorRole = actor.role === 'student' ? 'student' : (req.session && req.session.leadership ? 'leadership' : 'faculty');
  const actorName = actor.rec && actor.rec.name ? String(actor.rec.name).trim() : '';
  const mailSubject = action === 'reply' ? `[Inbox Reply][${ticketId}] ${subject}` : `[Inbox Forward][${ticketId}] ${subject}`;
  const mailBody =
`${action === 'reply' ? 'Reply' : 'Forward'} from dashboard inbox

Ticket ID: ${ticketId}
Actor Role: ${actorRole}
Actor Name: ${actorName || '-'}
Actor Email: ${actor.email}
Original Subject: ${ticket.subject ? String(ticket.subject) : '-'}
Original Message:
${ticket.message ? String(ticket.message) : '-'}

${action === 'forward' ? `Forward To: ${recipient}\n` : ''}Message:
${message}`;

  try {
    await transporter.sendMail({
      from: process.env.FROM_EMAIL || process.env.SMTP_USER,
      to: recipient,
      subject: mailSubject,
      text: mailBody,
      replyTo: actor.email,
    });
    return res.json({ ok: true, message: action === 'reply' ? 'Reply email sent.' : 'Forward email sent.' });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e && e.message ? e.message : 'Unable to send email.' });
  }
});

// Student: OD proof approval status for current session (no leadership data exposed).
app.get('/api/student/od-status', (req, res) => {
  if (!req.session || !req.session.studentId) {
    return res.status(401).json({ ok: false, message: 'Please sign in as a student.' });
  }
  const sessionId = String(req.query.sessionId || '').trim();
  if (!sessionId) {
    return res.status(400).json({ ok: false, message: 'sessionId is required.' });
  }
  const reg = String(req.session.studentId).trim();
  const key = `${sessionId}:${reg}`;
  const record = attendanceRecords[key];
  const sess = sessions[sessionId];
  const topic = sess && sess.topic ? String(sess.topic) : '';

  if (!record || record.status !== 'OD') {
    return res.json({
      ok: true,
      hasOd: false,
      phase: 'none',
      headline: 'No OD proof submitted for this session.',
      detail:
        'Upload your OD proof using the form when the class session is active. After upload, approval is handled on the AHOD and HoD leadership dashboards.',
    });
  }

  const oa = record.odApproval || { ahod: null, hod: null };
  const ahod = oa.ahod || null;
  const hod = oa.hod || null;

  if (ahod && ahod.decision === 'rejected') {
    return res.json({
      ok: true,
      hasOd: true,
      phase: 'rejected_ahod',
      headline: 'OD proof not approved (Assistant HoD)',
      detail: ahod.reason ? String(ahod.reason) : 'Please contact your department if you need clarification.',
      topic,
    });
  }
  if (hod && hod.decision === 'rejected') {
    return res.json({
      ok: true,
      hasOd: true,
      phase: 'rejected_hod',
      headline: 'OD proof not approved (HoD)',
      detail: hod.reason ? String(hod.reason) : 'Please contact your department if you need clarification.',
      topic,
    });
  }
  if (hod && hod.decision === 'accepted') {
    return res.json({
      ok: true,
      hasOd: true,
      phase: 'approved',
      headline: 'Fully approved — AHOD & HoD',
      detail:
        'Your proof was approved by the Assistant Head of Department and the Head of Department. You should also receive a confirmation email at your registered address when SMTP is configured. Your faculty can now finalize OD in Smart Attendance.',
      topic,
    });
  }
  if (ahod && ahod.decision === 'accepted') {
    return res.json({
      ok: true,
      hasOd: true,
      phase: 'pending_hod',
      headline: 'Pending HoD approval',
      detail:
        'Assistant HoD has approved your proof. It is now with the Head of Department for final approval. Check this status again in about 10 minutes.',
      topic,
    });
  }

  return res.json({
    ok: true,
    hasOd: true,
    phase: 'pending_ahod',
    headline: 'Pending Assistant HoD approval',
    detail:
      'Your proof has been sent for leadership review. It will appear on the Assistant HoD dashboard first, then the HoD dashboard. Check back in about 10 minutes.',
    topic,
  });
});

// Faculty: OD proof status for a specific student (same data model as /api/student/od-status).
// Used by faculty voice prompts so the spoken message matches what the student sees.
app.get('/api/student/od-status-for-faculty', ensureAuthenticated, (req, res) => {
  const sessionId = String(req.query.sessionId || '').trim();
  const registerNumber = String(req.query.registerNumber || '').trim();
  if (!sessionId) {
    return res.status(400).json({ ok: false, message: 'sessionId is required.' });
  }
  if (!registerNumber) {
    return res.status(400).json({ ok: false, message: 'registerNumber is required.' });
  }

  const key = `${sessionId}:${registerNumber}`;
  const record = attendanceRecords[key];
  const sess = sessions[sessionId];
  const topic = sess && sess.topic ? String(sess.topic) : '';

  if (!record || record.status !== 'OD') {
    return res.json({
      ok: true,
      hasOd: false,
      phase: 'none',
      headline: 'No OD proof submitted for this session.',
      detail:
        'Upload your OD proof using the form when the class session is active. After upload, approval is handled on the AHOD and HoD leadership dashboards.',
    });
  }

  const oa = record.odApproval || { ahod: null, hod: null };
  const ahod = oa.ahod || null;
  const hod = oa.hod || null;

  if (ahod && ahod.decision === 'rejected') {
    return res.json({
      ok: true,
      hasOd: true,
      phase: 'rejected_ahod',
      headline: 'OD proof not approved (Assistant HoD)',
      detail: ahod.reason ? String(ahod.reason) : 'Please contact your department if you need clarification.',
      topic,
    });
  }
  if (hod && hod.decision === 'rejected') {
    return res.json({
      ok: true,
      hasOd: true,
      phase: 'rejected_hod',
      headline: 'OD proof not approved (HoD)',
      detail: hod.reason ? String(hod.reason) : 'Please contact your department if you need clarification.',
      topic,
    });
  }
  if (hod && hod.decision === 'accepted') {
    return res.json({
      ok: true,
      hasOd: true,
      phase: 'approved',
      headline: 'Fully approved — AHOD & HoD',
      detail:
        'Your proof was approved by the Assistant Head of Department and the Head of Department. You should also receive a confirmation email at your registered address when SMTP is configured. Your faculty can now finalize OD in Smart Attendance.',
      topic,
    });
  }
  if (ahod && ahod.decision === 'accepted') {
    return res.json({
      ok: true,
      hasOd: true,
      phase: 'pending_hod',
      headline: 'Pending HoD approval',
      detail:
        'Assistant HoD has approved your proof. It is now with the Head of Department for final approval. Check this status again in about 10 minutes.',
      topic,
    });
  }

  return res.json({
    ok: true,
    hasOd: true,
    phase: 'pending_ahod',
    headline: 'Pending Assistant HoD approval',
    detail:
      'Your proof has been sent for leadership review. It will appear on the Assistant HoD dashboard first, then the HoD dashboard. Check back in about 10 minutes.',
    topic,
  });
});

app.post('/api/forgot-password', async (req, res) => {
  const { email } = req.body;
  const trimmedEmail = String(email || '').trim().toLowerCase();
  if (!trimmedEmail.endsWith('@rajalakshmi.edu.in')) {
    return res.status(400).json({ ok: false, message: 'Use your official @rajalakshmi.edu.in email.' });
  }
  if (users[trimmedEmail]) {
    const u = users[trimmedEmail];
    if (u.hashedPassword && !u.emailVerified) {
      return res.status(403).json({
        ok: false,
        message: 'Please verify your email using the link sent at registration before resetting your password.',
      });
    }
    const defaultPassword = getInitialPasswordForRole('faculty', { staffId: u.staffId, mobile: u.mobileE164 || '' });
    if (!defaultPassword) {
      return res.status(400).json({
        ok: false,
        message: 'Unable to reset password because mobile number is missing. Contact administrator.',
      });
    }
    u.hashedPassword = await bcrypt.hash(defaultPassword, BCRYPT_ROUNDS);
    u.password = undefined;
    let emailSent = false;
    if (smtpConfigured) {
      try {
        const footerHtml = `<div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid #eee; text-align: center; font-size: 12px; color: #555;"><img src="cid:rec-logo" alt="REC Logo" style="max-height: 60px; width: auto; margin-bottom: 10px;" /><br>${COLLEGE_FOOTER_HTML}</div>`;
        const mailOptions = {
          from: process.env.FROM_EMAIL || process.env.SMTP_USER,
          to: trimmedEmail,
          subject: 'REC Classroom Attention — Faculty login password',
          text: `Your faculty login password has been reset.\n\nUse the following as your password to sign in:\n\n${defaultPassword}\n\nPlease log in at the faculty login page using your official email and this password. You can change it from the dashboard after signing in.\n\n${COLLEGE_FOOTER_TEXT}`,
          html: `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 560px;"><p>Your faculty login password has been reset.</p><p>Use the following as your password to sign in:</p><p><strong>${escapeHtml(defaultPassword)}</strong></p><p>Please log in at the faculty login page using your official email and this password. You can change it from the dashboard after signing in.</p>${footerHtml}</body></html>`,
        };
        const logoPath = publicPath('rec-logo.jpg');
        if (fs.existsSync(logoPath)) {
          mailOptions.attachments = [{ filename: 'rec-logo.jpg', content: fs.readFileSync(logoPath), cid: 'rec-logo' }];
        }
        await transporter.sendMail(mailOptions);
        emailSent = true;
        console.log('Forgot-password email sent to faculty:', trimmedEmail);
      } catch (err) {
        console.error('Error sending faculty forgot-password email', err);
      }
    }
    const msg = emailSent
      ? 'Your default password has been emailed to you. Please log in using the password sent to your email.'
      : 'Password reset successfully. Sign in and change it from the dashboard. (Email not sent: SMTP not configured.)';
    return res.json({ ok: true, message: msg });
  }
  return res.json({ ok: true, message: 'If this email is registered, use the password from the encrypted credentials email.' });
});

app.post('/api/student-forgot-password', async (req, res) => {
  const { email } = req.body;
  const trimmedEmail = String(email || '').trim().toLowerCase();
  if (!trimmedEmail.endsWith(STUDENT_EMAIL_SUFFIX)) {
    return res.status(400).json({ ok: false, message: 'Use your official college email (@rajalakshmi.edu.in).' });
  }
  const registered = findStudentRegistrationByLoginEmail(trimmedEmail);
  if (registered) {
    if (registered.hashedPassword && !registered.emailVerified) {
      return res.status(403).json({
        ok: false,
        message: 'Please verify your email using the link sent at registration before resetting your password.',
      });
    }
    if (!smtpConfigured) {
      return res.status(503).json({
        ok: false,
        message: 'Password reset by email requires SMTP to be configured on the server. Contact your administrator.',
      });
    }
    const departmentCode =
      normalizeStudentDepartmentCode(registered.department || '') ||
      normalizeStudentDepartmentCode(registered.registerNumber || '') ||
      'student';
    const regNum = registered.registerNumber ? String(registered.registerNumber).trim() : '';
    const newPassword = getInitialPasswordForRole('student', { departmentCode, registerNumber: regNum || trimmedEmail });
    const emailLinksBase = revealLinksBaseUrl(req);
    const emailSent = await sendLoginEmail(trimmedEmail, trimmedEmail, newPassword, 'student', emailLinksBase, {
      emailContext: 'password_reset',
    });
    if (!emailSent) {
      return res.status(502).json({
        ok: false,
        message: 'Could not send the password reset email. Your password was not changed. Try again later or contact your administrator.',
      });
    }
    registered.hashedPassword = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    delete registered.password;
    saveDatabase();
    return res.json({
      ok: true,
      message:
        'A new encrypted password has been emailed to you. Use the link or paste the credential on the reveal page to sign in, then change your password from the dashboard.',
    });
  }
  return res.json({ ok: false, message: 'This email is not registered. Please register first.' });
});

// Leadership login: Principal / Directors / HoDs / Vice Principals (separate credentials by designation).
app.post('/api/leadership-login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ ok: false, message: 'Email and password are required.' });
  }
  const trimmedEmail = String(email).trim().toLowerCase();
  if (!trimmedEmail.endsWith('@rajalakshmi.edu.in')) {
    return res
      .status(400)
      .json({ ok: false, message: 'Only official @rajalakshmi.edu.in email IDs are allowed.' });
  }

  const user = users[trimmedEmail];
  if (!user) {
    return res.status(403).json({ ok: false, message: 'Account not found. Please contact administrator.' });
  }
  if (user.hashedPassword && !user.emailVerified) {
    return res.status(403).json({
      ok: false,
      message: 'Please verify your email using the link sent at faculty registration before using Leadership login.',
    });
  }

  const designationRaw = String(user.designation || '').trim();
  const designation = designationRaw.toLowerCase();
  const deptCode = String(user.department || '').trim().toLowerCase(); // e.g. "cse"
  const staffId = String(user.staffId || '').trim().toLowerCase();

  const leadershipCreds = getLeadershipCredentials(designationRaw, deptCode, staffId);
  if (!leadershipCreds) {
    return res
      .status(403)
      .json({ ok: false, message: 'This account is not configured for leadership login. Check designation.' });
  }
  const roleLabel = leadershipCreds.roleLabel;
  let valid = false;
  if (user.hashedPassword) {
    valid = await bcrypt.compare(String(password), user.hashedPassword);
  } else {
    valid = user.password === password;
  }
  if (!valid) {
    return res.status(401).json({ ok: false, message: 'Invalid credentials.' });
  }

  return issueLoginOtpChallenge(
    'leadership',
    trimmedEmail,
    {
      userEmail: trimmedEmail,
      leadership: true,
      leadershipRoleLabel: roleLabel,
      leadershipEffectiveDesignation: designation,
      leadershipEffectiveDeptCode: deptCode,
    },
    { roleLabel },
  ).then((otpChallenge) => {
    if (!otpChallenge.ok) {
      return res.status(otpChallenge.status || 500).json({ ok: false, message: otpChallenge.message || 'Unable to start OTP login.' });
    }
    return res.json(otpChallenge);
  });
});

app.post('/api/leadership-login/verify-otp', (req, res) => {
  const { challengeId, otp } = req.body || {};
  const result = verifyLoginOtpChallenge('leadership', challengeId, otp);
  if (!result.ok) return res.status(result.status || 400).json({ ok: false, message: result.message || 'OTP verification failed.' });
  const data = result.entry;
  const leadershipEmail = String(data.sessionData.userEmail || '').trim().toLowerCase();
  const user = users[leadershipEmail];
  if (user && user.hashedPassword && !user.emailVerified) {
    return res.status(403).json({
      ok: false,
      message: 'Please verify your email using the link sent at registration before completing sign-in.',
    });
  }
  req.session.userEmail = leadershipEmail;
  req.session.leadership = true;
  req.session.mfaVerified = true;
  req.session.mfaRole = 'leadership';
  req.session.mfaAt = new Date().toISOString();
  req.session.leadershipRoleLabel = String(data.sessionData.leadershipRoleLabel || 'Leadership');
  req.session.leadershipEffectiveDesignation = String(data.sessionData.leadershipEffectiveDesignation || '').trim().toLowerCase();
  req.session.leadershipEffectiveDeptCode = String(data.sessionData.leadershipEffectiveDeptCode || '').trim().toLowerCase();
  if (user) {
    if (user.sessionVersion == null) user.sessionVersion = 0;
    req.session.accountSessionVersion = Number(user.sessionVersion || 0);
    enableAiAgentAfterSignIn(user, 'leadership');
    appendDeviceLoginSession(user, 'leadership', req);
    saveDatabase();
  }
  return res.json({
    ok: true,
    roleLabel: (data.meta && data.meta.roleLabel) ? String(data.meta.roleLabel) : req.session.leadershipRoleLabel,
  });
});

app.post('/api/leadership-login/resend-otp', async (req, res) => {
  const { challengeId } = req.body || {};
  const out = await resendLoginOtpChallenge('leadership', challengeId);
  if (!out.ok) return res.status(out.status || 400).json({ ok: false, message: out.message || 'Unable to resend OTP.' });
  return res.json({ ok: true, message: out.message || 'OTP resent.' });
});

app.post('/api/portal-login', (req, res) => {
  const { email, password, next } = req.body || {};
  const trimmedEmail = String(email || '').trim().toLowerCase();
  const pwd = String(password || '').trim();
  if (!trimmedEmail || !pwd) {
    return res.status(400).json({ ok: false, message: 'Email and password are required.' });
  }
  if (!trimmedEmail.endsWith('@rajalakshmi.edu.in')) {
    return res.status(403).json({ ok: false, message: 'Use official college email (@rajalakshmi.edu.in).' });
  }
  if (pwd !== PORTAL_LOGIN_PASSWORD) {
    return res.status(401).json({ ok: false, message: 'Invalid portal password.' });
  }
  req.session.portalAuthorized = true;
  req.session.portalEmail = trimmedEmail;
  const nextUrlRaw = String(next || '/portal').trim();
  const nextUrl = nextUrlRaw.startsWith('/portal') ? nextUrlRaw : '/portal';
  return res.json({ ok: true, redirect: nextUrl });
});

// Leadership registration: principal / vice principal / deans / HoD / academic head
app.post('/api/leadership-register', async (req, res) => {
  const { email, name, staffId, department, designation, mobile } = req.body || {};
  const trimmedStaffId = String(staffId || '').trim();
  const facultyEmail = String(email || '').trim().toLowerCase();
  const trimmedName = String(name || '').trim();
  const departmentStr = String(department || '').trim();
  const designationStr = String(designation || '').trim();
  const mobileRaw = String(mobile || '').trim();
  const mobileE164 = mobileRaw ? normalizeMobileForSms(mobileRaw) : null;
  if (!mobileRaw || !mobileE164) {
    return res.status(400).json({
      ok: false,
      message: 'Valid mobile number is required (international format e.g. +919876543210 or 10 digits).',
    });
  }

  if (!facultyEmail || !trimmedName || !trimmedStaffId) {
    return res.status(400).json({ ok: false, message: 'Email, name and Staff ID are required.' });
  }
  if (!facultyEmail.endsWith('@rajalakshmi.edu.in')) {
    return res.status(400).json({ ok: false, message: 'Use your official @rajalakshmi.edu.in email.' });
  }
  if (isRegisteredStudentLoginEmail(facultyEmail) && !isFacultyStudentDualRoleAllowed(facultyEmail)) {
    return res.status(400).json({
      ok: false,
      errorCode: 'STUDENT_LOGIN_EMAIL',
      studentRegisterPath: STUDENT_REGISTER_PATH,
      studentLoginPath: STUDENT_LOGIN_PATH,
      message:
        'This address is already a student login. Use the Student login page, or register leadership with a different staff email.',
    });
  }
  if (users[facultyEmail]) {
    return res.status(400).json({ ok: false, message: 'This email is already registered. Please sign in.' });
  }

  // Validate + compute leadership password pattern by designation.
  const leadershipCreds = getLeadershipCredentials(designationStr, departmentStr, trimmedStaffId);
  if (!leadershipCreds) {
    return res.status(400).json({
      ok: false,
      message: 'Invalid designation/department/staff ID combination for leadership login.',
    });
  }

  const initialPassword = getInitialPasswordForRole('leadership', { staffId: trimmedStaffId, mobile: mobileRaw });
  if (!initialPassword) {
    return res.status(400).json({ ok: false, message: 'Unable to create password from Staff ID and mobile number.' });
  }
  const hashedPassword = await bcrypt.hash(initialPassword, BCRYPT_ROUNDS);

  users[facultyEmail] = {
    password: undefined, // legacy; new accounts use hashedPassword only
    hashedPassword,
    name: trimmedName,
    staffId: trimmedStaffId,
    department: departmentStr,
    designation: designationStr,
    mobileE164: mobileE164 || undefined,
    // Leadership login does not require email verification, so mark verified to keep UX simple.
    emailVerified: true,
    firstLogin: true,
    failedAttempts: 0,
    accountLockedUntil: null,
    lastDevice: null,
    lastIP: null,
    createdAt: new Date().toISOString(),
  };

  const emailLinksBase = revealLinksBaseUrl(req);
  saveDatabase();
  runBackgroundTask('Leadership registration email', async () => {
    await sendLeadershipLoginEmail(
      facultyEmail,
      facultyEmail,
      initialPassword,
      leadershipCreds.roleLabel,
      emailLinksBase,
    );
  });

  return res.json({ ok: true, message: 'Leadership registration successful. Check your email for your dashboard password.' });
});

app.post('/api/register', async (req, res) => {
  const { email, name, staffId, department, designation, mobile } = req.body;
  const trimmedStaffId = String(staffId || '').trim();
  const facultyEmail = String((email || req.body.facultyEmail) || '').trim().toLowerCase();
  const mobileRaw = String(mobile || '').trim();
  const mobileE164 = mobileRaw ? normalizeMobileForSms(mobileRaw) : null;
  if (!mobileRaw || !mobileE164) {
    return res.status(400).json({
      ok: false,
      message: 'Valid mobile number is required (international format e.g. +919876543210 or 10 digits).',
    });
  }
  if (!facultyEmail || !name || !trimmedStaffId) {
    return res.status(400).json({ ok: false, message: 'Email, name and Staff ID are required.' });
  }
  if (!facultyEmail.endsWith('@rajalakshmi.edu.in')) {
    return res.status(400).json({ ok: false, message: 'Use your official @rajalakshmi.edu.in email.' });
  }
  if (isRegisteredStudentLoginEmail(facultyEmail) && !isFacultyStudentDualRoleAllowed(facultyEmail)) {
    return res.status(400).json({
      ok: false,
      errorCode: 'STUDENT_LOGIN_EMAIL',
      studentRegisterPath: STUDENT_REGISTER_PATH,
      studentLoginPath: STUDENT_LOGIN_PATH,
      message:
        'This address is already a student login. Use the Student login page, or register faculty with a different staff email.',
    });
  }
  if (users[facultyEmail]) {
    return res.status(400).json({ ok: false, message: 'This email is already registered. Please sign in.' });
  }

  // Module 1: Strong encryption — password hashed with bcrypt; token stored as SHA-256 hash only
  const initialPassword = getInitialPasswordForRole('faculty', { staffId: trimmedStaffId, mobile: mobileRaw });
  if (!initialPassword) {
    return res.status(400).json({ ok: false, message: 'Unable to create password from Staff ID and mobile number.' });
  }
  const hashedPassword = await bcrypt.hash(initialPassword, BCRYPT_ROUNDS);
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(token);
  const tokenExpiry = Date.now() + VERIFICATION_TOKEN_EXPIRY_MS;
  const verificationDisplayCode = verificationEmailDisplayCode(token);

  users[facultyEmail] = {
    password: undefined, // legacy; new accounts use hashedPassword only
    hashedPassword,
    name: String(name || '').trim(),
    staffId: trimmedStaffId,
    department: String(department || '').trim(),
    designation: String(designation || '').trim(),
    mobileE164: mobileE164 || undefined,
    emailVerified: false,
    verificationTokenHash: tokenHash,
    verificationDisplayCode,
    tokenExpiry,
    firstLogin: true,
    failedAttempts: 0,
    accountLockedUntil: null,
    lastDevice: null,
    lastIP: null,
  };
  verificationTokens[tokenHash] = { type: 'faculty', email: facultyEmail };

  const emailLinksBase = revealLinksBaseUrl(req);
  const designationStr = String(designation || '').trim();
  const departmentStr = String(department || '').trim();
  const verifyUrlForMail = `${emailLinksBase}/verify-email?token=${encodeURIComponent(token)}`;

  // Persist first, then send registration emails in background to reduce response latency.
  saveDatabase();
  // If faculty has a leadership designation, also send Leadership Dashboard login credentials via SMTP.
  const leadershipCreds = getLeadershipCredentials(designationStr, departmentStr, trimmedStaffId);
  runBackgroundTask('Faculty registration emails', async () => {
    await sendVerificationEmail(facultyEmail, facultyEmail, initialPassword, token, 'faculty', emailLinksBase, clientIpFromReq(req));
    await sendLoginEmail(facultyEmail, facultyEmail, initialPassword, 'faculty', emailLinksBase, {
      verifyUrl: verifyUrlForMail,
    });
    if (leadershipCreds) {
      await sendLeadershipLoginEmail(
        facultyEmail,
        facultyEmail,
        initialPassword,
        leadershipCreds.roleLabel,
        emailLinksBase,
      );
    }
  });

  return res.json({ ok: true, message: 'Registration successful. Check your email for login credentials and verification link.' });
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ ok: false, message: 'Email and password are required.' });
  }

  const trimmedEmail = normalizeFacultyEmailForAuth(email);
  if (!isAllowedFacultyEmail(trimmedEmail)) {
    return res
      .status(403)
      .json({ ok: false, message: 'Only official faculty email IDs are allowed.' });
  }
  // Numeric-only staff emails are allowed; only block when this address is an existing student login.
  if (isRegisteredStudentLoginEmail(trimmedEmail) && !users[trimmedEmail] && !isFacultyStudentDualRoleAllowed(trimmedEmail)) {
    return res.status(403).json({ ok: false, message: 'This is a student account. Please use the Student login page.' });
  }

  const existing = users[trimmedEmail];
  if (!existing) {
    return res.status(403).json({ ok: false, message: 'Not registered. Please register first.' });
  }

  // Module 2: Lockout check
  const now = Date.now();
  if (existing.accountLockedUntil && now < existing.accountLockedUntil) {
    return res.status(429).json({ ok: false, message: 'Too many failed login attempts. Try again later.' });
  }
  // Module 1: Require email verification for new secure accounts
  if (existing.hashedPassword && !existing.emailVerified) {
    return res.status(403).json({ ok: false, message: 'Please verify your email using the link sent to you before signing in.' });
  }

  let valid = false;
  if (existing.hashedPassword) {
    valid = await bcrypt.compare(password, existing.hashedPassword);
  } else {
    valid = existing.password === password;
  }
  if (!valid) {
    existing.failedAttempts = (existing.failedAttempts || 0) + 1;
    if (existing.failedAttempts >= MAX_FAILED_ATTEMPTS) {
      existing.accountLockedUntil = now + LOCKOUT_DURATION_MS;
    }
    return res.status(401).json({ ok: false, message: 'Invalid email or password.' });
  }

  // Module 2: New device/IP → security alert
  const device = req.headers['user-agent'] || 'Unknown';
  const ip = req.ip || req.connection?.remoteAddress || 'Unknown';
  if (existing.lastDevice !== undefined && (existing.lastDevice !== device || existing.lastIP !== ip)) {
    await sendSecurityAlertEmail(trimmedEmail, device, ip);
  }
  existing.failedAttempts = 0;
  existing.accountLockedUntil = null;
  existing.lastDevice = device;
  existing.lastIP = ip;

  const otpChallenge = await issueLoginOtpChallenge(
    'faculty',
    trimmedEmail,
    { userEmail: trimmedEmail },
    { requirePasswordChange: !!existing.firstLogin },
  );
  if (!otpChallenge.ok) {
    return res.status(otpChallenge.status || 500).json({ ok: false, message: otpChallenge.message || 'Unable to start OTP login.' });
  }
  return res.json(otpChallenge);
});

app.post('/api/login/google', async (req, res) => {
  const idToken = String((req.body && req.body.idToken) || '').trim();
  if (!GOOGLE_CLIENT_ID) {
    return res.status(503).json({ ok: false, message: 'Google login is not configured on the server.' });
  }
  let identity;
  try {
    identity = await verifyGoogleIdTokenWithGoogle(idToken);
  } catch (err) {
    return res.status(401).json({ ok: false, message: err && err.message ? err.message : 'Invalid Google sign-in token.' });
  }
  const trimmedEmail = normalizeFacultyEmailForAuth(identity.email || '');
  if (!isAllowedFacultyEmail(trimmedEmail)) {
    return res.status(403).json({ ok: false, message: 'Only official faculty email IDs are allowed.' });
  }
  if (isRegisteredStudentLoginEmail(trimmedEmail) && !users[trimmedEmail] && !isFacultyStudentDualRoleAllowed(trimmedEmail)) {
    return res.status(403).json({ ok: false, message: 'This is a student account. Please use the Student login page.' });
  }
  const existing = users[trimmedEmail];
  if (!existing) {
    return res.status(403).json({ ok: false, message: 'Not registered. Please register first.' });
  }
  if (existing.hashedPassword && !existing.emailVerified) {
    return res.status(403).json({ ok: false, message: 'Please verify your email using the link sent to you before signing in.' });
  }
  const now = Date.now();
  if (existing.accountLockedUntil && now < existing.accountLockedUntil) {
    return res.status(429).json({ ok: false, message: 'Too many failed login attempts. Try again later.' });
  }
  const device = req.headers['user-agent'] || 'Unknown';
  const ip = req.ip || req.connection?.remoteAddress || 'Unknown';
  if (existing.lastDevice !== undefined && (existing.lastDevice !== device || existing.lastIP !== ip)) {
    await sendSecurityAlertEmail(trimmedEmail, device, ip);
  }
  existing.failedAttempts = 0;
  existing.accountLockedUntil = null;
  existing.lastDevice = device;
  existing.lastIP = ip;
  const otpChallenge = await issueLoginOtpChallenge(
    'faculty',
    trimmedEmail,
    { userEmail: trimmedEmail },
    { requirePasswordChange: !!existing.firstLogin },
  );
  if (!otpChallenge.ok) {
    return res.status(otpChallenge.status || 500).json({ ok: false, message: otpChallenge.message || 'Unable to start OTP login.' });
  }
  return res.json(otpChallenge);
});

app.post('/api/login/verify-otp', async (req, res) => {
  const { challengeId, otp } = req.body || {};
  const result = await verifyLoginOtpChallenge('faculty', challengeId, otp);
  if (!result.ok) return res.status(result.status || 400).json({ ok: false, message: result.message || 'OTP verification failed.' });
  const data = result.entry;
  const facultyEmail = String(data.sessionData.userEmail || '').trim().toLowerCase();
  const user = users[facultyEmail];
  if (user && user.hashedPassword && !user.emailVerified) {
    return res.status(403).json({
      ok: false,
      message: 'Please verify your email using the link sent to you before completing sign-in.',
    });
  }
  req.session.userEmail = facultyEmail;
  req.session.mfaVerified = true;
  req.session.mfaRole = 'faculty';
  req.session.mfaAt = new Date().toISOString();
  if (user) {
    if (user.sessionVersion == null) user.sessionVersion = 0;
    req.session.accountSessionVersion = Number(user.sessionVersion || 0);
    enableAiAgentAfterSignIn(user, 'faculty');
    appendDeviceLoginSession(user, 'faculty', req);
    saveDatabase();
  }
  return res.json({
    ok: true,
    requirePasswordChange: !!(data.meta && data.meta.requirePasswordChange),
  });
});

app.post('/api/login/resend-otp', async (req, res) => {
  const { challengeId } = req.body || {};
  const out = await resendLoginOtpChallenge('faculty', challengeId);
  if (!out.ok) return res.status(out.status || 400).json({ ok: false, message: out.message || 'Unable to resend OTP.' });
  return res.json({ ok: true, message: out.message || 'OTP resent.' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

app.post('/api/change-password', ensureAuthenticated, async (req, res) => {
  const { currentPassword, newPassword, oldPassword } = req.body;
  const current = String(oldPassword || currentPassword || '').trim();
  const newPwd = String(newPassword || '').trim();
  const email = req.session.userEmail;
  const user = users[email];

  if (!current || !newPwd) {
    return res.status(400).json({ ok: false, message: 'Both current and new passwords are required.' });
  }
  if (!user) {
    return res.status(403).json({ ok: false, message: 'Account not found.' });
  }
  let validCurrent = false;
  if (user.hashedPassword) {
    validCurrent = await bcrypt.compare(current, user.hashedPassword);
  } else {
    validCurrent = user.password === current;
  }
  if (!validCurrent) {
    return res.status(401).json({ ok: false, message: 'Current password is incorrect.' });
  }
  if (newPwd.length < 6 || newPwd.length > 32) {
    return res.status(400).json({ ok: false, message: 'New password must be 6–32 characters.' });
  }

  user.hashedPassword = await bcrypt.hash(newPwd, BCRYPT_ROUNDS);
  user.password = undefined;
  user.firstLogin = false;
  // Persist updated faculty password.
  saveDatabase();
  return res.json({ ok: true, message: 'Password updated successfully.' });
});

// ---- Attention + session APIs ----

let sessionCounter = 1;

app.post('/api/session/start', ensureAuthenticated, (req, res) => {
  const { topic, venue, startTime, endTime, sessionMode } = req.body;
  if (!topic || !venue || !startTime || !endTime) {
    return res
      .status(400)
      .json({ ok: false, message: 'Topic, venue, start time and end time are required.' });
  }

  const id = `S${sessionCounter++}`;
  sessions[id] = {
    id,
    ownerEmail: req.session.userEmail,
    topic,
    venue,
    startTime,
    endTime,
    createdAt: new Date().toISOString(),
    attentionHistory: [], // { t, score }
    studentAttentionHistory: {}, // registerNumber -> [{ t, score, sourceType }]
    alerts: [], // { t, message }
    deviceIds: {}, // deviceId -> lastSeen (ISO) for connected-device count
    closed: false,
    // Zone-level attention (privacy-safe: no identities, no counts, only aggregate per zone)
    zoneHistory: {
      frontBench: [],
      middleBenches: [],
      lastBench: [],
      lastRightCornerBench: [],
      lastLeftCornerBench: [],
    },
    confusionCount: 0, // Anonymous "I'm confused" signals for lecture quality
    // Module 3: AI attention prediction (last 10 samples, every 5s; 4 consecutive negative → alert; 2 min cooldown)
    attentionPredictionHistory: [],
    lastPredictionSampleTime: 0,
    lastPredictionAt: 0,
    // Per-session signing key for attention payload integrity (HMAC); never store plain passwords
    signingKey: security.secureSessionToken(),
    sessionMode: String(sessionMode || 'lecture').trim().toLowerCase(),
    interventions: [], // { id, type, label, startedAt, baselineAttention, durationMs }
    activeIntervention: null,
    classroomActivities: [], // [{id,type,question,options,optionCounts,responsesByRegister,createdAt,sessionId}]
    behaviorAlerts: [],
    behaviorAlertCooldownByKey: {},
    lastAttentionSampleAtByKey: {},
  };

  // Keep global active session in sync with HTTP start (students poll /api/session-status; Socket may be late).
  lastActiveSessionId = id;
  globalSessionActive = true;
  io.emit('active-session', { sessionId: id });
  emitSessionScoped('active-session', id, { sessionId: id });
  // Broadcast session started so student dashboard can disable voice assistant during lecture.
  emitSessionScoped('session-status', id, { status: 'started', sessionId: id });
  persistSessionToMongo(sessions[id]);
  return res.json({ ok: true, sessionId: id });
});

function parseSnapshotDataUrl(dataUrl) {
  const raw = String(dataUrl || '').trim();
  if (!raw.startsWith('data:image/')) return null;
  const m = raw.match(/^data:(image\/(?:jpeg|jpg|png));base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!m) return null;
  const mime = String(m[1] || '').toLowerCase();
  const ext = mime.includes('png') ? 'png' : 'jpg';
  const b64 = String(m[2] || '').replace(/\s+/g, '');
  const buf = Buffer.from(b64, 'base64');
  if (!buf || !buf.length || buf.length > (2 * 1024 * 1024)) return null;
  return { ext, buf };
}

function buildSleepReportRows(sessionObj) {
  const events = Array.isArray(sessionObj && sessionObj.behaviorAlerts) ? sessionObj.behaviorAlerts : [];
  return events
    .filter((e) => e && e.type === 'sleep_detected')
    .map((e, idx) => ({
      sNo: idx + 1,
      registerNumber: String(e.registerNumber || '-'),
      topic: String(e.topic || sessionObj.topic || '-'),
      venue: String(e.venue || sessionObj.venue || '-'),
      at: String(e.at || ''),
      imagePath: e.snapshotPath && fs.existsSync(e.snapshotPath) ? e.snapshotPath : null,
    }));
}

async function buildSleepDetectionPdfBuffer(summary, rows) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 42, size: 'A4' });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const logoPath = publicPath('rec-logo.jpg');
    if (fs.existsSync(logoPath)) {
      try { doc.image(logoPath, doc.page.margins.left, 34, { width: 62 }); } catch (_) {}
    }
    doc.fontSize(13).font('Helvetica-Bold').text('Rajalakshmi Engineering College ( An Autonomous Institution)', 118, 46);
    doc.moveDown(1.8);
    doc.fontSize(15).font('Helvetica-Bold').text('Sleep Detection Report', { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(10).font('Helvetica')
      .text(`Topic: ${summary.topic || '—'}`)
      .text(`Venue: ${summary.venue || '—'}`)
      .text(`Session ID: ${summary.sessionId || '—'}`)
      .text(`Generated at: ${new Date(summary.generatedAt || Date.now()).toLocaleString('en-IN')}`);
    doc.moveDown(0.7);

    doc.fontSize(10).font('Helvetica-Bold').text('S.No | Register Number | Topic | Venue | Time');
    doc.moveDown(0.2);
    if (!rows.length) {
      doc.font('Helvetica').text('No sleep detection records available for this session.');
      doc.moveDown(0.8);
    }
    rows.forEach((row) => {
      const when = row.at ? new Date(row.at).toLocaleString('en-IN') : '—';
      doc.font('Helvetica').fontSize(10).text(
        `${row.sNo}. ${row.registerNumber} | ${row.topic} | ${row.venue} | ${when}`,
      );
      if (row.imagePath && fs.existsSync(row.imagePath)) {
        try {
          doc.moveDown(0.2);
          doc.image(row.imagePath, { fit: [180, 120], align: 'left' });
        } catch (_) {
          doc.fontSize(9).fillColor('#B91C1C').text('Student snapshot could not be rendered.');
          doc.fillColor('#000000');
        }
      } else {
        doc.fontSize(9).fillColor('#6B7280').text('Student image not available.');
        doc.fillColor('#000000');
      }
      doc.moveDown(0.6);
      if (doc.y > 700) doc.addPage();
    });

    const signaturePayload = JSON.stringify({
      sessionId: summary.sessionId || '',
      topic: summary.topic || '',
      venue: summary.venue || '',
      generatedAt: summary.generatedAt || '',
      rows: rows.map((r) => ({ sNo: r.sNo, registerNumber: r.registerNumber, topic: r.topic, venue: r.venue, at: r.at || '' })),
    });
    const reportHash = security.hashData(signaturePayload);
    const reportSignature = security.signData(reportHash);
    doc.moveDown(0.8);
    doc.moveTo(doc.page.margins.left, doc.y).lineTo(560, doc.y).stroke();
    doc.moveDown(0.5);
    doc.font('Helvetica-Bold').fontSize(11).text('Digital Signature');
    doc.font('Helvetica').fontSize(9).text(`Signature Hash: ${reportHash.slice(0, 48)}...`);
    doc.text('Signature Algorithm: RSA-2048 SHA256');
    doc.text(`Signature: ${String(reportSignature || '').slice(0, 72)}...`);
    doc.text('Signed By: AI Classroom Attention System');
    doc.end();
  });
}

app.post('/api/student/behavior-alert', (req, res) => {
  if (!req.session || !req.session.studentEmail || !req.session.studentId) {
    return res.status(401).json({ ok: false, message: 'Please sign in as student.' });
  }
  const sessionId = String((req.body && req.body.sessionId) || '').trim();
  const type = String((req.body && req.body.type) || '').trim().toLowerCase();
  if (!sessionId) return res.status(400).json({ ok: false, message: 'Missing sessionId.' });
  if (!['sleep_detected', 'headset_missing'].includes(type)) {
    return res.status(400).json({ ok: false, message: 'Unsupported behavior alert type.' });
  }
  const s = sessions[sessionId];
  if (!s || s.closed) return res.status(404).json({ ok: false, message: 'Session not found.' });
  const registerNumber = String(req.session.studentId || '').trim();
  const studentRec =
    studentRegistrations[String(req.session.studentEmail || '').trim().toLowerCase()]
    || studentRegistrations[registerNumber + STUDENT_EMAIL_SUFFIX]
    || null;
  const studentName = String((studentRec && studentRec.name) || '').trim();
  const now = Date.now();
  const key = `${registerNumber}:${type}`;
  if (!s.behaviorAlertCooldownByKey || typeof s.behaviorAlertCooldownByKey !== 'object') s.behaviorAlertCooldownByKey = {};
  const lastMs = Number(s.behaviorAlertCooldownByKey[key] || 0);
  if (now - lastMs < 120000) return res.json({ ok: true, skipped: true });
  s.behaviorAlertCooldownByKey[key] = now;
  if (!Array.isArray(s.behaviorAlerts)) s.behaviorAlerts = [];
  const atIso = new Date(now).toISOString();
  const label = type === 'sleep_detected' ? 'Sleep detected' : 'Headset not detected';
  let snapshotPath = null;
  if (type === 'sleep_detected') {
    const parsedSnapshot = parseSnapshotDataUrl(req.body && req.body.snapshotDataUrl);
    if (parsedSnapshot) {
      try {
        const fname = `sleep-${sessionId}-${registerNumber || 'unknown'}-${now}-${crypto.randomBytes(3).toString('hex')}.${parsedSnapshot.ext}`;
        snapshotPath = path.join(SLEEP_ALERT_DIR, fname);
        fs.writeFileSync(snapshotPath, parsedSnapshot.buf);
      } catch (_) {
        snapshotPath = null;
      }
    }
  }
  const event = {
    type,
    label,
    registerNumber,
    studentName,
    at: atIso,
    sessionId,
    topic: String(s.topic || ''),
    venue: String(s.venue || ''),
    ownerEmail: String(s.ownerEmail || ''),
    snapshotPath: snapshotPath || null,
  };
  s.behaviorAlerts.push(event);
  if (s.behaviorAlerts.length > 200) s.behaviorAlerts = s.behaviorAlerts.slice(-200);
  emitSessionScoped('student-behavior-alert', sessionId, event);
  runBackgroundTask('Behavior alert email to faculty', async () => {
    if (type === 'sleep_detected' && smtpConfigured) {
      const reportRows = buildSleepReportRows(s);
      const reportSummary = {
        sessionId,
        topic: event.topic || '',
        venue: event.venue || '',
        generatedAt: new Date().toISOString(),
      };
      let pdfBuffer = null;
      try {
        pdfBuffer = await buildSleepDetectionPdfBuffer(reportSummary, reportRows);
      } catch (err) {
        console.error('Failed to generate sleep detection PDF:', err);
      }
      const pub = normalizeEmailBaseUrl(process.env.PUBLIC_BASE_URL) || normalizeEmailBaseUrl(process.env.SERVER_URL);
      const reportUrl = pub
        ? `${pub}/api/session/${encodeURIComponent(sessionId)}/sleep-detection-report`
        : '';
      const subject = 'sleep detected during class hours';
      const body =
        `Sleep detected during class hours.\n\n`
        + `Register number: ${registerNumber || '-'}\n`
        + `Student name: ${studentName || '-'}\n`
        + `Time: ${new Date(atIso).toLocaleString('en-IN')}\n`
        + `Venue: ${event.venue || '-'}\n`
        + `Topic: ${event.topic || '-'}\n`
        + `Session ID: ${sessionId}\n`
        + (reportUrl ? `Download link: ${reportUrl}\n` : '');
      const mailOptions = {
        from: process.env.FROM_EMAIL || process.env.SMTP_USER,
        to: String(s.ownerEmail || ''),
        subject,
        text: body,
      };
      if (pdfBuffer) {
        mailOptions.attachments = [{
          filename: `sleep-detection-report-${sessionId}.pdf`,
          content: pdfBuffer,
        }];
      }
      await transporter.sendMail(mailOptions);
      return;
    }
    const subject = `REC Student Alert: ${label} (${registerNumber || 'Unknown'})`;
    const body =
      `Student behavior alert during session.\n\n`
      + `Register number: ${registerNumber || '-'}\n`
      + `Student name: ${studentName || '-'}\n`
      + `Alert: ${label}\n`
      + `Time: ${new Date(atIso).toLocaleString('en-IN')}\n`
      + `Venue: ${event.venue || '-'}\n`
      + `Topic: ${event.topic || '-'}\n`
      + `Session ID: ${sessionId}\n`;
    await sendAutomationEmail(String(s.ownerEmail || ''), subject, body);
  });
  return res.json({ ok: true, event });
});

app.post('/api/session/:id/intervention', ensureAuthenticated, (req, res) => {
  const sessionId = req.params.id;
  const s = sessions[sessionId];
  if (!s || s.ownerEmail !== req.session.userEmail) {
    return res.status(404).json({ ok: false, message: 'Session not found.' });
  }
  if (s.closed) {
    return res.status(400).json({ ok: false, message: 'Session is already closed.' });
  }
  const rawType = String((req.body && req.body.type) || '').trim().toLowerCase();
  const actionMap = {
    quick_quiz: 'Quick quiz',
    thumb_vote: 'Thumb vote',
    one_min_recap: '1-minute recap',
  };
  if (!actionMap[rawType]) {
    return res.status(400).json({ ok: false, message: 'Unsupported intervention type.' });
  }
  const now = Date.now();
  const fromMs = now - 60 * 1000;
  const recent = (s.attentionHistory || []).filter((p) => p && p.t && new Date(p.t).getTime() >= fromMs);
  const baselineAttention = recent.length
    ? Number((recent.reduce((acc, p) => acc + Number(p.score || 0), 0) / recent.length).toFixed(2))
    : 0;
  const item = {
    id: `INT-${sessionId}-${now}`,
    type: rawType,
    label: actionMap[rawType],
    startedAt: new Date(now).toISOString(),
    baselineAttention,
    durationMs: 120000,
  };
  s.activeIntervention = item;
  s.interventions = Array.isArray(s.interventions) ? s.interventions : [];
  s.interventions.push(item);
  if (s.interventions.length > 40) s.interventions = s.interventions.slice(-40);
  return res.json({ ok: true, intervention: item });
});

async function notifyStudentsQuizOrPollByEmail(activity, sessionObj) {
  if (!smtpConfigured || !transporter) return;
  const recipients = [];
  for (const k of Object.keys(studentRegistrations)) {
    const rec = studentRegistrations[k];
    const em = String((rec && rec.email) || '').trim().toLowerCase();
    if (!em || !em.endsWith(STUDENT_EMAIL_SUFFIX)) continue;
    if (!recipients.includes(em)) recipients.push(em);
  }
  if (!recipients.length) return;
  const kind = String(activity && activity.type || '').toLowerCase() === 'poll' ? 'Poll' : 'Quiz';
  const opts = Array.isArray(activity && activity.options) ? activity.options : [];
  const footerLogoPath = publicPath('rec-logo.jpg');
  const hasFooterLogo = fs.existsSync(footerLogoPath);
  const optionsText = opts.length ? `\nOptions:\n${opts.map((x, i) => `${i + 1}. ${x}`).join('\n')}` : '';
  const text = `Hello Student,\n\nA new ${kind} was posted in your class session.\n\nTopic: ${sessionObj && sessionObj.topic ? sessionObj.topic : '-'}\nVenue: ${sessionObj && sessionObj.venue ? sessionObj.venue : '-'}\nQuestion: ${activity && activity.question ? activity.question : '-'}${optionsText}\n\nOpen Student dashboard to respond immediately.\n\n${COLLEGE_FOOTER_TEXT}`;
  const html = `<div style="font-family:Arial,sans-serif;line-height:1.55;color:#24135f"><h3 style="margin:0 0 10px;">New ${kind} posted</h3><p style="margin:0 0 8px;"><b>Topic:</b> ${escapeHtml(sessionObj && sessionObj.topic ? sessionObj.topic : '-')}</p><p style="margin:0 0 8px;"><b>Venue:</b> ${escapeHtml(sessionObj && sessionObj.venue ? sessionObj.venue : '-')}</p><p style="margin:0 0 8px;"><b>Question:</b> ${escapeHtml(activity && activity.question ? activity.question : '-')}</p>${opts.length ? `<p style="margin:0 0 6px;"><b>Options:</b></p><ol style="margin:0 0 10px 20px;">${opts.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ol>` : ''}<p style="margin:10px 0;">Open the Student dashboard to respond immediately.</p><div style="margin-top:14px;padding-top:10px;border-top:1px solid #e5e7eb;display:flex;gap:10px;align-items:flex-start;">${hasFooterLogo ? '<img src="cid:rec-footer-logo" alt="REC logo" style="width:46px;height:46px;object-fit:contain;border-radius:6px;" />' : ''}<p style="margin:0;font-size:12px;color:#6b7280;">${escapeHtml(COLLEGE_FOOTER_TEXT).replace(/\n/g, '<br>')}</p></div></div>`;
  const mailOptions = {
    from: process.env.FROM_EMAIL || process.env.SMTP_USER,
    bcc: recipients.join(','),
    subject: `REC Classroom ${kind}: ${activity && activity.question ? String(activity.question).slice(0, 70) : 'New activity'}`,
    text,
    html,
  };
  if (hasFooterLogo) {
    mailOptions.attachments = [{ filename: 'rec-logo.jpg', content: fs.readFileSync(footerLogoPath), cid: 'rec-footer-logo' }];
  }
  await transporter.sendMail(mailOptions);
}

app.post('/api/session/:id/classroom-activity', ensureAuthenticated, (req, res) => {
  const sessionId = String(req.params.id || '').trim();
  const s = sessions[sessionId];
  if (!s || s.ownerEmail !== req.session.userEmail) {
    return res.status(404).json({ ok: false, message: 'Session not found.' });
  }
  if (s.closed) return res.status(400).json({ ok: false, message: 'Session already ended.' });
  const type = String((req.body && req.body.type) || '').trim().toLowerCase();
  if (type !== 'quiz' && type !== 'poll') {
    return res.status(400).json({ ok: false, message: 'Activity type must be quiz or poll.' });
  }
  const question = String((req.body && req.body.question) || '').trim();
  const rawOptions = Array.isArray(req.body && req.body.options) ? req.body.options : [];
  const options = rawOptions.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 6);
  if (!question || question.length < 3 || question.length > 500) {
    return res.status(400).json({ ok: false, message: 'Question must be between 3 and 500 characters.' });
  }
  if (options.length < 2) {
    return res.status(400).json({ ok: false, message: 'Please provide at least 2 options.' });
  }
  const activity = {
    id: `ACT-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
    type,
    question,
    options,
    optionCounts: options.map(() => 0),
    responsesByRegister: {},
    createdAt: new Date().toISOString(),
    sessionId,
  };
  if (!Array.isArray(s.classroomActivities)) s.classroomActivities = [];
  s.classroomActivities.push(activity);
  if (s.classroomActivities.length > 300) s.classroomActivities = s.classroomActivities.slice(-300);
  s.latestClassroomActivity = activity;
  emitSessionScoped('classroom-activity', sessionId, sanitizeClassroomActivityForClient(activity));
  runBackgroundTask('Notify students quiz/poll email', async () => {
    await notifyStudentsQuizOrPollByEmail(activity, s);
  });
  return res.json({ ok: true, activity: sanitizeClassroomActivityForClient(activity), message: `${type === 'quiz' ? 'Quiz' : 'Poll'} flashed to student dashboard.` });
});

app.post('/api/session/:id/classroom-activity/:activityId/respond', (req, res) => {
  if (!req.session || !req.session.studentEmail || !req.session.studentId) {
    return res.status(401).json({ ok: false, message: 'Please sign in as student.' });
  }
  const sessionId = String(req.params.id || '').trim();
  const activityId = String(req.params.activityId || '').trim();
  const s = sessions[sessionId];
  if (!s || s.closed) return res.status(404).json({ ok: false, message: 'Session not found.' });
  const list = Array.isArray(s.classroomActivities) ? s.classroomActivities : [];
  const activity = list.find((x) => String(x && x.id || '') === activityId)
    || (s.latestClassroomActivity && String(s.latestClassroomActivity.id || '') === activityId ? s.latestClassroomActivity : null);
  if (!activity) {
    return res.status(404).json({ ok: false, message: 'Activity not found.' });
  }
  const optionIndex = Number(req.body && req.body.optionIndex);
  if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= (Array.isArray(activity.options) ? activity.options.length : 0)) {
    return res.status(400).json({ ok: false, message: 'Invalid option index.' });
  }
  if (!Array.isArray(activity.optionCounts)) activity.optionCounts = (activity.options || []).map(() => 0);
  if (!activity.responsesByRegister || typeof activity.responsesByRegister !== 'object') activity.responsesByRegister = {};
  const reg = String(req.session.studentId || '').trim();
  const prev = activity.responsesByRegister[reg];
  if (Number.isInteger(prev) && prev >= 0 && prev < activity.optionCounts.length && activity.optionCounts[prev] > 0) {
    activity.optionCounts[prev] -= 1;
  }
  activity.responsesByRegister[reg] = optionIndex;
  activity.optionCounts[optionIndex] = Number(activity.optionCounts[optionIndex] || 0) + 1;
  saveDatabase();
  return res.json({
    ok: true,
    selectedOptionIndex: optionIndex,
    optionCounts: activity.optionCounts,
  });
});

// ---- Module 3: AI attention prediction (lightweight trend detection) ----
function runAttentionPrediction(sessionId, s, numericScore) {
  if (!s) return;
  const now = Date.now();
  if (!s.attentionPredictionHistory) s.attentionPredictionHistory = [];
  if (s.lastPredictionSampleTime == null) s.lastPredictionSampleTime = 0;
  if (s.lastPredictionAt == null) s.lastPredictionAt = 0;

  // Sample every PREDICTION_SAMPLE_INTERVAL_MS (5s); keep last 10
  if (now - s.lastPredictionSampleTime >= PREDICTION_SAMPLE_INTERVAL_MS) {
    s.attentionPredictionHistory.push(numericScore);
    if (s.attentionPredictionHistory.length > PREDICTION_HISTORY_SIZE) {
      s.attentionPredictionHistory.shift();
    }
    s.lastPredictionSampleTime = now;
  }

  const hist = s.attentionPredictionHistory;
  if (hist.length < PREDICTION_CONSECUTIVE_NEGATIVE + 1) return;

  // Consecutive negative trends: trend[i] = current - previous
  const trends = [];
  for (let i = 1; i < hist.length; i++) {
    trends.push(hist[i] - hist[i - 1]);
  }
  const lastN = trends.slice(-PREDICTION_CONSECUTIVE_NEGATIVE);
  const allNegative = lastN.length === PREDICTION_CONSECUTIVE_NEGATIVE && lastN.every((t) => t < 0);
  if (!allNegative) return;
  if (now - s.lastPredictionAt < PREDICTION_COOLDOWN_MS) return;

  s.lastPredictionAt = now;
  const payload = { message: 'Attention likely to drop soon', sessionId };
  emitSessionScoped('attention-prediction', sessionId, payload);
}

// Receive attention score from AI pipeline (e.g. student frontend). Optional deviceId for multi-device count.
app.post('/api/attention', ensureAuthenticated, (req, res) => {
  const { sessionId, score, timestamp, deviceId } = req.body;
  const s = sessions[sessionId];
  if (!s || s.ownerEmail !== req.session.userEmail) {
    return res.status(404).json({ ok: false, message: 'Session not found.' });
  }
  if (s.closed) {
    return res.status(400).json({ ok: false, message: 'Session is already closed.' });
  }

  const numericScore = Number(score);
  if (Number.isNaN(numericScore)) {
    return res.status(400).json({ ok: false, message: 'Invalid score.' });
  }

  const t = timestamp || new Date().toISOString();
  s.attentionHistory.push({ t, score: numericScore });
  persistAttentionEventToMongo(s, {
    timestamp: t,
    score: numericScore,
    source: 'faculty_dashboard',
    deviceHash: deviceId ? security.hashData(String(deviceId)) : null,
  });
  if (deviceId) {
    s.deviceIds[security.hashData(String(deviceId))] = new Date().toISOString();
  }

  runAttentionPrediction(sessionId, s, numericScore);

  // Simple adaptive baseline: moving average of last N points
  const N = 30;
  const recent = s.attentionHistory.slice(-N);
  const avg =
    recent.reduce((acc, v) => acc + v.score, 0) / (recent.length || 1);

  // Detect significant drop relative to adaptive baseline (no fixed absolute threshold)
  let alertMessage = null;
  if (recent.length > 10 && numericScore < avg * 0.65) {
    alertMessage = `Dear Faculty, students have dropped their attention at ${t}.`;
    s.alerts.push({ t, message: alertMessage });
  }

  return res.json({
    ok: true,
    baseline: avg,
    alert: alertMessage,
  });
});

// Zone IDs and labels for privacy-safe zone-level messages (no bench numbers, no counts).
// Classroom layout: 4–8 rows, 9–12 benches per column (student client maps position to these zones).
// Maps to Digital Twin layout: Front Bench | Middle Bench | Back Bench, Back Left, Back Right
const ZONE_IDS = ['frontBench', 'middleBenches', 'lastBench', 'lastRightCornerBench', 'lastLeftCornerBench'];
const ZONE_LABELS = {
  frontBench: 'Front Bench',
  middleBenches: 'Middle Bench',
  lastBench: 'Back Bench',
  lastRightCornerBench: 'Back Right Corner',
  lastLeftCornerBench: 'Back Left Corner',
};
// Display labels for Digital Twin (short form)
const ZONE_DISPLAY_LABELS = {
  frontBench: 'Front Row',
  middleBenches: 'Middle Row',
  lastBench: 'Back Center',
  lastRightCornerBench: 'Back Right',
  lastLeftCornerBench: 'Back Left',
};

// Public attention endpoint for students (no login required). Session must exist and be open.
// Supports signed payloads: signature (HMAC) and optional hash for integrity. Verify before processing.
// Optional: zoneScores = { frontBench: 72, middleBenches: 65, ... } for zone-level aggregation.
// Optional: encryptedData (hex) + hash — server verifies hash then decrypts to get payload using per-session AES key.
app.post('/api/attention/public', (req, res) => {
  let body = req.body;
  const { encryptedData, signature, hash: payloadHash } = body;
  let s = null;
  let sessionId = body.sessionId;

  // If payload was sent encrypted, verify integrity hash then decrypt using session-specific key
  if (encryptedData && typeof encryptedData === 'string') {
    if (!sessionId) {
      return res.status(400).json({ ok: false, message: 'SessionId is required for encrypted payload.' });
    }
    s = sessions[sessionId];
  if (!s) {
    return res.status(404).json({ ok: false, message: 'Session not found.' });
  }
  if (s.closed) {
    return res.status(400).json({ ok: false, message: 'Session is already closed.' });
  }
    if (payloadHash && security.integrityHash(encryptedData) !== payloadHash) {
      return res.status(400).json({ ok: false, message: 'Integrity check failed.' });
    }
    try {
      const decrypted = security.decryptForSession(encryptedData, s.signingKey);
      body = JSON.parse(decrypted);
      // Ensure sessionId in body matches the outer one
      if (body.sessionId && body.sessionId !== sessionId) {
        return res.status(400).json({ ok: false, message: 'Session mismatch in encrypted payload.' });
      }
    } catch (e) {
      return res.status(400).json({ ok: false, message: 'Invalid encrypted payload.' });
    }
  }

  // For non-encrypted payloads, resolve session now
  const { score, timestamp, deviceId, gaze, headYaw, headPitch, eyesOpen, ear, zoneScores, studentRegisterNumber, sourceType } = body;
  sessionId = body.sessionId;
  if (!sessionId) {
    return res.status(400).json({ ok: false, message: 'SessionId is required.' });
  }
  if (!s) {
    s = sessions[sessionId];
  }
  if (!s) {
    return res.status(404).json({ ok: false, message: 'Session not found.' });
  }
  if (s.closed) {
    return res.status(400).json({ ok: false, message: 'Session is already closed.' });
  }

  // Build canonical payload (exclude signature/hash) for verification
  const canonical = { ...body };
  delete canonical.signature;
  delete canonical.hash;
  delete canonical.encryptedData;
  if (payloadHash && !encryptedData) {
    const expectedHash = security.hashData(security.canonicalPayloadString(canonical));
    if (expectedHash !== payloadHash) {
      return res.status(400).json({ ok: false, message: 'Integrity check failed.' });
    }
  }
  if (signature && s.signingKey) {
    if (!security.verifyAttentionSignature(canonical, signature, s.signingKey)) {
      return res.status(401).json({ ok: false, message: 'Signature verification failed.' });
    }
  }

  const numericScore = Number(score);
  if (Number.isNaN(numericScore)) {
    return res.status(400).json({ ok: false, message: 'Invalid score.' });
  }
  const regKey = String(studentRegisterNumber || '').trim();
  const t = timestamp || new Date().toISOString();
  const nowMs = Date.now();
  const sampleKey = regKey
    ? `reg:${regKey}`
    : deviceId
      ? `device:${security.hashData(String(deviceId))}`
      : 'anon';
  if (!s.lastAttentionSampleAtByKey || typeof s.lastAttentionSampleAtByKey !== 'object') {
    s.lastAttentionSampleAtByKey = {};
  }
  const lastSampleAt = Number(s.lastAttentionSampleAtByKey[sampleKey] || 0);
  if (lastSampleAt && (nowMs - lastSampleAt) < ATTENTION_MIN_PUSH_INTERVAL_MS) {
    return res.json({ ok: true, throttled: true, minIntervalMs: ATTENTION_MIN_PUSH_INTERVAL_MS });
  }
  s.lastAttentionSampleAtByKey[sampleKey] = nowMs;
  const entry = { t, score: numericScore };
  if (regKey) entry.studentRegisterNumber = regKey;
  if (sourceType) entry.sourceType = String(sourceType).trim();
  if (gaze != null) entry.gaze = gaze;
  if (headYaw != null) entry.headYaw = headYaw;
  if (headPitch != null) entry.headPitch = headPitch;
  if (eyesOpen != null) entry.eyesOpen = eyesOpen;
  if (ear != null) entry.ear = ear;
  s.attentionHistory.push(entry);
  persistAttentionEventToMongo(s, {
    timestamp: t,
    score: numericScore,
    source: 'student_public',
    studentRegisterNumber: regKey || null,
    sourceType: sourceType ? String(sourceType).trim() : 'live_camera',
    deviceHash: deviceId ? security.hashData(String(deviceId)) : null,
  });
  if (regKey) {
    if (!s.studentAttentionHistory || typeof s.studentAttentionHistory !== 'object') {
      s.studentAttentionHistory = {};
    }
    if (!Array.isArray(s.studentAttentionHistory[regKey])) {
      s.studentAttentionHistory[regKey] = [];
    }
    s.studentAttentionHistory[regKey].push({
      t,
      score: numericScore,
      sourceType: sourceType ? String(sourceType).trim() : 'live_camera',
    });
    if (s.studentAttentionHistory[regKey].length > 600) {
      s.studentAttentionHistory[regKey] = s.studentAttentionHistory[regKey].slice(-600);
    }
  }
  if (deviceId) {
    // Hash device identifier before storing (security: do not store plain identifiers)
    s.deviceIds[security.hashData(String(deviceId))] = new Date().toISOString();
  }

  runAttentionPrediction(sessionId, s, numericScore);

  // Zone-level aggregation: store per-zone scores (no identities, no counts)
  if (!s.zoneHistory) {
    s.zoneHistory = { frontBench: [], middleBenches: [], lastBench: [], lastRightCornerBench: [], lastLeftCornerBench: [] };
  }
  if (zoneScores && typeof zoneScores === 'object') {
    for (const zoneId of ZONE_IDS) {
      const zoneScore = Number(zoneScores[zoneId]);
      if (!Number.isNaN(zoneScore) && zoneScore >= 0 && zoneScore <= 100) {
        if (!s.zoneHistory[zoneId]) s.zoneHistory[zoneId] = [];
        s.zoneHistory[zoneId].push({ t, score: zoneScore });
        if (s.zoneHistory[zoneId].length > 300) s.zoneHistory[zoneId].shift();
      }
    }
  }
  const N = 30;
  const recent = s.attentionHistory.slice(-N);
  const avg = recent.reduce((acc, v) => acc + v.score, 0) / (recent.length || 1);
  let alertMessage = null;
  if (recent.length > 10 && numericScore < avg * 0.65) {
    alertMessage = `Dear Faculty, students have dropped their attention at ${t}.`;
    s.alerts.push({ t, message: alertMessage });
  }
  // Return session signing key once so client can sign subsequent attention payloads
  const response = { ok: true, baseline: avg, alert: alertMessage };
  if (s.signingKey) response.signingKey = s.signingKey;
  return res.json(response);
});

// ---- Feature 3: AI teaching suggestions (sustained attention < 0.45 for > 20 seconds) ----
const AI_TEACHING_SUGGESTIONS = [
  'Consider a short recap or interactive question',
  'Students may need a worked example',
  'Try pacing or switching explanation style',
  'Pause for a quick poll or hands-up check',
  'Introduce a brief think-pair-share moment',
  'Ask a quick question to re-engage',
  'Pause and recap the key point',
  'Switch to a visual or demo if possible',
];

function detectSustainedAttentionDrop(history) {
  if (!history || history.length < 2) return { detected: false, suggestions: [] };
  const LOW_THRESHOLD = 45; // 0.45 as percentage
  const MIN_DURATION_MS = 20 * 1000; // sustained drop: > 20 seconds
  const now = Date.now();
  const windowStart = now - 60 * 1000; // look at last 60 seconds
  const recent = history
    .filter((p) => new Date(p.t).getTime() >= windowStart)
    .sort((a, b) => new Date(a.t) - new Date(b.t));
  if (recent.length < 2) return { detected: false, suggestions: [] };
  // Find longest run of consecutive low points spanning > 20 seconds
  let runStartIdx = null;
  let runStartTime = null;
  for (let i = 0; i < recent.length; i++) {
    const score = Number(recent[i].score);
    const t = new Date(recent[i].t).getTime();
    if (score < LOW_THRESHOLD) {
      if (runStartIdx === null) {
        runStartIdx = i;
        runStartTime = t;
      }
      const duration = t - runStartTime;
      if (duration >= MIN_DURATION_MS) {
        const shuffled = [...AI_TEACHING_SUGGESTIONS].sort(() => Math.random() - 0.5);
        return { detected: true, suggestions: shuffled.slice(0, 3) };
      }
    } else {
      runStartIdx = null;
      runStartTime = null;
    }
  }
  return { detected: false, suggestions: [] };
}

function classifyStudentAttentionMode(row) {
  const score = Number(row && row.currentScore != null ? row.currentScore : row && row.averageAttention != null ? row.averageAttention : 0);
  if (score >= 75) return 'focused';
  if (score <= 35) return 'distracted';
  return 'recovering';
}

function classifyThresholdSignal(scoreValue) {
  const score = Number(Number(scoreValue || 0).toFixed(2));
  if (score > 50) {
    return {
      thresholdValue: score,
      thresholdLabel: 'RAISING',
      thresholdMessage: 'Attention values are raising',
    };
  }
  if (score < 45) {
    return {
      thresholdValue: score,
      thresholdLabel: 'FALLING',
      thresholdMessage: 'Attention values are falling down',
    };
  }
  return {
    thresholdValue: score,
    thresholdLabel: 'STABLE',
    thresholdMessage: 'Attention values are steady',
  };
}

function buildStudentThresholdRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return list.map((row, idx) => ({
    sNo: idx + 1,
    registerNumber: String(row.registerNumber || '').trim(),
    thresholdValue: Number(Number(row.currentScore || 0).toFixed(2)),
    thresholdLabel: String(row.thresholdLabel || 'STABLE'),
    thresholdMessage: String(row.thresholdMessage || 'Attention values are steady'),
  }));
}

function buildStudentThresholdCsv(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const header = ['S.No', 'Register Number', 'Threshold Value (%)', 'Threshold Status', 'Message'];
  const csvRows = list.map((row) => ([
    row.sNo,
    row.registerNumber,
    Number(row.thresholdValue || 0).toFixed(2),
    row.thresholdLabel || 'STABLE',
    row.thresholdMessage || 'Attention values are steady',
  ]));
  return [header, ...csvRows]
    .map((cols) => cols.map((val) => `"${String(val == null ? '' : val).replace(/"/g, '""')}"`).join(','))
    .join('\n');
}

function computeStudentScoreRowsLast60(sessionObj, nowMs) {
  if (!sessionObj || !sessionObj.studentAttentionHistory || typeof sessionObj.studentAttentionHistory !== 'object') return [];
  const now = Number(nowMs) || Date.now();
  const fromMs = now - 60 * 1000;
  const rows = [];
  Object.entries(sessionObj.studentAttentionHistory).forEach(([registerNumber, series]) => {
    if (!Array.isArray(series) || !series.length) return;
    const recent = series.filter((p) => p && p.t && new Date(p.t).getTime() >= fromMs);
    if (!recent.length) return;
    const avg = recent.reduce((acc, p) => acc + Number(p.score || 0), 0) / recent.length;
    const last = recent[recent.length - 1] || {};
    const row = {
      registerNumber: String(registerNumber || '').trim(),
      currentScore: Number(Number(last.score || 0).toFixed(2)),
      averageAttention: Number(avg.toFixed(2)),
      sampleCount: recent.length,
      sourceType: last.sourceType ? String(last.sourceType) : 'live_camera',
      lastUpdatedAt: last.t || null,
    };
    row.mode = classifyStudentAttentionMode(row);
    const thresholdMeta = classifyThresholdSignal(row.currentScore);
    row.thresholdValue = thresholdMeta.thresholdValue;
    row.thresholdLabel = thresholdMeta.thresholdLabel;
    row.thresholdMessage = thresholdMeta.thresholdMessage;
    rows.push(row);
  });
  rows.sort((a, b) => b.currentScore - a.currentScore);
  return rows;
}

// Live attention data for the dashboard (polled every 2s). Returns last 60s for trend graph + average + device count.
app.get('/api/live-attention', ensureAuthenticated, (req, res) => {
  const { sessionId } = req.query;
  const s = sessions[sessionId];
  if (!s || s.ownerEmail !== req.session.userEmail) {
    return res.status(404).json({ ok: false, message: 'Session not found.' });
  }

  const now = Date.now();
  const sixtySecAgo = now - 60 * 1000;
  const historyLast60s = s.attentionHistory.filter((p) => new Date(p.t).getTime() >= sixtySecAgo);
  const studentScoreRows = computeStudentScoreRowsLast60(s, now);
  const studentHistoryLast60s = {};
  const regList = [];
  const sourceTypeByReg = {};
  if (s.studentAttentionHistory && typeof s.studentAttentionHistory === 'object') {
    Object.keys(s.studentAttentionHistory).forEach((reg) => {
      const series = Array.isArray(s.studentAttentionHistory[reg]) ? s.studentAttentionHistory[reg] : [];
      const recent = series.filter((p) => p && new Date(p.t).getTime() >= sixtySecAgo);
      if (!recent.length) return;
      studentHistoryLast60s[reg] = recent.map((p) => ({ t: p.t, score: Number(p.score) }));
      regList.push(reg);
      const lastSource = recent[recent.length - 1] && recent[recent.length - 1].sourceType
        ? String(recent[recent.length - 1].sourceType)
        : 'live_camera';
      sourceTypeByReg[reg] = lastSource;
    });
  }
  const sum = historyLast60s.reduce((acc, p) => acc + p.score, 0);
  const averageAttention = historyLast60s.length ? sum / historyLast60s.length : 0;
  const deviceCount = pruneDeviceIds(s);

  // Feature 3: detect sustained low attention and generate AI teaching suggestions
  const dropResult = detectSustainedAttentionDrop(s.attentionHistory);
  let aiSuggestions = [];
  if (dropResult.detected && dropResult.suggestions.length > 0) {
    s.aiSuggestions = dropResult.suggestions; // store for session-end PDF
    aiSuggestions = dropResult.suggestions;
  }

  // Zone-level aggregation, trend detection (20s declining), and insight message
  const zoneHistory = s.zoneHistory || {};
  const zones = {};
  const zoneTrends = {}; // 'stable' | 'declining'
  const lowZones = [];
  const MIN_DURATION_DECLINING_MS = 20 * 1000; // 20 seconds
  for (const zoneId of ZONE_IDS) {
    const hist = zoneHistory[zoneId] || [];
    const recent = hist.filter((p) => new Date(p.t).getTime() >= sixtySecAgo);
    const avg = recent.length ? recent.reduce((acc, p) => acc + p.score, 0) / recent.length : null;
    zones[zoneId] = avg != null ? Number(avg.toFixed(2)) : null;
    if (avg != null && avg < 45) lowZones.push(zoneId);
    // Trend: declining if attention drops continuously for 20 seconds
    let trend = 'stable';
    if (recent.length >= 2) {
      const twentySecAgo = now - MIN_DURATION_DECLINING_MS;
      const inLast20 = recent.filter((p) => new Date(p.t).getTime() >= twentySecAgo);
      if (inLast20.length >= 2) {
        const sorted = [...inLast20].sort((a, b) => new Date(a.t) - new Date(b.t));
        const first = Number(sorted[0].score);
        const last = Number(sorted[sorted.length - 1].score);
        if (last < first && (first - last) >= 10) trend = 'declining';
      }
    }
    zoneTrends[zoneId] = trend;
  }
  // If we have class-level attention but no per-zone samples yet, mirror the average into every zone
  // so the Digital Twin heatmap still shows green/yellow/red (zoneScores from clients are optional).
  const hasAnyZone = ZONE_IDS.some((z) => zones[z] != null);
  if (!hasAnyZone && historyLast60s.length > 0) {
    const fill = Number(averageAttention.toFixed(2));
    for (const zoneId of ZONE_IDS) {
      zones[zoneId] = fill;
    }
    if (fill < 45) {
      lowZones.length = 0;
      for (const zoneId of ZONE_IDS) lowZones.push(zoneId);
    }
  }
  const zoneMessage = lowZones.length > 0
    ? 'Attention drop detected in the following classroom zones: ' +
      lowZones.map((z) => ZONE_LABELS[z]).join(', ') + '.'
    : null;

  // AI Lecture Quality Score inputs (aggregate only; no student identities)
  const scores = historyLast60s.map((p) => p.score);
  const mean = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
  const variance = scores.length
    ? scores.reduce((acc, x) => acc + (x - mean) * (x - mean), 0) / scores.length
    : 0;
  const stddev = Math.sqrt(variance);
  const attention_stability = scores.length >= 2 ? Math.max(0, Math.min(1, 1 - stddev / 50)) : 0.7;
  const participation_rate = Math.min(1, deviceCount / 15);
  const confusionCount = s.confusionCount || 0;
  const confusion_rate = Math.min(1, confusionCount / Math.max(1, deviceCount * 2));

  const lastPoint = s.attentionHistory[s.attentionHistory.length - 1] || null;
  let activeIntervention = null;
  if (s.activeIntervention && s.activeIntervention.startedAt) {
    const startedMs = new Date(s.activeIntervention.startedAt).getTime();
    const elapsedMs = Math.max(0, now - startedMs);
    if (elapsedMs <= Number(s.activeIntervention.durationMs || 120000)) {
      const delta = Number((averageAttention - Number(s.activeIntervention.baselineAttention || 0)).toFixed(2));
      activeIntervention = {
        ...s.activeIntervention,
        elapsedMs,
        attentionDelta: delta,
      };
    } else {
      s.activeIntervention = null;
    }
  }
  return res.json({
    ok: true,
    lastPoint,
    alerts: s.alerts.slice(-10),
    historyLast60s,
    studentHistoryLast60s,
    studentRegisterNumbers: regList.sort((a, b) => String(a).localeCompare(String(b))),
    sourceTypeByReg,
    studentScoreRows,
    sessionMode: s.sessionMode || 'lecture',
    activeIntervention,
    recentInterventions: Array.isArray(s.interventions) ? s.interventions.slice(-5).reverse() : [],
    averageAttention: Number(averageAttention.toFixed(2)),
    deviceCount,
    aiSuggestions,
    zones,
    zoneTrends,
    zoneMessage,
    ZONE_LABELS,
    ZONE_DISPLAY_LABELS,
    attention_avg: scores.length ? mean / 100 : 0,
    attention_stability: Number(attention_stability.toFixed(2)),
    participation_rate: Number(participation_rate.toFixed(2)),
    confusion_rate: Number(confusion_rate.toFixed(2)),
  });
});

app.get('/api/session/:id/student-scores-export', ensureAuthenticated, async (req, res) => {
  const sessionId = req.params.id;
  const s = sessions[sessionId];
  if (!s || s.ownerEmail !== req.session.userEmail) {
    return res.status(404).json({ ok: false, message: 'Session not found.' });
  }
  const format = String(req.query.format || 'csv').trim().toLowerCase();
  const rows = computeStudentScoreRowsLast60(s, Date.now());
  if (format === 'excel' || format === 'xlsx') {
    try {
      const generatedAt = new Date().toISOString();
      const signaturePayload = JSON.stringify({
        sessionId,
        topic: s.topic || '',
        venue: s.venue || '',
        generatedAt,
        rows: rows.map((r) => ({
          registerNumber: r.registerNumber,
          currentScore: r.currentScore,
          averageAttention: r.averageAttention,
          mode: r.mode,
          sourceType: r.sourceType,
          sampleCount: r.sampleCount,
          lastUpdatedAt: r.lastUpdatedAt || '',
        })),
      });
      const signatureHash = crypto.createHash('sha256').update(signaturePayload).digest('hex');

      const workbook = new ExcelJS.Workbook();
      workbook.creator = 'REC Classroom Attention System';
      const ws = workbook.addWorksheet('Student Scores');
      ws.columns = [
        { width: 18 },
        { width: 18 },
        { width: 24 },
        { width: 14 },
        { width: 16 },
        { width: 10 },
        { width: 24 },
      ];

      const logoPath = publicPath('rec-logo.jpg');
      let recLogoImageId = null;
      if (fs.existsSync(logoPath)) {
        recLogoImageId = workbook.addImage({ filename: logoPath, extension: 'jpeg' });
        ws.addImage(recLogoImageId, { tl: { col: 0, row: 0 }, ext: { width: 72, height: 72 } });
      }

      ws.mergeCells('B1:G1');
      ws.getCell('B1').value = 'Rajalakshmi Engineering College ( An Autonomous Institution)';
      ws.getCell('B1').font = { name: 'Calibri', size: 14, bold: true, color: { argb: 'FF24135F' } };
      ws.getCell('B1').protection = { locked: true };
      ws.mergeCells('B2:G2');
      ws.getCell('B2').value = 'Individual Student Attention Scores (Last 60s)';
      ws.getCell('B2').font = { name: 'Calibri', size: 12, bold: true };
      ws.getCell('B2').protection = { locked: true };
      ws.mergeCells('B3:G3');
      ws.getCell('B3').value = `Topic: ${s.topic || '—'} | Venue: ${s.venue || '—'}`;
      ws.getCell('B3').font = { name: 'Calibri', size: 10 };
      ws.getCell('B3').protection = { locked: true };

      const headerRowIdx = 5;
      const headers = ['Register Number', 'Score Value (Live)', 'Average Score (Last 60s)', 'Mode', 'Source', 'Samples', 'Last Updated'];
      headers.forEach((h, i) => {
        const cell = ws.getCell(headerRowIdx, i + 1);
        cell.value = h;
        cell.font = { bold: true, color: { argb: 'FF24135F' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF2FF' } };
        cell.protection = { locked: true };
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFD1D5DB' } },
          left: { style: 'thin', color: { argb: 'FFD1D5DB' } },
          bottom: { style: 'thin', color: { argb: 'FFD1D5DB' } },
          right: { style: 'thin', color: { argb: 'FFD1D5DB' } },
        };
      });

      if (rows.length) {
        rows.forEach((r, idx) => {
          const rowIndex = headerRowIdx + 1 + idx;
          const vals = [
            r.registerNumber || '—',
            r.currentScore != null ? `${r.currentScore}%` : '—',
            r.averageAttention != null ? `${r.averageAttention}%` : '—',
            r.mode || '—',
            r.sourceType || '—',
            r.sampleCount != null ? r.sampleCount : '—',
            r.lastUpdatedAt || '—',
          ];
          vals.forEach((v, cIdx) => {
            const cell = ws.getCell(rowIndex, cIdx + 1);
            cell.value = v;
            cell.protection = { locked: false };
            cell.border = {
              top: { style: 'thin', color: { argb: 'FFE5E7EB' } },
              left: { style: 'thin', color: { argb: 'FFE5E7EB' } },
              bottom: { style: 'thin', color: { argb: 'FFE5E7EB' } },
              right: { style: 'thin', color: { argb: 'FFE5E7EB' } },
            };
          });
        });
      } else {
        ws.mergeCells(`A${headerRowIdx + 1}:G${headerRowIdx + 1}`);
        ws.getCell(`A${headerRowIdx + 1}`).value = 'No student scores available for the last 60 seconds.';
      }

      const sigRow = headerRowIdx + Math.max(rows.length, 1) + 3;
      ws.mergeCells(`A${sigRow}:G${sigRow}`);
      ws.getCell(`A${sigRow}`).value = `Digital Signature: ${signatureHash}`;
      ws.getCell(`A${sigRow}`).font = { bold: true, size: 10 };
      ws.getCell(`A${sigRow}`).protection = { locked: true };
      ws.mergeCells(`A${sigRow + 1}:G${sigRow + 1}`);
      ws.getCell(`A${sigRow + 1}`).value = `Generated At: ${new Date(generatedAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'medium' })}`;
      ws.getCell(`A${sigRow + 1}`).font = { size: 10 };
      ws.getCell(`A${sigRow + 1}`).protection = { locked: true };

      // Summary analytics sheet for quick faculty insights.
      const summary = workbook.addWorksheet('Summary Analytics');
      summary.columns = [{ width: 34 }, { width: 26 }];
      if (recLogoImageId) {
        summary.addImage(recLogoImageId, { tl: { col: 0, row: 0 }, ext: { width: 72, height: 72 } });
      }
      summary.getCell('A1').value = 'Rajalakshmi Engineering College ( An Autonomous Institution)';
      summary.getCell('A1').font = { name: 'Calibri', size: 13, bold: true, color: { argb: 'FF24135F' } };
      summary.mergeCells('A1:B1');
      summary.getCell('A2').value = 'Individual Student Score Analytics (Last 60s)';
      summary.getCell('A2').font = { bold: true };
      summary.mergeCells('A2:B2');
      const topScore = rows.length ? Math.max(...rows.map((r) => Number(r.currentScore || 0))) : 0;
      const avgLive = rows.length ? rows.reduce((a, r) => a + Number(r.currentScore || 0), 0) / rows.length : 0;
      const avg60 = rows.length ? rows.reduce((a, r) => a + Number(r.averageAttention || 0), 0) / rows.length : 0;
      const focusedCount = rows.filter((r) => String(r.mode || '').toLowerCase() === 'focused').length;
      const distractedCount = rows.filter((r) => String(r.mode || '').toLowerCase() === 'distracted').length;
      const recoveringCount = rows.filter((r) => String(r.mode || '').toLowerCase() === 'recovering').length;
      const metrics = [
        ['Topic', s.topic || '—'],
        ['Venue', s.venue || '—'],
        ['Total students in current window', rows.length],
        ['Average live score', `${avgLive.toFixed(2)}%`],
        ['Average score (last 60s)', `${avg60.toFixed(2)}%`],
        ['Top live score', `${topScore.toFixed(2)}%`],
        ['Focused students', focusedCount],
        ['Distracted students', distractedCount],
        ['Recovering students', recoveringCount],
        ['Digital Signature', signatureHash],
        ['Generated At', new Date(generatedAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'medium' })],
      ];
      metrics.forEach((m, idx) => {
        const r = 4 + idx;
        summary.getCell(`A${r}`).value = m[0];
        summary.getCell(`B${r}`).value = m[1];
        summary.getCell(`A${r}`).font = { bold: true };
      });
      for (let r = 1; r <= 20; r += 1) {
        summary.getCell(`A${r}`).protection = { locked: true };
        summary.getCell(`B${r}`).protection = { locked: true };
      }

      await ws.protect('rec_export_lock', {
        selectLockedCells: true,
        selectUnlockedCells: true,
        formatCells: false,
        formatColumns: false,
        formatRows: false,
        insertColumns: false,
        insertRows: false,
        deleteColumns: false,
        deleteRows: false,
      });
      await summary.protect('rec_export_lock', {
        selectLockedCells: true,
        selectUnlockedCells: true,
      });

      // Quiz and poll result sheets in the same Excel workbook.
      const { quizRows, pollRows } = buildQuizAndPollRows(s);
      function addQuizPollSheet(sheetName, sheetTitle, sourceRows) {
        const sheet = workbook.addWorksheet(sheetName);
        sheet.columns = [
          { header: 'S No', key: 'sno', width: 8 },
          { header: 'Date & Time', key: 'createdAt', width: 24 },
          { header: 'Question', key: 'question', width: 42 },
          { header: 'Option', key: 'optionLabel', width: 28 },
          { header: 'Responses', key: 'responses', width: 12 },
          { header: 'Total Responses', key: 'totalResponses', width: 16 },
          { header: 'Activity ID', key: 'activityId', width: 24 },
        ];

        if (recLogoImageId) {
          sheet.addImage(recLogoImageId, { tl: { col: 0, row: 0 }, ext: { width: 72, height: 72 } });
        }
        sheet.mergeCells('B1:G1');
        sheet.getCell('B1').value = 'Rajalakshmi Engineering College ( An Autonomous Institution)';
        sheet.getCell('B1').font = { name: 'Calibri', size: 14, bold: true, color: { argb: 'FF24135F' } };
        sheet.mergeCells('B2:G2');
        sheet.getCell('B2').value = sheetTitle;
        sheet.getCell('B2').font = { name: 'Calibri', size: 12, bold: true };
        sheet.mergeCells('B3:G3');
        sheet.getCell('B3').value = `Topic: ${s.topic || '—'} | Venue: ${s.venue || '—'}`;
        sheet.getCell('B3').font = { name: 'Calibri', size: 10 };

        const headerRowIdx = 5;
        const headers = ['S No', 'Date & Time', 'Question', 'Option', 'Responses', 'Total Responses', 'Activity ID'];
        headers.forEach((h, i) => {
          const cell = sheet.getCell(headerRowIdx, i + 1);
          cell.value = h;
          cell.font = { bold: true, color: { argb: 'FF24135F' } };
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF2FF' } };
          cell.border = {
            top: { style: 'thin', color: { argb: 'FFD1D5DB' } },
            left: { style: 'thin', color: { argb: 'FFD1D5DB' } },
            bottom: { style: 'thin', color: { argb: 'FFD1D5DB' } },
            right: { style: 'thin', color: { argb: 'FFD1D5DB' } },
          };
          cell.protection = { locked: true };
        });

        const rowsForSheet = Array.isArray(sourceRows) ? sourceRows : [];
        if (!rowsForSheet.length) {
          sheet.mergeCells(`A${headerRowIdx + 1}:G${headerRowIdx + 1}`);
          sheet.getCell(`A${headerRowIdx + 1}`).value = `No ${sheetName.toLowerCase()} available for this session.`;
        } else {
          rowsForSheet.forEach((row, idx) => {
            const excelRow = sheet.addRow({
              sno: idx + 1,
              createdAt: row.createdAt ? new Date(row.createdAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—',
              question: row.question || '—',
              optionLabel: row.optionLabel || '—',
              responses: Number(row.responses || 0),
              totalResponses: Number(row.totalResponses || 0),
              activityId: row.activityId || '—',
            });
            excelRow.eachCell((cell) => {
              cell.border = {
                top: { style: 'thin', color: { argb: 'FFE5E7EB' } },
                left: { style: 'thin', color: { argb: 'FFE5E7EB' } },
                bottom: { style: 'thin', color: { argb: 'FFE5E7EB' } },
                right: { style: 'thin', color: { argb: 'FFE5E7EB' } },
              };
              cell.protection = { locked: false };
            });
          });
        }

        for (let r = 1; r <= Math.max(headerRowIdx + rowsForSheet.length + 3, 20); r += 1) {
          if (!sheet.getCell(`A${r}`).protection) sheet.getCell(`A${r}`).protection = { locked: true };
        }
      }

      addQuizPollSheet('Quiz Results', 'Quiz Results', quizRows);
      addQuizPollSheet('Poll Results', 'Poll Results', pollRows);

      const buffer = await workbook.xlsx.writeBuffer();
      const fname = `student-scores-last60s-${(s.topic || 'session').replace(/\s+/g, '-')}.xlsx`;
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
      return res.send(Buffer.from(buffer));
    } catch (e) {
      return res.status(500).json({ ok: false, message: 'Failed to generate Excel export.' });
    }
  }
  if (format === 'csv') {
    const header = ['Register Number', 'Current Score', 'Average Score (Last 60s)', 'Mode', 'Source', 'Samples', 'Last Updated'];
    const lines = [header.map(csvEscapeCell).join(',')];
    rows.forEach((r) => {
      lines.push([
        csvEscapeCell(r.registerNumber),
        csvEscapeCell(r.currentScore),
        csvEscapeCell(r.averageAttention),
        csvEscapeCell(r.mode),
        csvEscapeCell(r.sourceType),
        csvEscapeCell(r.sampleCount),
        csvEscapeCell(r.lastUpdatedAt || ''),
      ].join(','));
    });
    const csv = `\ufeff${lines.join('\r\n')}`;
    const fname = `student-scores-last60s-${(s.topic || 'session').replace(/\s+/g, '-')}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    return res.send(csv);
  }
  if (format === 'pdf') {
    try {
      const doc = new PDFDocument({ margin: 50 });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => {
        const pdfBuffer = Buffer.concat(chunks);
        const fname = `student-scores-last60s-${(s.topic || 'session').replace(/\s+/g, '-')}.pdf`;
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
        res.send(pdfBuffer);
      });
      doc.fontSize(15).font('Helvetica-Bold').text('Individual Student Attention Scores (Last 60s)', { align: 'center' });
      doc.moveDown(0.4);
      doc.fontSize(10).font('Helvetica');
      doc.text(`Topic: ${s.topic || '—'}`);
      doc.text(`Venue: ${s.venue || '—'}`);
      doc.text(`Generated: ${new Date().toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'medium' })}`);
      doc.moveDown(0.8);
      doc.font('Helvetica-Bold').text('Register', 55, doc.y, { continued: true, width: 110 });
      doc.text('Score Value (Live)', { continued: true, width: 100 });
      doc.text('Average', { continued: true, width: 70 });
      doc.text('Mode', { continued: true, width: 80 });
      doc.text('Source', { continued: true, width: 90 });
      doc.text('Samples');
      doc.font('Helvetica');
      rows.forEach((r) => {
        doc.text(r.registerNumber, 55, doc.y, { continued: true, width: 110 });
        doc.text(r.currentScore != null ? `${r.currentScore}%` : '—', { continued: true, width: 100 });
        doc.text(`${r.averageAttention}%`, { continued: true, width: 70 });
        doc.text(r.mode, { continued: true, width: 80 });
        doc.text(r.sourceType, { continued: true, width: 90 });
        doc.text(String(r.sampleCount));
      });
      if (!rows.length) {
        doc.text('No student scores available for the last 60 seconds.');
      }
      doc.end();
      return;
    } catch (e) {
      return res.status(500).json({ ok: false, message: 'Failed to generate PDF export.' });
    }
  }
  return res.status(400).json({ ok: false, message: 'Unsupported format. Use csv or pdf.' });
});

// Public live-attention endpoint for students (no auth) - for Digital Classroom Map
app.get('/api/live-attention/public', (req, res) => {
  const { sessionId } = req.query;
  const s = sessions[sessionId];
  if (!s || s.closed) {
    return res.status(404).json({ ok: false, message: 'Session not found or closed.' });
  }
  const now = Date.now();
  const sixtySecAgo = now - 60 * 1000;
  const historyLast60s = s.attentionHistory.filter((p) => new Date(p.t).getTime() >= sixtySecAgo);
  const sum = historyLast60s.reduce((acc, p) => acc + p.score, 0);
  const averageAttention = historyLast60s.length ? sum / historyLast60s.length : 0;
  const zoneHistory = s.zoneHistory || {};
  const zones = {};
  for (const zoneId of ZONE_IDS) {
    const hist = zoneHistory[zoneId] || [];
    const recent = hist.filter((p) => new Date(p.t).getTime() >= sixtySecAgo);
    const avg = recent.length ? recent.reduce((acc, p) => acc + p.score, 0) / recent.length : null;
    zones[zoneId] = avg != null ? Number(avg.toFixed(2)) : null;
  }
  const hasAnyZonePub = ZONE_IDS.some((z) => zones[z] != null);
  if (!hasAnyZonePub && historyLast60s.length > 0) {
    const fill = Number(averageAttention.toFixed(2));
    for (const zoneId of ZONE_IDS) zones[zoneId] = fill;
  }
  return res.json({
    ok: true,
    averageAttention: Number(averageAttention.toFixed(2)),
    zones,
    ZONE_DISPLAY_LABELS,
  });
});

/**
 * Same visibility rules as the Leadership dashboard overview; used by GET /api/leadership/overview and automation.
 */
function getLeadershipOverviewMetrics(req) {
  const email = req.session.userEmail;
  const me = users[email];
  const effectiveDesignationRaw = req.session.leadershipEffectiveDesignation;
  const effectiveDeptCode = req.session.leadershipEffectiveDeptCode;
  const designationRaw = String(
    effectiveDesignationRaw != null
      ? effectiveDesignationRaw
      : (me && me.designation ? me.designation : '')
  ).trim();
  const designation = designationRaw.toLowerCase();
  const deptCode = String(
    effectiveDesignationRaw != null
      ? (effectiveDeptCode || (me && me.department ? me.department : ''))
      : (me && me.department ? me.department : '')
  ).trim().toLowerCase();

  let scopeDescription = 'Overview of all recorded classroom sessions.';
  const isHod =
    designation === 'hod' ||
    designation === 'ahod' ||
    designation.includes('head of the department') ||
    designation.includes('head of department');
  const isPrincipal = designation === 'principal';
  const isDirector = designation === 'director' || designation === 'directors' || designation.includes('director');
  const isVicePrincipal =
    designation === 'vice principal' || designation === 'vp' || designation === 'vice-principal';

  function canSeeSession(session) {
    const owner = users[session.ownerEmail];
    const ownerDept = owner && owner.department ? String(owner.department).trim().toLowerCase() : '';
    if (isHod && deptCode) {
      return ownerDept === deptCode;
    }
    if (isPrincipal || isDirector || isVicePrincipal) {
      return true;
    }
    if (deptCode) {
      return ownerDept === deptCode;
    }
    return false;
  }

  if (isHod && deptCode) {
    scopeDescription = `Overview of sessions from your department (${deptCode.toUpperCase()}).`;
  } else if (isPrincipal || isDirector || isVicePrincipal) {
    scopeDescription = 'College-wide overview across all departments.';
  }

  const allSessions = Object.values(sessions || {});
  const visibleSessions = allSessions.filter((s) => canSeeSession(s));

  const totalSessions = visibleSessions.length;
  let totalAttention = 0;
  let attentionCount = 0;
  let lowAttentionSessions = 0;
  let totalOdCount = 0;
  let openSessions = 0;

  const list = visibleSessions.map((s) => {
    if (!s.closed) openSessions += 1;
    const owner = users[s.ownerEmail] || {};
    const dept = owner.department || '';
    let avg = null;
    if (Array.isArray(s.attentionHistory) && s.attentionHistory.length) {
      const scores = s.attentionHistory.map((p) => Number(p.score) || 0);
      const sum = scores.reduce((a, b) => a + b, 0);
      avg = sum / scores.length;
      totalAttention += avg;
      attentionCount += 1;
    }
    if (typeof avg === 'number' && avg < 45) {
      lowAttentionSessions += 1;
    }
    const rows = Object.values(attendanceRecords || {}).filter((r) => r && r.sessionId === s.id);
    totalOdCount += rows.filter((r) => r.status === 'OD').length;
    return {
      id: s.id,
      topic: s.topic,
      facultyName: owner.name || s.ownerEmail,
      department: dept,
      averageAttention: avg != null ? Number(avg.toFixed(2)) : null,
      closed: !!s.closed,
      startTime: s.startTime,
      endTime: s.endTime,
    };
  });

  list.sort((a, b) => {
    const ta = a.startTime ? new Date(a.startTime).getTime() : 0;
    const tb = b.startTime ? new Date(b.startTime).getTime() : 0;
    return tb - ta;
  });

  const averageAttentionAll =
    attentionCount > 0 ? Number((totalAttention / attentionCount).toFixed(2)) : null;

  const roleLabel = req.session.leadershipRoleLabel || 'Leadership';

  return {
    roleLabel,
    scopeDescription,
    totalSessions,
    openSessions,
    averageAttentionAll,
    lowAttentionSessions,
    totalOdCount,
    sessions: list,
  };
}

// Leadership overview: high-level engagement summary for Principal / Directors / HoDs / Vice Principals.
app.get('/api/leadership/overview', ensureLeadership, (req, res) => {
  const m = getLeadershipOverviewMetrics(req);
  return res.json({
    ok: true,
    roleLabel: m.roleLabel,
    scopeDescription: m.scopeDescription,
    totalSessions: m.totalSessions,
    averageAttentionAll: m.averageAttentionAll,
    lowAttentionSessions: m.lowAttentionSessions,
    totalOdCount: m.totalOdCount,
    sessions: m.sessions.slice(0, 20),
  });
});

app.use((req, res, next) => {
  if (!ATTENDANCE_SYSTEM_DISABLED) return next();
  const p = String((req.path || req.url || '')).trim();
  const isAttendanceApi =
    p === '/api/student/attendance-history' ||
    p.startsWith('/api/attendance/');
  if (!isAttendanceApi) return next();
  return res.status(503).json({
    ok: false,
    message: 'Attendance system is temporarily disabled.',
  });
});

// HOD / Leadership: department attendance by session (Present, Absent, OD counts).
app.get('/api/attendance/department', ensureLeadership, (req, res) => {
  const email = req.session.userEmail;
  const me = users[email];
  const effectiveDesignationRaw = req.session.leadershipEffectiveDesignation;
  const effectiveDeptCode = req.session.leadershipEffectiveDeptCode;
  const deptCode = String(
    effectiveDesignationRaw != null
      ? (effectiveDeptCode || (me && me.department ? me.department : ''))
      : (me && me.department ? me.department : '')
  ).trim().toLowerCase();
  const designationRaw = String(
    effectiveDesignationRaw != null
      ? effectiveDesignationRaw
      : (me && me.designation ? me.designation : '')
  ).trim().toLowerCase();
  const isHod = designationRaw === 'hod' || designationRaw === 'ahod' ||
    designationRaw.includes('head of department') || designationRaw.includes('head of the department');
  const isPrincipal = designationRaw === 'principal';
  const isDirector = designationRaw === 'director' || designationRaw.includes('director');
  const isVicePrincipal = designationRaw === 'vice principal' || designationRaw === 'vp';

  // Security: department-wise attendance counts (Present/Absent/OD)
  // are visible only to HOD/AHOD.
  if (!isHod) {
    return res.json({ ok: true, canView: false, sessions: [] });
  }

  function canSeeSession(session) {
    const owner = users[session.ownerEmail];
    const ownerDept = owner && owner.department ? String(owner.department).trim().toLowerCase() : '';
    if (isHod && deptCode) return ownerDept === deptCode;
    if (isPrincipal || isDirector || isVicePrincipal) return true;
    if (deptCode) return ownerDept === deptCode;
    return false;
  }

  const visibleSessions = Object.values(sessions).filter((s) => canSeeSession(s));
  const result = visibleSessions.map((s) => {
    const rows = Object.values(attendanceRecords).filter((r) => r.sessionId === s.id);
    const present = rows.filter((r) => r.status === 'Present').length;
    const absent = rows.filter((r) => r.status === 'Absent').length;
    const od = rows.filter((r) => r.status === 'OD').length;
    const owner = users[s.ownerEmail] || {};
    return {
      sessionId: s.id,
      topic: s.topic,
      venue: s.venue,
      facultyName: owner.name || s.ownerEmail,
      department: owner.department || '',
      startTime: s.startTime,
      closed: !!s.closed,
      total: rows.length,
      present,
      absent,
      od,
      rows,
    };
  });
  result.sort((a, b) => {
    const ta = a.startTime ? new Date(a.startTime).getTime() : 0;
    const tb = b.startTime ? new Date(b.startTime).getTime() : 0;
    return tb - ta;
  });
  return res.json({ ok: true, canView: true, sessions: result });
});

// List active (non-closed) sessions for this faculty — for multi-class / parallel session view
app.get('/api/sessions/active', ensureAuthenticated, (req, res) => {
  const email = req.session.userEmail;
  const list = Object.values(sessions)
    .filter((s) => !s.closed && s.ownerEmail === email)
    .map((s) => {
      const history = s.attentionHistory;
      const avg =
        history.length > 0
          ? history.reduce((acc, v) => acc + v.score, 0) / history.length
          : 0;
      return {
        id: s.id,
        topic: s.topic,
        venue: s.venue,
        deviceCount: pruneDeviceIds(s),
        averageAttention: Number(avg.toFixed(2)),
        // Role information for this logged-in faculty (owner vs viewer/co-host)
        isOwner: s.ownerEmail === email,
      };
    });
  res.json({ ok: true, sessions: list });
});

// Global session status for student dashboard: used to auto-block camera/stream
// until a faculty member explicitly starts and advertises an active session.
app.get('/api/session-status', (req, res) => {
  const activeId = globalSessionActive ? lastActiveSessionId : null;
  const activeSession = activeId ? sessions[activeId] : null;
  const a = activeSession && activeSession.latestClassroomActivity ? activeSession.latestClassroomActivity : null;
  const safeActivity = a ? {
    id: String(a.id || ''),
    type: String(a.type || ''),
    question: String(a.question || ''),
    options: Array.isArray(a.options) ? a.options.map((x) => String(x || '')) : [],
    optionCounts: Array.isArray(a.optionCounts) ? a.optionCounts.map((n) => Number(n || 0)) : [],
    createdAt: String(a.createdAt || ''),
    sessionId: String(a.sessionId || ''),
  } : null;
  return res.json({
    ok: true,
    active: globalSessionActive,
    sessionId: activeId,
    latestClassroomActivity: safeActivity,
  });
});

// Smart attendance: student fetches session signing key for AES/HMAC (hybrid attendance encryption).
app.get('/api/attendance/signing-key', (req, res) => {
  if (!req.session || !req.session.studentEmail || !req.session.studentId) {
    return res.status(401).json({ ok: false, message: 'Please sign in as a student.' });
  }
  if (!isCampusAttendanceIpAllowed(req)) {
    return res.status(403).json({ ok: false, message: 'Attendance is restricted to campus network only.' });
  }
  const sessionId = req.query.sessionId;
  if (!sessionId) return res.status(400).json({ ok: false, message: 'Missing sessionId.' });
  const s = sessions[sessionId];
  if (!s || !s.signingKey) return res.status(404).json({ ok: false, message: 'Session not found or no key.' });
  return res.json({ ok: true, signingKey: s.signingKey });
});

// Smart attendance: student submits hybrid attendance (hand+face+attention). Supports encrypted+signed payload.
// Uses session.studentId (registerNumber) on the server so we never need to send identity from the browser.
app.post('/api/attendance/submit', (req, res) => {
  if (!req.session || !req.session.studentEmail || !req.session.studentId) {
    return res.status(401).json({ ok: false, message: 'Please sign in as a student.' });
  }
  if (!isCampusAttendanceIpAllowed(req)) {
    return res.status(403).json({ ok: false, message: 'Attendance is restricted to campus network only.' });
  }
  if (HAND_RAISE_DISABLED) {
    return res.status(403).json({ ok: false, message: 'Smart Attendance (hand-raise) is disabled in this demo.' });
  }
  let body = req.body || {};
  const { encryptedData, signature, hash: payloadHash } = body;
  const sessionId = body.sessionId;

  // If encrypted payload: verify integrity, decrypt, verify HMAC
  if (encryptedData && typeof encryptedData === 'string' && sessionId) {
    const s = sessions[sessionId];
    if (!s || !s.signingKey) {
      return res.status(400).json({ ok: false, message: 'Invalid session for encrypted attendance.' });
    }
    if (payloadHash && security.integrityHash(encryptedData) !== payloadHash) {
      return res.status(400).json({ ok: false, message: 'Integrity check failed.' });
    }
    try {
      const decrypted = security.decryptForSession(encryptedData, s.signingKey);
      body = JSON.parse(decrypted);
      if (body.sessionId !== sessionId) {
        return res.status(400).json({ ok: false, message: 'Session mismatch.' });
      }
    } catch (e) {
      return res.status(400).json({ ok: false, message: 'Invalid encrypted payload.' });
    }
    if (signature && !security.verifyAttentionSignature(body, signature, s.signingKey)) {
      return res.status(401).json({ ok: false, message: 'Signature verification failed.' });
    }
  }

  const { status, notebookPresent } = body;
  if (!sessionId || !status) {
    return res.status(400).json({ ok: false, message: 'Missing sessionId or status.' });
  }
  const registerNumber = resolveAttendanceRegisterNumberFromSession(req);
  if (!registerNumber) {
    return res.status(400).json({ ok: false, message: 'Unable to resolve register number from signed-in student.' });
  }
  const key = `${sessionId}:${registerNumber}`;
  const today = new Date().toISOString().slice(0, 10);
  const prev = attendanceRecords[key] || {};

  attendanceRecords[key] = {
    sessionId,
    registerNumber,
    date: today,
    status, // 'Present' | 'Absent' | 'OD'
    notebookPresent: (typeof notebookPresent === 'boolean') ? notebookPresent : null,
    odProofUrl: prev.odProofUrl || null,
    odName: prev.odName,
    odPurpose: prev.odPurpose,
    odProofHash: prev.odProofHash || null,
    odApproval: prev.odApproval,
    odFinalApprovalEmailSent: prev.odFinalApprovalEmailSent === true,
  };
  saveDatabase();

  return res.json({ ok: true });
});

// Smart attendance: faculty view for a given session.
app.get('/api/attendance/session/:sessionId', (req, res) => {
  if (!req.session || !req.session.userEmail) {
    return res.status(401).json({ ok: false, message: 'Please sign in as faculty.' });
  }
  const sessionId = req.params.sessionId;
  if (!sessionId) {
    return res.status(400).json({ ok: false, message: 'Missing sessionId.' });
  }
  const rowsRaw = Object.values(attendanceRecords).filter((r) => r.sessionId === sessionId);
  rowsRaw.sort((a, b) => String(a.registerNumber).localeCompare(String(b.registerNumber)));
  const rows = rowsRaw.map((r) => {
    if (!r || r.status !== 'OD') return r;
    // Hide OD proof link until both AHOD + HOD accepted.
    const ahodDecision = r.odApproval && r.odApproval.ahod ? r.odApproval.ahod.decision : null;
    const hodDecision = r.odApproval && r.odApproval.hod ? r.odApproval.hod.decision : null;
    const bothAccepted = ahodDecision === 'accepted' && hodDecision === 'accepted';
    return { ...r, odProofUrl: bothAccepted ? r.odProofUrl : null };
  });
  return res.json({ ok: true, rows });
});

// Student: day-to-day attendance history (Present / Absent / OD) across all sessions.
app.get('/api/student/attendance-history', (req, res) => {
  if (!req.session || !req.session.studentId) {
    return res.status(401).json({ ok: false, message: 'Please sign in as a student.' });
  }
  const reg = String(req.session.studentId).trim();
  const limit = Math.min(500, Math.max(1, parseInt(String(req.query.limit || '200'), 10) || 200));
  const entries = [];
  Object.values(attendanceRecords).forEach((r) => {
    if (!r || String(r.registerNumber).trim() !== reg) return;
    if (!r.sessionId) return;
    const s = sessions[r.sessionId];
    const owner = s && s.ownerEmail ? users[s.ownerEmail] : null;
    entries.push({
      date: r.date || (s && s.startTime ? new Date(s.startTime).toISOString().slice(0, 10) : ''),
      sessionId: r.sessionId,
      topic: s && s.topic ? String(s.topic) : '—',
      venue: s && s.venue ? String(s.venue) : '—',
      startTime: s && s.startTime ? s.startTime : null,
      status: r.status || '—',
      facultyName: owner && owner.name ? String(owner.name) : (s && s.ownerEmail ? String(s.ownerEmail) : '—'),
    });
  });
  entries.sort((a, b) => {
    const da = String(a.date || '').localeCompare(String(b.date || ''));
    if (da !== 0) return da < 0 ? 1 : -1; // newest date first
    const ta = a.startTime ? new Date(a.startTime).getTime() : 0;
    const tb = b.startTime ? new Date(b.startTime).getTime() : 0;
    return tb - ta;
  });
  return res.json({ ok: true, entries: entries.slice(0, limit) });
});

function parseAttendanceDateFilterParam(v) {
  const s = String(v || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return s;
}

/** All attendance rows for sessions owned by this faculty email, optionally filtered by record date (YYYY-MM-DD). */
function buildFacultyAttendanceEntriesForOwner(ownerEmailLower, fromIso, toIso) {
  const email = String(ownerEmailLower || '').trim().toLowerCase();
  const entries = [];
  Object.values(attendanceRecords).forEach((r) => {
    if (!r || !r.sessionId) return;
    const s = sessions[r.sessionId];
    if (!s || String(s.ownerEmail || '').trim().toLowerCase() !== email) return;
    const dateStr = r.date || (s.startTime ? new Date(s.startTime).toISOString().slice(0, 10) : '');
    if (fromIso && dateStr && dateStr < fromIso) return;
    if (toIso && dateStr && dateStr > toIso) return;
    entries.push({
      date: dateStr,
      sessionId: r.sessionId,
      topic: s.topic ? String(s.topic) : '—',
      venue: s.venue ? String(s.venue) : '—',
      startTime: s.startTime || null,
      registerNumber: String(r.registerNumber || '').trim(),
      status: r.status || '—',
    });
  });
  entries.sort((a, b) => {
    const da = String(a.date || '').localeCompare(String(b.date || ''));
    if (da !== 0) return da < 0 ? 1 : -1;
    const ta = a.startTime ? new Date(a.startTime).getTime() : 0;
    const tb = b.startTime ? new Date(b.startTime).getTime() : 0;
    if (tb !== ta) return tb - ta;
    return String(a.registerNumber).localeCompare(String(b.registerNumber));
  });
  return entries;
}

function csvEscapeCell(val) {
  const s = val == null ? '' : String(val);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function buildAdminRegistrationRows() {
  const rows = [];
  Object.keys(users).forEach((email) => {
    const u = users[email] || {};
    rows.push({
      type: 'Faculty',
      email: String(email || '').trim().toLowerCase(),
      designation: String(u.designation || '').trim() || 'Faculty',
      name: String(u.name || '').trim() || '—',
      createdAt: u.createdAt || null,
      isRegistered: true,
      emailVerified: !!u.emailVerified,
    });
  });
  Object.keys(studentRegistrations).forEach((loginEmail) => {
    const s = studentRegistrations[loginEmail] || {};
    rows.push({
      type: 'Student',
      email: String(loginEmail || '').trim().toLowerCase(),
      designation: 'Student',
      name: String(s.name || '').trim() || '—',
      createdAt: s.createdAt || null,
      isRegistered: true,
      emailVerified: !!s.emailVerified,
    });
  });
  rows.sort((a, b) => {
    const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return tb - ta;
  });
  return rows.map((r, idx) => ({
    sNo: idx + 1,
    date: r.createdAt ? new Date(r.createdAt).toLocaleDateString('en-IN') : '—',
    time: r.createdAt ? new Date(r.createdAt).toLocaleTimeString('en-IN') : '—',
    designation: r.designation,
    name: r.name,
    type: r.type,
    email: r.email,
    registered: r.isRegistered ? 'Yes' : 'No',
    emailVerified: r.emailVerified ? 'Yes' : 'No',
  }));
}

app.get('/api/admin/registrations', ensureAdmin, (req, res) => {
  const rows = buildAdminRegistrationRows();
  const facultyCount = rows.filter((r) => r.type === 'Faculty').length;
  const studentCount = rows.filter((r) => r.type === 'Student').length;
  return res.json({
    ok: true,
    counts: {
      facultyRegistrations: facultyCount,
      studentRegistrations: studentCount,
    },
    rows,
  });
});

app.post('/api/admin/registrations/verify', ensureAdmin, (req, res) => {
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  const type = String((req.body && req.body.type) || '').trim();
  const verified = !!(req.body && req.body.emailVerified);
  if (!email || !type) return res.status(400).json({ ok: false, message: 'Email and type are required.' });
  if (type === 'Faculty') {
    const rec = users[email];
    if (!rec) return res.status(404).json({ ok: false, message: 'Faculty record not found.' });
    rec.emailVerified = verified;
    saveDatabase();
    return res.json({ ok: true });
  }
  if (type === 'Student') {
    const rec = studentRegistrations[email];
    if (!rec) return res.status(404).json({ ok: false, message: 'Student record not found.' });
    rec.emailVerified = verified;
    saveDatabase();
    return res.json({ ok: true });
  }
  return res.status(400).json({ ok: false, message: 'Unsupported registration type.' });
});

app.get('/api/admin/registrations/export', ensureAdmin, (req, res) => {
  const rows = buildAdminRegistrationRows();
  const header = ['S NO', 'Date', 'Time', 'Designation', 'Name', 'Type', 'Registered', 'Email Verified', 'Email'];
  const lines = [header.map(csvEscapeCell).join(',')];
  rows.forEach((r) => {
    lines.push([
      csvEscapeCell(r.sNo),
      csvEscapeCell(r.date),
      csvEscapeCell(r.time),
      csvEscapeCell(r.designation),
      csvEscapeCell(r.name),
      csvEscapeCell(r.type),
      csvEscapeCell(r.registered),
      csvEscapeCell(r.emailVerified),
      csvEscapeCell(r.email),
    ].join(','));
  });
  const csv = `\ufeff${lines.join('\r\n')}`;
  const fname = `admin-registrations-${new Date().toISOString().slice(0, 10)}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
  return res.send(csv);
});

app.get('/api/admin/database/download', ensureAdmin, (req, res) => {
  if (!fs.existsSync(DB_FILE)) {
    return res.status(404).json({ ok: false, message: 'Database file not found.' });
  }
  const filename = `db-${new Date().toISOString().slice(0, 10)}.json`;
  return res.download(DB_FILE, filename);
});

// Faculty: day-to-day attendance log for all sessions you own (every student row).
// Optional query: from=YYYY-MM-DD, to=YYYY-MM-DD (inclusive on calendar date stored per row).
app.get('/api/attendance/faculty-history', (req, res) => {
  if (!req.session || !req.session.userEmail) {
    return res.status(401).json({ ok: false, message: 'Please sign in as faculty.' });
  }
  const email = String(req.session.userEmail).trim().toLowerCase();
  const limit = Math.min(1000, Math.max(1, parseInt(String(req.query.limit || '500'), 10) || 500));
  const fromIso = parseAttendanceDateFilterParam(req.query.from);
  const toIso = parseAttendanceDateFilterParam(req.query.to);
  if (req.query.from && !fromIso) {
    return res.status(400).json({ ok: false, message: 'Invalid from date. Use YYYY-MM-DD.' });
  }
  if (req.query.to && !toIso) {
    return res.status(400).json({ ok: false, message: 'Invalid to date. Use YYYY-MM-DD.' });
  }
  if (fromIso && toIso && fromIso > toIso) {
    return res.status(400).json({ ok: false, message: 'From date must be on or before to date.' });
  }
  const entries = buildFacultyAttendanceEntriesForOwner(email, fromIso, toIso);
  return res.json({ ok: true, entries: entries.slice(0, limit) });
});

// Faculty: download attendance as CSV (date range optional; UTF-8 with BOM for Excel).
app.get('/api/attendance/faculty-export', (req, res) => {
  if (!req.session || !req.session.userEmail) {
    return res.status(401).json({ ok: false, message: 'Please sign in as faculty.' });
  }
  const email = String(req.session.userEmail).trim().toLowerCase();
  const fromIso = parseAttendanceDateFilterParam(req.query.from);
  const toIso = parseAttendanceDateFilterParam(req.query.to);
  if (req.query.from && !fromIso) {
    return res.status(400).json({ ok: false, message: 'Invalid from date. Use YYYY-MM-DD.' });
  }
  if (req.query.to && !toIso) {
    return res.status(400).json({ ok: false, message: 'Invalid to date. Use YYYY-MM-DD.' });
  }
  if (fromIso && toIso && fromIso > toIso) {
    return res.status(400).json({ ok: false, message: 'From date must be on or before to date.' });
  }
  const entries = buildFacultyAttendanceEntriesForOwner(email, fromIso, toIso);
  const maxRows = 10000;
  const rows = entries.slice(0, maxRows);
  const header = ['Date', 'Session ID', 'Topic', 'Venue', 'Start time (ISO)', 'Register number', 'Status'];
  const lines = [header.map(csvEscapeCell).join(',')];
  rows.forEach((e) => {
    lines.push(
      [
        csvEscapeCell(e.date),
        csvEscapeCell(e.sessionId),
        csvEscapeCell(e.topic),
        csvEscapeCell(e.venue),
        csvEscapeCell(e.startTime || ''),
        csvEscapeCell(e.registerNumber),
        csvEscapeCell(e.status),
      ].join(','),
    );
  });
  const csv = `\ufeff${lines.join('\r\n')}`;
  let fname = 'faculty-attendance-export.csv';
  if (fromIso && toIso) fname = `attendance_${fromIso}_to_${toIso}.csv`;
  else if (fromIso) fname = `attendance_from_${fromIso}.csv`;
  else if (toIso) fname = `attendance_until_${toIso}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${fname.replace(/"/g, '')}"`);
  return res.send(csv);
});

// ---- Daily faculty attendance email (CSV + branded HTML, SMTP) ----
let lastDailyFacultyAttendanceEmailSentYmd = '';

function ymdInTimeZone(date, timeZone) {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    const parts = fmt.formatToParts(date);
    const y = parts.find((p) => p.type === 'year').value;
    const mo = parts.find((p) => p.type === 'month').value;
    const d = parts.find((p) => p.type === 'day').value;
    return `${y}-${mo}-${d}`;
  } catch (_) {
    return new Date(date).toISOString().slice(0, 10);
  }
}

function hourMinuteInTimeZone(date, timeZone) {
  try {
    const fmt = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false });
    const s = fmt.format(date).replace(/\s/g, '');
    const m = s.match(/^(\d{1,2}):(\d{2})/);
    if (!m) return { h: 0, m: 0 };
    return { h: Number(m[1]), m: Number(m[2]) };
  } catch (_) {
    const d = new Date(date);
    return { h: d.getHours(), m: d.getMinutes() };
  }
}

function buildFacultyAttendanceCsvContentForEmail(entries) {
  const header = ['Date', 'Session ID', 'Topic', 'Venue', 'Start time (ISO)', 'Register number', 'Status'];
  const lines = [header.map(csvEscapeCell).join(',')];
  entries.forEach((e) => {
    lines.push(
      [
        csvEscapeCell(e.date),
        csvEscapeCell(e.sessionId),
        csvEscapeCell(e.topic),
        csvEscapeCell(e.venue),
        csvEscapeCell(e.startTime || ''),
        csvEscapeCell(e.registerNumber),
        csvEscapeCell(e.status),
      ].join(','),
    );
  });
  return `\ufeff${lines.join('\r\n')}`;
}

async function sendDailyAttendanceEmailToFaculty(facultyEmail, reportYmd, entries) {
  const to = String(facultyEmail || '').trim().toLowerCase();
  if (!to || !smtpConfigured || !entries || !entries.length) return false;
  const logoPath = publicPath('rec-logo.jpg');
  const logoPathAlt = publicPath('rajalakshmi_engineering_college_logo.jpg');
  const logoFile = fs.existsSync(logoPath) ? logoPath : fs.existsSync(logoPathAlt) ? logoPathAlt : null;
  const headerLogoHtml = logoFile
    ? '<img src="cid:rec-logo" alt="Rajalakshmi Engineering College" style="max-height:64px;width:auto;display:block;margin:0 auto 14px;" />'
    : '';
  const csvContent = buildFacultyAttendanceCsvContentForEmail(entries);
  const csvName = `attendance-${reportYmd}.csv`;
  const subject = `Daily Smart Attendance — ${reportYmd} | ${COLLEGE_HEADER_AUTONOMOUS}`;
  const textBody = `Daily Smart Attendance (${reportYmd})\n\n${COLLEGE_HEADER_AUTONOMOUS}\n\nAttached: ${csvName} (${entries.length} row(s)). Open in Microsoft Excel or Google Sheets.\n\n${COLLEGE_FOOTER_TEXT}`;
  const htmlBody = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="margin:0;background:#eceff1;font-family:Arial,Helvetica,sans-serif;line-height:1.5;color:#333;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eceff1;padding:28px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" style="max-width:560px;background:#ffffff;border-radius:10px;border:1px solid #e5e7eb;overflow:hidden;">
<tr><td style="padding:22px 24px;text-align:center;background:#fafafa;border-bottom:1px solid #ececec;">
  ${headerLogoHtml}
  <h1 style="margin:0;font-size:17px;font-weight:800;color:#24135f;line-height:1.35;">${escapeHtml(COLLEGE_HEADER_AUTONOMOUS)}</h1>
  <p style="margin:10px 0 0;font-size:13px;color:#6b6586;">Daily Smart Attendance export — <strong>${escapeHtml(reportYmd)}</strong></p>
</td></tr>
<tr><td style="padding:22px 24px;">
  <p style="margin:0 0 10px;font-size:14px;color:#374151;">Hello,</p>
  <p style="margin:0 0 18px;font-size:14px;color:#374151;">Your class <strong>Smart Attendance</strong> log for <strong>${escapeHtml(reportYmd)}</strong> is attached as a CSV file. Open it in <strong>Microsoft Excel</strong> or Google Sheets.</p>
  <p style="margin:0;font-size:13px;color:#6b7280;">Rows in this file: <strong>${entries.length}</strong>.</p>
</td></tr>
<tr><td style="padding:16px 24px;background:#fafafa;border-top:1px solid #ececec;text-align:center;font-size:12px;color:#6b7280;">${COLLEGE_FOOTER_HTML}</td></tr>
</table>
</td></tr>
</table></body></html>`;
  const mailOptions = {
    from: process.env.FROM_EMAIL || process.env.SMTP_USER,
    to,
    subject,
    text: textBody,
    html: htmlBody,
    attachments: [
      { filename: csvName, content: Buffer.from(csvContent, 'utf8'), contentType: 'text/csv; charset=utf-8' },
    ],
  };
  if (logoFile) {
    mailOptions.attachments.unshift({
      filename: 'rec-logo.jpg',
      content: fs.readFileSync(logoFile),
      cid: 'rec-logo',
    });
  }
  try {
    await transporter.sendMail(mailOptions);
    console.log(`Daily attendance email sent to ${to} for ${reportYmd} (${entries.length} rows).`);
    return true;
  } catch (err) {
    console.error(`Daily attendance email failed for ${to}:`, err && err.message ? err.message : err);
    return false;
  }
}

async function runDailyFacultyAttendanceEmailForYmd(reportYmd) {
  if (!smtpConfigured || !reportYmd) return;
  const keys = Object.keys(users || {});
  for (const email of keys) {
    const emailLower = String(email).trim().toLowerCase();
    const entries = buildFacultyAttendanceEntriesForOwner(emailLower, reportYmd, reportYmd);
    if (entries.length) {
      await sendDailyAttendanceEmailToFaculty(emailLower, reportYmd, entries);
      await new Promise((r) => setTimeout(r, 400));
    }
  }
}

function startDailyFacultyAttendanceEmailScheduler() {
  const tz = String(process.env.DAILY_ATTENDANCE_TZ || 'Asia/Kolkata').trim() || 'Asia/Kolkata';
  const targetHour = Math.min(23, Math.max(0, parseInt(String(process.env.DAILY_ATTENDANCE_EMAIL_HOUR || '18'), 10) || 18));
  const targetMin = Math.min(59, Math.max(0, parseInt(String(process.env.DAILY_ATTENDANCE_EMAIL_MINUTE || '0'), 10) || 0));
  setInterval(() => {
    const now = new Date();
    const { h, m } = hourMinuteInTimeZone(now, tz);
    if (h !== targetHour || m !== targetMin) return;
    const todayYmd = ymdInTimeZone(now, tz);
    if (lastDailyFacultyAttendanceEmailSentYmd === todayYmd) return;
    lastDailyFacultyAttendanceEmailSentYmd = todayYmd;
    runDailyFacultyAttendanceEmailForYmd(todayYmd).catch((e) => {
      console.error('Daily faculty attendance email job:', e && e.message ? e.message : e);
    });
  }, 30_000);
}

// Smart attendance: faculty edits a student's attendance status (Present/Absent/OD).
app.post('/api/attendance/edit', (req, res) => {
  if (!req.session || !req.session.userEmail) {
    return res.status(401).json({ ok: false, message: 'Please sign in as faculty.' });
  }
  const { sessionId, registerNumber, status } = req.body || {};
  if (!sessionId || !registerNumber || !status) {
    return res.status(400).json({ ok: false, message: 'Missing sessionId, registerNumber or status.' });
  }
  const allowed = ['Present', 'Absent', 'OD'];
  if (!allowed.includes(status)) {
    return res.status(400).json({ ok: false, message: 'Status must be Present, Absent or OD.' });
  }
  const s = sessions[sessionId];
  if (!s || s.closed) return res.status(400).json({ ok: false, message: 'Session not found or already closed.' });
  if (s.ownerEmail !== req.session.userEmail) {
    return res.status(403).json({ ok: false, message: 'You can only edit attendance for your own sessions.' });
  }
  // Attendance editing is allowed only for a short window after attention starts.
  const editWindowMs = 10 * 60 * 1000; // 10 minutes
  const startMs = s.startTime ? new Date(s.startTime).getTime() : NaN;
  if (!Number.isNaN(startMs) && Date.now() - startMs > editWindowMs) {
    return res.status(403).json({
      ok: false,
      message: 'Attendance editing is closed. You can edit only within 10 minutes of session start time.',
    });
  }
  const key = `${sessionId}:${String(registerNumber).trim()}`;
  const today = new Date().toISOString().slice(0, 10);
  const existing = attendanceRecords[key] || {};
  attendanceRecords[key] = {
    sessionId,
    registerNumber: String(registerNumber).trim(),
    date: today,
    status,
    notebookPresent: typeof existing.notebookPresent === 'boolean' ? existing.notebookPresent : null,
    odProofUrl: existing.odProofUrl || null,
    odName: existing.odName,
    odPurpose: existing.odPurpose,
    odProofHash: existing.odProofHash || null,
    odApproval: existing.odApproval || undefined,
    odFinalApprovalEmailSent: existing.odFinalApprovalEmailSent === true,
  };
  saveDatabase();
  return res.json({ ok: true });
});

// Smart attendance: student uploads OD proof for a session; marks status as OD.
app.post('/api/attendance/od-proof', upload.single('odProof'), (req, res) => {
  if (!req.session || !req.session.studentEmail || !req.session.studentId) {
    return res.status(401).json({ ok: false, message: 'Please sign in as a student.' });
  }
  if (OD_UPLOAD_DISABLED) {
    return res.status(403).json({ ok: false, message: 'OD proof upload is disabled in this demo.' });
  }
  const { sessionId, name: odNameFromBody, purpose, registerNumber: registerNumberFromBody } = req.body || {};
  if (!sessionId || !req.file) {
    return res.status(400).json({ ok: false, message: 'Missing sessionId or OD proof file.' });
  }
  const registerNumber = resolveAttendanceRegisterNumberFromSession(req);
  const studentEmail = String(req.session.studentEmail).trim().toLowerCase();
  // Security: the register number must match the signed-in student.
  if (!registerNumberFromBody || String(registerNumberFromBody).trim() !== registerNumber) {
    return res.status(400).json({ ok: false, message: 'Register number does not match signed-in student.' });
  }

  // Security: odName must match server-side student profile name (prevents tampering).
  const studentReg =
    studentRegistrations[studentEmail] ||
    studentRegistrations[registerNumber + STUDENT_EMAIL_SUFFIX] ||
    null;
  const expectedName = studentReg && studentReg.name ? String(studentReg.name).trim() : '';
  const providedName = odNameFromBody ? String(odNameFromBody).trim() : '';
  if (expectedName && providedName && expectedName !== providedName) {
    return res.status(400).json({ ok: false, message: 'Name does not match signed-in student.' });
  }
  const odName = expectedName || providedName || undefined;

  const key = `${sessionId}:${registerNumber}`;
  const today = new Date().toISOString().slice(0, 10);
  const odProofUrl = `/od-proofs/${req.file.filename}`;
  // Stable hash for digital signatures (so approvals sign the same uploaded proof content).
  let odProofHash = null;
  try {
    const fileBuf = fs.readFileSync(req.file.path);
    odProofHash = crypto.createHash('sha256').update(fileBuf).digest('hex');
  } catch (_) {
    // Non-fatal: approvals will sign with null hash if hashing fails.
  }

  attendanceRecords[key] = {
    sessionId,
    registerNumber,
    date: today,
    status: 'OD',
    odProofUrl,
    odName,
    odPurpose: purpose ? String(purpose).trim() : undefined,
    odProofHash,
    // Two-stage approvals: Assistant HoD then HoD.
    odApproval: { ahod: null, hod: null },
  };
  saveDatabase();

  const pendingMsg =
    'Your OD approval is pending. Your proof has been sent to the Assistant HoD (AHOD) and Head of Department (HoD) dashboards for review. When both have approved, you will receive an email at your registered college address (if email is configured). Check this page again in about 10 minutes for status updates. Leadership dashboards are not visible to students—you can only track status here. After your faculty finalizes OD attendance in their dashboard, step-by-step approval details may no longer be shown here.';
  return res.json({ ok: true, message: pendingMsg });
});

// ---- OD Approval workflow (AHOD -> HOD -> Faculty proof visibility) ----
function normalizeOdDecision(decisionRaw) {
  const d = String(decisionRaw || '').trim().toLowerCase();
  if (d === 'accepted' || d === 'accept' || d === 'tick' || d === 'approved') return 'accepted';
  if (d === 'rejected' || d === 'reject' || d === 'x' || d === 'declined') return 'rejected';
  return null;
}

function computeOdProofHashFromRecord(record) {
  if (!record || record.odProofHash) return record ? record.odProofHash : null;
  if (!record || !record.odProofUrl || typeof record.odProofUrl !== 'string') return null;
  const filename = record.odProofUrl.split('/').pop();
  if (!filename) return null;
  const filePath = path.join(OD_DIR, filename);
  if (!fs.existsSync(filePath)) return null;
  try {
    const fileBuf = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(fileBuf).digest('hex');
  } catch (_) {
    return null;
  }
}

function computeOdVerificationProofHashFromRecord(record) {
  if (!record || !record.odApproval || !record.odApproval.ahod) return null;
  const ahod = record.odApproval.ahod;
  const verificationProofUrl = ahod.verificationProofUrl;
  if (!verificationProofUrl || typeof verificationProofUrl !== 'string') return null;
  const filename = verificationProofUrl.split('/').pop();
  if (!filename) return null;
  const filePath = path.join(OD_VERIFICATION_DIR, filename);
  if (!fs.existsSync(filePath)) return null;
  try {
    const fileBuf = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(fileBuf).digest('hex');
  } catch (_) {
    return null;
  }
}

// Leadership: fetch pending OD approvals for the logged-in leader (AHOD queue or HOD queue).
app.get('/api/attendance/od-pending', ensureLeadership, (req, res) => {
  const email = req.session.userEmail;
  const me = users[email];
  if (!me) return res.status(401).json({ ok: false, message: 'Leadership session invalid.' });

  const effectiveDesignationRaw = req.session.leadershipEffectiveDesignation;
  const effectiveDeptCode = req.session.leadershipEffectiveDeptCode;
  const deptCode = String(
    effectiveDesignationRaw != null ? (effectiveDeptCode || (me.department || '')) : (me.department || '')
  ).trim().toLowerCase();
  const designationRaw = String(
    effectiveDesignationRaw != null ? effectiveDesignationRaw : (me.designation || '')
  ).trim();

  const stage = isAssistantHoDDesignation(designationRaw) ? 'ahod'
    : (isHeadOfDepartmentDesignation(designationRaw) ? 'hod' : null);

  if (!stage) {
    return res.status(403).json({ ok: false, message: 'Your designation cannot approve OD proofs.' });
  }

  const items = [];
  const records = Object.values(attendanceRecords).filter((r) => r && r.status === 'OD');

  records.forEach((r) => {
    const s = sessions[r.sessionId];
    if (!s) return;
    const owner = users[s.ownerEmail];
    const ownerDept = owner && owner.department ? String(owner.department).trim().toLowerCase() : '';
    if (deptCode && ownerDept !== deptCode) return;

    // Stage gating:
    // - AHOD queue: no ahod signature yet.
    // - HOD queue: ahod accepted and no hod signature yet.
    if (stage === 'ahod') {
      if (r.odApproval && r.odApproval.ahod) return;
    } else if (stage === 'hod') {
      const ahod = r.odApproval && r.odApproval.ahod ? r.odApproval.ahod : null;
      if (!ahod || ahod.decision !== 'accepted') return;
      if (r.odApproval && r.odApproval.hod) return;
    }

    items.push({
      sessionId: r.sessionId,
      topic: s.topic,
      facultyName: owner && owner.name ? owner.name : s.ownerEmail,
      department: owner && owner.department ? owner.department : '',
      registerNumber: r.registerNumber,
      odName: r.odName,
      odPurpose: r.odPurpose,
      odProofUrl: r.odProofUrl,
      odProofHash: r.odProofHash || null,
      odApproval: r.odApproval || null,
    });
  });

  items.sort((a, b) => {
    const sa = sessions[a.sessionId];
    const sb = sessions[b.sessionId];
    const ta = sa && sa.startTime ? new Date(sa.startTime).getTime() : 0;
    const tb = sb && sb.startTime ? new Date(sb.startTime).getTime() : 0;
    return tb - ta;
  });

  return res.json({ ok: true, stage, items });
});

// Leadership: approve/reject and digitally sign the OD proof (AHOD then HOD).
// AHOD ACCEPT requires uploading a verification proof file to prevent mis-issue.
app.post('/api/attendance/od-approve', ensureLeadership, odVerificationUpload.single('ahodVerificationProof'), async (req, res) => {
  const email = req.session.userEmail;
  const me = users[email];
  if (!me) return res.status(401).json({ ok: false, message: 'Leadership session invalid.' });

  const effectiveDesignationRaw = req.session.leadershipEffectiveDesignation;
  const designationRaw = String(
    effectiveDesignationRaw != null ? effectiveDesignationRaw : (me.designation || '')
  ).trim();
  const stage = isAssistantHoDDesignation(designationRaw) ? 'ahod'
    : (isHeadOfDepartmentDesignation(designationRaw) ? 'hod' : null);

  if (!stage) return res.status(403).json({ ok: false, message: 'Your designation cannot approve OD proofs.' });

  const { sessionId, registerNumber, decision, reason } = req.body || {};
  if (!sessionId || !registerNumber || !decision) {
    return res.status(400).json({ ok: false, message: 'Missing sessionId, registerNumber or decision.' });
  }

  const normalizedDecision = normalizeOdDecision(decision);
  if (!normalizedDecision) {
    return res.status(400).json({ ok: false, message: 'decision must be accepted or rejected.' });
  }

  const key = `${sessionId}:${String(registerNumber).trim()}`;
  const record = attendanceRecords[key];
  if (!record || record.status !== 'OD') {
    return res.status(404).json({ ok: false, message: 'OD record not found.' });
  }

  // For integrity, compute/derive odProofHash for signing.
  const odProofHash = computeOdProofHashFromRecord(record);
  if (!odProofHash) {
    return res.status(400).json({ ok: false, message: 'OD proof hash missing; please re-upload OD proof.' });
  }

  record.odApproval = record.odApproval || { ahod: null, hod: null };

  if (stage === 'ahod') {
    if (record.odApproval.ahod) {
      return res.status(409).json({ ok: false, message: 'AHOD already signed this OD proof.' });
    }

    // AHOD ACCEPT: require verification proof upload.
    let ahodVerificationProofUrl = null;
    let ahodVerificationProofHash = null;
    if (normalizedDecision === 'accepted') {
      if (!req.file) {
        return res.status(400).json({ ok: false, message: 'AHOD verification proof file is required to ACCEPT OD proof.' });
      }
      ahodVerificationProofUrl = `/od-verification-proofs/${req.file.filename}`;
      try {
        const fileBuf = fs.readFileSync(req.file.path);
        ahodVerificationProofHash = crypto.createHash('sha256').update(fileBuf).digest('hex');
      } catch (_) {
        // Non-fatal: signing can fail if hash missing.
      }
      if (!ahodVerificationProofHash) {
        return res.status(400).json({ ok: false, message: 'AHOD verification proof hash could not be computed.' });
      }
    }

    const signedAt = new Date().toISOString();
    const payload = {
      sessionId: record.sessionId,
      registerNumber: record.registerNumber,
      odProofHash,
      decision: normalizedDecision,
      stage: 'ahod',
      ahodVerificationProofHash,
      signedBy: email,
      signedAt,
    };
    const signatureHex = security.signData(payload);
    record.odApproval.ahod = {
      decision: normalizedDecision,
      signedBy: email,
      signedAt,
      signatureHex,
      signatureVerified: true,
      reason: reason ? String(reason).trim() : undefined,
      verificationProofUrl: ahodVerificationProofUrl || undefined,
      verificationProofHash: ahodVerificationProofHash || undefined,
    };
  } else if (stage === 'hod') {
    if (record.odApproval.hod) {
      return res.status(409).json({ ok: false, message: 'HOD already signed this OD proof.' });
    }
    const ahod = record.odApproval.ahod;
    if (!ahod || ahod.decision !== 'accepted') {
      return res.status(403).json({ ok: false, message: 'HOD can approve only after AHOD accepted this OD.' });
    }

    // Cross-verify both proofs (student OD proof + AHOD verification proof) before signing.
    const ahodVerificationProofHash = computeOdVerificationProofHashFromRecord(record);
    if (!ahodVerificationProofHash) {
      return res.status(400).json({ ok: false, message: 'AHOD verification proof missing or cannot be verified.' });
    }

    const signedAt = new Date().toISOString();
    const payload = {
      sessionId: record.sessionId,
      registerNumber: record.registerNumber,
      odProofHash,
      ahodVerificationProofHash,
      decision: normalizedDecision,
      stage: 'hod',
      signedBy: email,
      signedAt,
    };
    const signatureHex = security.signData(payload);
    record.odApproval.hod = {
      decision: normalizedDecision,
      signedBy: email,
      signedAt,
      signatureHex,
      signatureVerified: true,
      reason: reason ? String(reason).trim() : undefined,
      odProofHashSigned: odProofHash,
      ahodVerificationProofHashSigned: ahodVerificationProofHash,
    };

    if (normalizedDecision === 'accepted' && !record.odFinalApprovalEmailSent) {
      const studentMail = findStudentEmailByRegisterNumber(record.registerNumber);
      const sess = sessions[record.sessionId];
      const topic = sess && sess.topic ? String(sess.topic) : '';
      if (studentMail) {
        const sent = await sendOdFullyApprovedStudentEmail(studentMail, {
          registerNumber: record.registerNumber,
          topic,
          sessionId: record.sessionId,
        });
        if (sent) record.odFinalApprovalEmailSent = true;
      } else {
        console.warn('OD fully approved but no student email found for register', record.registerNumber);
      }
    }
  }

  saveDatabase();
  return res.json({ ok: true });
});

// Build PDF buffer with summary and attention trend graph (for email attachment).
// Used when session ends; attached to email sent to faculty's official ID.
// summary may include: topic, venue, dateTime, averageAttention, facultyName, reportId, reportHash, reportSignature, reportVerifyBaseUrl
async function buildSessionPdfBuffer(summary, attentionHistory) {
  // Generate QR code for verification URL (optional; requires qrcode package)
  let qrBuffer = null;
  if (summary.reportVerifyBaseUrl && summary.reportId && QRCode) {
    try {
      const verifyUrl = `${summary.reportVerifyBaseUrl}/api/verify-report?reportId=${encodeURIComponent(summary.reportId)}`;
      qrBuffer = await QRCode.toBuffer(verifyUrl, { type: 'png', width: 120, margin: 1 });
    } catch (e) {
      // ignore QR generation errors
    }
  }
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // College logo at top (prefer rec-logo.jpg for branded exports)
    const logoDir = PUBLIC_DIR;
    const logoJpgPreferred = path.join(logoDir, 'rec-logo.jpg');
    const logoPng = path.join(logoDir, 'rec-logo.png');
    const logoJpg = path.join(logoDir, 'rec.jpg');
    const logoPath = fs.existsSync(logoJpgPreferred)
      ? logoJpgPreferred
      : fs.existsSync(logoPng)
        ? logoPng
        : fs.existsSync(logoJpg)
          ? logoJpg
          : null;
    if (logoPath) {
      try {
        const logoW = 100;
        const startY = doc.y;
        doc.image(logoPath, (doc.page.width - doc.page.margins.left - doc.page.margins.right) / 2 - logoW / 2 + doc.page.margins.left, startY, { width: logoW });
        doc.y = startY + logoW + 4;
        doc.fontSize(12).font('Helvetica-Bold').text('Rajalakshmi Engineering College ( An Autonmous Institution)', { align: 'center' });
        doc.moveDown(0.5);
      } catch (e) {
        // skip logo if image fails to load
      }
    }

    // ---- Section 1: Report title and faculty information at top ----
    doc.fontSize(16).font('Helvetica-Bold').text('AI-Based Classroom Attention System', { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(14).font('Helvetica').text('Session Report', { align: 'center' });
    doc.moveDown(1);
    doc.fontSize(12).font('Helvetica-Bold').text('Faculty Name:', { continued: true });
    doc.font('Helvetica').text(` ${summary.facultyName || '—'}`);
    doc.font('Helvetica-Bold').text('Department:', { continued: true });
    doc.font('Helvetica').text(` ${summary.facultyDepartment || '—'}`);
    doc.font('Helvetica-Bold').text('Institution:', { continued: true });
    doc.font('Helvetica').text(` ${summary.institution || 'Rajalakshmi Engineering College (Autonomous)'}`);
    doc.moveDown(0.8);
    doc.font('Helvetica-Bold').text('Venue:', { continued: true });
    doc.font('Helvetica').text(` ${summary.venue || '—'}`);
    doc.font('Helvetica-Bold').text('Session Date:', { continued: true });
    const sessionDateStr = summary.dateTime && summary.dateTime.start
      ? new Date(summary.dateTime.start).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })
      : '—';
    doc.font('Helvetica').text(` ${sessionDateStr}`);
    doc.moveDown(0.5);
    doc.font('Helvetica').text(`Date & time: ${summary.dateTime.start} – ${summary.dateTime.end}`);
    if (summary.sessionDuration) doc.text(`Session duration: ${summary.sessionDuration}`);
    doc.text(`Average attention: ${summary.averageAttention}%`);
    if (summary.lowAttentionCount != null) doc.text(`Low-attention moments: ${summary.lowAttentionCount}`);
    if (summary.attendanceTotal != null && summary.attendanceTotal > 0) {
      doc.moveDown(0.5);
      doc.font('Helvetica-Bold').text('Attendance (Hybrid):', { continued: false });
      doc.font('Helvetica').text(`Total: ${summary.attendanceTotal} | Present: ${summary.attendancePresent || 0} | Absent: ${summary.attendanceAbsent || 0} | OD: ${summary.attendanceOD || 0}`, { continued: false });
    }
    if (Array.isArray(summary.studentThresholdRows) && summary.studentThresholdRows.length > 0) {
      const maxRowsForPdf = 15;
      doc.moveDown(0.7);
      doc.font('Helvetica-Bold').text('Individual Student Threshold Signals', { continued: false });
      doc.font('Helvetica').fontSize(10).text('S.No | Register Number | Threshold Value | Status', { continued: false });
      summary.studentThresholdRows.slice(0, maxRowsForPdf).forEach((row) => {
        const thresholdValue = Number(row.thresholdValue || 0).toFixed(2);
        doc.text(`${row.sNo}. ${row.registerNumber} | ${thresholdValue}% | ${row.thresholdLabel}`, { continued: false });
      });
      if (summary.studentThresholdRows.length > maxRowsForPdf) {
        doc.text(`... and ${summary.studentThresholdRows.length - maxRowsForPdf} more rows in SMTP attachment/report export.`);
      }
    }
    doc.moveDown(2);

    // Always show graph and pie: use synthetic 2-point data when history has 0 or 1 point
    const avg = Number(summary.averageAttention) || 0;
    const historyForCharts =
      attentionHistory.length >= 2
        ? attentionHistory
        : attentionHistory.length === 1
          ? [attentionHistory[0], attentionHistory[0]]
          : [{ score: avg }, { score: avg }];
    const scores = historyForCharts.map((p) => p.score);
    const scoreMin = Math.min(0, ...scores);
    const scoreMax = Math.max(100, ...scores);
    const range = scoreMax - scoreMin || 1;

    // ---- Line graph: attention trend (last 60 seconds) ----
    doc.fontSize(14).text('Attention trend (last 60 seconds)');
    doc.moveDown();
    const w = 400;
    const h = 160;
    const left = 50;
    const bottom = doc.y + h;
    doc.rect(left, bottom - h, w, h).stroke();
    let first = true;
    const n = historyForCharts.length;
    for (let i = 0; i < n; i++) {
      const x = left + (w * (i / (n - 1 || 1)));
      const y = bottom - ((historyForCharts[i].score - scoreMin) / range) * h;
      if (first) {
        doc.moveTo(x, y);
        first = false;
      } else {
        doc.lineTo(x, y);
      }
    }
    doc.stroke();
    doc.y = bottom + 20;

    // ---- Pie chart: distribution (aligned with severity: High ≥75%, Medium 45–75%, Low <45%) ----
    const high = scores.filter((s) => s >= 75).length;
    const moderate = scores.filter((s) => s >= 45 && s < 75).length;
    const low = scores.filter((s) => s < 45).length;
    const total = scores.length;
    const segments = [
      { count: high, label: 'High (≥75%)', color: '#2e7d32' },
      { count: moderate, label: 'Medium (45–74%)', color: '#f9a825' },
      { count: low, label: 'Low (<45%)', color: '#c62828' },
    ].filter((seg) => seg.count > 0);

    doc.fontSize(14).text('Attention level distribution');
    doc.moveDown();
    const cx = 200;
    const pieY = doc.y + 90;
    const radius = 75;
    let startAngle = -Math.PI / 2; // start from top (12 o'clock)
    if (segments.length > 0) {
      segments.forEach((seg) => {
        const sliceAngle = (seg.count / total) * 2 * Math.PI;
        const endAngle = startAngle + sliceAngle;
        doc.save();
        doc.fillColor(seg.color);
        doc.moveTo(cx, pieY);
        doc.lineTo(
          cx + radius * Math.cos(startAngle),
          pieY + radius * Math.sin(startAngle)
        );
        doc.arc(cx, pieY, radius, startAngle, endAngle, false);
        doc.closePath();
        doc.fill();
        doc.restore();
        startAngle = endAngle;
      });
    }
    doc.circle(cx, pieY, radius).stroke();
    doc.y = pieY + radius + 12;
    doc.fontSize(10);
    if (segments.length > 0) {
      segments.forEach((seg) => {
        const pct = ((seg.count / total) * 100).toFixed(1);
        doc.fillColor(seg.color);
        doc.text(`${seg.label}: ${pct}% (${seg.count} points)`, { continued: false });
      });
      doc.fillColor('#000000');
    } else {
      doc.text('No attention data points.', { continued: false });
    }
    doc.moveDown(2);

    // ---- Feature 3: AI-generated teaching summary (top 3 suggestions) ----
    const aiSuggestions = summary.aiSuggestions || [];
    if (aiSuggestions.length > 0) {
      doc.fontSize(12).font('Helvetica-Bold').text('AI Teaching Suggestions', { continued: false });
      doc.moveDown(0.3);
      doc.fontSize(10).font('Helvetica');
      aiSuggestions.forEach((s, i) => {
        doc.text(`${i + 1}. ${s}`, { continued: false });
      });
      doc.moveDown(2);
    }

    // ---- Academic sections: Interpretation, Observations, Insights, Conclusions, Recommendations ----
    const sectionFontSize = 10;
    const headingFontSize = 12;
    doc.fontSize(headingFontSize).font('Helvetica-Bold').text('Interpretation', { continued: false });
    doc.moveDown(0.3);
    doc.fontSize(sectionFontSize).font('Helvetica');
    doc.text(
      'The figures in this report are produced by the REC AI Classroom Attention System from anonymised, aggregate engagement data. The average attention value is a session-level summary for the period indicated. The attention trend (where available) shows how this aggregate measure changed over the last 60 seconds of the session. The attention level distribution (high / moderate / low) indicates the proportion of time the session spent in each band. No individual student or device identities are used or disclosed; the report is intended to support reflection on teaching delivery and class-level engagement only.',
      { align: 'justify' }
    );
    doc.moveDown(1);

    doc.fontSize(headingFontSize).font('Helvetica-Bold').text('Observations', { continued: false });
    doc.moveDown(0.3);
    doc.fontSize(sectionFontSize).font('Helvetica');
    doc.text(
      `For this session in Venue ${summary.venue || '—'}, the system recorded anonymised signals and computed a real-time aggregate attention score. Observations include: (i) the overall level of sustained attention as summarised by the average attention percentage; (ii) the stability or variation of engagement over the session, as reflected in the trend and distribution; and (iii) the spread of attention levels (high, moderate, low). Any peaks or dips may align with changes in content, questioning, or activities. The system does not identify or store which devices or persons contributed to these patterns, in line with institutional privacy practice.`,
      { align: 'justify' }
    );
    doc.moveDown(1);

    doc.fontSize(headingFontSize).font('Helvetica-Bold').text('Insights', { continued: false });
    doc.moveDown(0.3);
    doc.fontSize(sectionFontSize).font('Helvetica');
    doc.text(
      'From the reported metrics, the following insights are relevant for the faculty member. The average attention and distribution indicate whether the class, in aggregate, was predominantly in a high, moderate, or low engagement band. A stable or rising trend in the final segment suggests that the closing part of the session maintained engagement; a declining or variable trend may suggest value in varying pedagogy (e.g. short polls, recap, or a concrete example) in similar sessions. These insights are for reflective practice and planning of future classes at REC and do not infer or reveal individual student behaviour.',
      { align: 'justify' }
    );
    doc.moveDown(1);

    doc.fontSize(headingFontSize).font('Helvetica-Bold').text('Conclusions', { continued: false });
    doc.moveDown(0.3);
    doc.fontSize(sectionFontSize).font('Helvetica');
    doc.text(
      `Based on the session data and the interpretation above, the following conclusions are drawn. The AI Classroom Attention Report provides a summary view of aggregate class engagement for the stated topic (${summary.topic || '—'}), venue (${summary.venue || '—'}), and date/time. The metrics are consistent with an anonymised, privacy-preserving approach to classroom analytics. The report is suitable for faculty documentation and for informing teaching strategies in subsequent sessions. No conclusions are drawn about individual students or devices; the system supports institutional and faculty-level reflection only.`,
      { align: 'justify' }
    );
    doc.moveDown(1);

    doc.fontSize(headingFontSize).font('Helvetica-Bold').text('Recommendations', { continued: false });
    doc.moveDown(0.3);
    doc.fontSize(sectionFontSize).font('Helvetica');
    doc.text(
      'For the faculty member using this report, the following recommendations are offered. (1) Use the trend and distribution to identify segments where engagement may have dipped and consider reinforcing those points in future sessions (e.g. recap, examples, or brief activities). (2) Align future pacing and content mix with whether the session was mostly high, mixed, or low engagement. (3) When metrics suggest lower engagement, consider the teaching prompts or strategies suggested by the REC SmartAssist or dashboard. (4) Retain reports for your own records and for evidence of reflective practice, in line with institutional data and privacy policy. (5) Do not use these metrics for grading or for identifying individual students; the system is intended only for aggregate, anonymised reflection on class-level attention.',
      { align: 'justify' }
    );
    doc.moveDown(2);

    // ---- Section 2: Verified By ----
    doc.fontSize(headingFontSize).font('Helvetica-Bold').text('Verified By', { continued: false });
    doc.moveDown(0.5);
    doc.fontSize(sectionFontSize).font('Helvetica');
    doc.text(`Faculty Name: ${summary.facultyName || '—'}`, { continued: false });
    doc.text(`Designation: ${summary.facultyDesignation || '—'}`, { continued: false });
    doc.text(`Institution: ${summary.institution || 'Rajalakshmi Engineering College'}`, { continued: false });
    const verificationTimestamp = summary.reportGeneratedAt
      ? new Date(summary.reportGeneratedAt).toLocaleString('en-IN', { dateStyle: 'long', timeStyle: 'short' })
      : new Date().toLocaleString('en-IN', { dateStyle: 'long', timeStyle: 'short' });
    doc.text(`Verification Timestamp: ${verificationTimestamp}`, { continued: false });
    doc.moveDown(1);

    // ---- Section 3: Faculty signature placeholder ----
    doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
    doc.moveDown(0.6);
    doc.fontSize(11).font('Helvetica-Bold').text('Faculty Signature', { continued: false });
    doc.moveDown(0.3);
    doc.fontSize(sectionFontSize).font('Helvetica');
    doc.text(summary.facultyName || '—', { continued: false });
    doc.text(summary.facultyDesignation ? summary.facultyDesignation : '—', { continued: false });
    doc.text(summary.institution || 'Rajalakshmi Engineering College', { continued: false });
    doc.moveDown(1);

    // ---- Section 7: Digital Signature (hash + RSA-2048 SHA256) ----
    doc.fontSize(headingFontSize).font('Helvetica-Bold').text('Digital Signature', { continued: false });
    doc.moveDown(0.4);
    doc.fontSize(sectionFontSize).font('Helvetica');
    const hashDisplay = (summary.reportHash || '').slice(0, 48) + (summary.reportHash && summary.reportHash.length > 48 ? '...' : '');
    doc.text('Signature Hash:', { continued: false });
    doc.font('Helvetica').text(hashDisplay, { continued: false });
    doc.text('Signature Algorithm: RSA-2048 SHA256', { continued: false });
    doc.text('Signed By: AI Classroom Attention System', { continued: false });
    doc.text('Institution: Rajalakshmi Engineering College', { continued: false });
    if (summary.reportId && summary.reportVerifyBaseUrl) {
      doc.moveDown(0.4);
      doc.fontSize(9).text(`To verify this report: ${summary.reportVerifyBaseUrl}/api/verify-report?reportId=${encodeURIComponent(summary.reportId)}`, { continued: false });
      if (qrBuffer) {
        doc.moveDown(0.5);
        doc.fontSize(9).text('Scan QR code to verify:', { continued: false });
        const qrY = doc.y + 4;
        doc.image(qrBuffer, 50, qrY, { width: 80, height: 80 });
        doc.y = qrY + 84;
        doc.moveDown(0.4);
      }
    }
    doc.moveDown(1);

    // ---- Section 10: PDF Footer ----
    doc.fontSize(10).font('Helvetica').text('Generated by', { align: 'center' });
    doc.text('AI Classroom Attention System', { align: 'center' });
    doc.text('Rajalakshmi Engineering College', { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(9).text('Anonymized data only.', { align: 'center' });
    doc.end();
  });
}

function computeStudentTopAndBottomLast60s(sessionObj, nowMs) {
  const out = { top5: [], bottom5: [] };
  if (!sessionObj || !sessionObj.studentAttentionHistory || typeof sessionObj.studentAttentionHistory !== 'object') {
    return out;
  }
  const now = Number(nowMs) || Date.now();
  const fromMs = now - 60 * 1000;
  const rows = [];
  Object.entries(sessionObj.studentAttentionHistory).forEach(([registerNumber, series]) => {
    if (!Array.isArray(series) || !series.length) return;
    const recent = series.filter((p) => p && p.t && new Date(p.t).getTime() >= fromMs);
    if (!recent.length) return;
    const avg = recent.reduce((acc, p) => acc + Number(p.score || 0), 0) / recent.length;
    const last = recent[recent.length - 1] || null;
    rows.push({
      registerNumber: String(registerNumber || '').trim(),
      averageAttention: Number(avg.toFixed(2)),
      sampleCount: recent.length,
      sourceType: last && last.sourceType ? String(last.sourceType) : 'live_camera',
    });
  });
  rows.sort((a, b) => b.averageAttention - a.averageAttention);
  out.top5 = rows.slice(0, 5);
  out.bottom5 = [...rows].sort((a, b) => a.averageAttention - b.averageAttention).slice(0, 5);
  return out;
}

async function buildStudentRankingPdfBuffer(summary, ranking) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Header logo and institution title
    const logoDir = PUBLIC_DIR;
    const logoJpg = path.join(logoDir, 'rec-logo.jpg');
    const logoPng = path.join(logoDir, 'rec-logo.png');
    const logoPath = fs.existsSync(logoJpg) ? logoJpg : fs.existsSync(logoPng) ? logoPng : null;
    if (logoPath) {
      try {
        const logoW = 84;
        const startY = doc.y;
        doc.image(
          logoPath,
          (doc.page.width - doc.page.margins.left - doc.page.margins.right) / 2 - logoW / 2 + doc.page.margins.left,
          startY,
          { width: logoW },
        );
        doc.y = startY + logoW + 4;
      } catch (_) {}
    }
    doc.fontSize(14).font('Helvetica-Bold').text('Rajalakshmi Engineering College ( An Autonmous Institution)', { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(16).font('Helvetica-Bold').text('Student Attention Ranking (Last 60 Seconds)', { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(11).font('Helvetica');
    doc.text(`Topic: ${summary.topic || '—'}`);
    doc.text(`Venue: ${summary.venue || '—'}`);
    doc.text(`Session: ${summary.dateTime && summary.dateTime.start ? summary.dateTime.start : '—'} to ${summary.dateTime && summary.dateTime.end ? summary.dateTime.end : '—'}`);
    doc.text(`Generated at: ${new Date().toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'medium' })}`);
    doc.moveDown(1);

    function drawSection(title, list) {
      doc.fontSize(13).font('Helvetica-Bold').text(title);
      doc.moveDown(0.3);
      doc.fontSize(10).font('Helvetica-Bold');
      doc.text('Register Number', 55, doc.y, { continued: true, width: 160 });
      doc.text('Average %', { continued: true, width: 90 });
      doc.text('Samples', { continued: true, width: 80 });
      doc.text('Source');
      doc.moveDown(0.2);
      doc.font('Helvetica');
      if (!list || !list.length) {
        doc.text('No student score data available in the last 60 seconds.');
        doc.moveDown(0.8);
        return;
      }
      list.forEach((r) => {
        const sourceLabel = r.sourceType === 'uploaded_video' ? 'uploaded video' : 'live camera';
        doc.text(r.registerNumber || '—', 55, doc.y, { continued: true, width: 160 });
        doc.text(`${Number(r.averageAttention || 0).toFixed(2)}%`, { continued: true, width: 90 });
        doc.text(String(r.sampleCount || 0), { continued: true, width: 80 });
        doc.text(sourceLabel);
      });
      doc.moveDown(0.8);
    }

    drawSection('Top 5 Students', ranking && ranking.top5 ? ranking.top5 : []);
    drawSection('Bottom 5 Students', ranking && ranking.bottom5 ? ranking.bottom5 : []);
    doc.moveDown(0.8);
    doc.fontSize(9).fillColor('#4b5563').text(
      'Note: Rankings are computed from attention points received in the last 60 seconds of this session. Source indicates whether points came from live camera or uploaded video analysis.',
      { align: 'left' },
    );
    doc.moveDown(1);
    doc.fillColor('#000000');
    doc.fontSize(12).font('Helvetica-Bold').text('Digital Signature', { continued: false });
    doc.moveDown(0.3);
    doc.fontSize(10).font('Helvetica');
    const rankHash = summary && summary.reportHash ? String(summary.reportHash) : '';
    const rankHashDisplay = rankHash.slice(0, 48) + (rankHash.length > 48 ? '...' : '');
    doc.text(`Signature Hash: ${rankHashDisplay || 'Not available'}`);
    doc.text(`Signature Algorithm: RSA-2048 SHA256`);
    doc.text(`Signed By: AI Classroom Attention System`);
    if (summary && summary.reportId) {
      doc.text(`Report ID: ${summary.reportId}`);
    }

    doc.end();
  });
}

function buildQuizAndPollRows(sessionObj) {
  const items = Array.isArray(sessionObj && sessionObj.classroomActivities) ? sessionObj.classroomActivities : [];
  const quizRows = [];
  const pollRows = [];
  items.forEach((activity) => {
    if (!activity || typeof activity !== 'object') return;
    const type = String(activity.type || '').toLowerCase();
    if (type !== 'quiz' && type !== 'poll') return;
    const options = Array.isArray(activity.options) ? activity.options : [];
    const optionCounts = Array.isArray(activity.optionCounts) ? activity.optionCounts : [];
    const responsesByRegister = activity.responsesByRegister && typeof activity.responsesByRegister === 'object'
      ? activity.responsesByRegister
      : {};
    const totalResponses = Object.keys(responsesByRegister).length;
    options.forEach((opt, idx) => {
      const row = {
        activityId: String(activity.id || ''),
        createdAt: String(activity.createdAt || ''),
        question: String(activity.question || ''),
        optionLabel: String(opt || ''),
        responses: Number(optionCounts[idx] || 0),
        totalResponses,
      };
      if (type === 'quiz') quizRows.push(row);
      else pollRows.push(row);
    });
  });
  return { quizRows, pollRows };
}

async function buildQuizPollResultsExcelBuffer(summary, quizRows, pollRows) {
  if (!ExcelJS) throw new Error('ExcelJS is not installed.');
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'REC AI Classroom Attention System';
  workbook.created = new Date();

  // Prefer PNG for better Excel rendering compatibility across viewers.
  const logoCandidates = [
    path.join(PUBLIC_DIR, 'rec-logo.png'),
    path.join(PUBLIC_DIR, 'rec-logo.jpg'),
    path.join(__dirname, 'public', 'rec-logo.png'),
    path.join(__dirname, 'public', 'rec-logo.jpg'),
  ];
  const logoPath = logoCandidates.find((p) => fs.existsSync(p)) || null;
  let logoImageId = null;
  if (logoPath) {
    try {
      logoImageId = workbook.addImage({
        buffer: fs.readFileSync(logoPath),
        extension: path.extname(logoPath).toLowerCase() === '.png' ? 'png' : 'jpeg',
      });
    } catch (_) {
      logoImageId = null;
    }
  }

  function fillSheet(worksheet, title, rows) {
    worksheet.columns = [
      { header: 'S No', key: 'sno', width: 8 },
      { header: 'Date & Time', key: 'createdAt', width: 24 },
      { header: 'Question', key: 'question', width: 42 },
      { header: 'Option', key: 'optionLabel', width: 30 },
      { header: 'Responses', key: 'responses', width: 12 },
      { header: 'Total Responses', key: 'totalResponses', width: 16 },
      { header: 'Activity ID', key: 'activityId', width: 24 },
    ];
    worksheet.mergeCells('B1:G1');
    worksheet.getCell('B1').value = 'Rajalakshmi Engineering College ( An Autonomous Institution)';
    worksheet.getCell('B1').font = { bold: true, size: 14 };
    worksheet.getCell('B1').alignment = { horizontal: 'center', vertical: 'middle' };
    worksheet.getRow(1).height = 36;
    worksheet.getRow(2).height = 26;
    if (logoImageId) {
      // Dual anchors improve compatibility across different Excel viewers.
      worksheet.addImage(logoImageId, { tl: { col: 0, row: 0 }, ext: { width: 96, height: 96 } });
      worksheet.addImage(logoImageId, { tl: { col: 1.02, row: 1.02 }, ext: { width: 64, height: 64 } });
    }

    worksheet.mergeCells('A3:G3');
    worksheet.getCell('A3').value = title;
    worksheet.getCell('A3').font = { bold: true, size: 12 };
    worksheet.getCell('A3').alignment = { horizontal: 'center' };

    worksheet.mergeCells('A4:G4');
    worksheet.getCell('A4').value = `Topic: ${summary.topic || '—'} | Venue: ${summary.venue || '—'}`;
    worksheet.getCell('A4').alignment = { horizontal: 'center' };

    const headerRow = worksheet.getRow(6);
    headerRow.values = worksheet.columns.map((c) => c.header);
    headerRow.eachCell((cell) => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
    });

    if (!rows.length) {
      worksheet.mergeCells('A7:G7');
      worksheet.getCell('A7').value = `No ${title.toLowerCase()} available for this session.`;
      worksheet.getCell('A7').alignment = { horizontal: 'center' };
    } else {
      rows.forEach((row, i) => {
        const line = worksheet.addRow({
          sno: i + 1,
          createdAt: row.createdAt ? new Date(row.createdAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—',
          question: row.question || '—',
          optionLabel: row.optionLabel || '—',
          responses: Number(row.responses || 0),
          totalResponses: Number(row.totalResponses || 0),
          activityId: row.activityId || '—',
        });
        line.eachCell((cell) => {
          cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
          cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
        });
      });
    }
  }

  fillSheet(workbook.addWorksheet('Quiz Results'), 'Quiz Results', Array.isArray(quizRows) ? quizRows : []);
  fillSheet(workbook.addWorksheet('Poll Results'), 'Poll Results', Array.isArray(pollRows) ? pollRows : []);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function buildQuizPollResultsPdfBuffer(summary, quizRows, pollRows) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 45 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const logoJpg = path.join(PUBLIC_DIR, 'rec-logo.jpg');
    const logoPng = path.join(PUBLIC_DIR, 'rec-logo.png');
    const logoPath = fs.existsSync(logoJpg) ? logoJpg : (fs.existsSync(logoPng) ? logoPng : null);
    if (logoPath) {
      try {
        doc.image(logoPath, doc.page.margins.left, doc.y, { width: 68 });
      } catch (_) {}
    }
    doc.fontSize(14).font('Helvetica-Bold').text('Rajalakshmi Engineering College ( An Autonomous Institution)', 120, 52);
    doc.moveDown(1.2);
    doc.fontSize(15).font('Helvetica-Bold').text('Quiz & Poll Results Report', { align: 'center' });
    doc.moveDown(0.4);
    doc.fontSize(10).font('Helvetica').text(`Topic: ${summary.topic || '—'}`);
    doc.text(`Venue: ${summary.venue || '—'}`);
    doc.text(`Generated at: ${new Date().toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'medium' })}`);
    doc.moveDown(0.8);

    function drawRows(sectionTitle, rows) {
      doc.fontSize(12).font('Helvetica-Bold').text(sectionTitle);
      doc.moveDown(0.3);
      if (!rows.length) {
        doc.fontSize(10).font('Helvetica').text(`No ${sectionTitle.toLowerCase()} available for this session.`);
        doc.moveDown(0.6);
        return;
      }
      rows.forEach((row, idx) => {
        const createdAt = row.createdAt ? new Date(row.createdAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
        doc.fontSize(10).font('Helvetica-Bold').text(`${idx + 1}. ${row.question || '—'}`);
        doc.fontSize(10).font('Helvetica').text(`Option: ${row.optionLabel || '—'} | Responses: ${Number(row.responses || 0)} / ${Number(row.totalResponses || 0)}`);
        doc.text(`Date: ${createdAt} | Activity ID: ${row.activityId || '—'}`);
        doc.moveDown(0.3);
      });
      doc.moveDown(0.3);
    }

    drawRows('Quiz Results', Array.isArray(quizRows) ? quizRows : []);
    drawRows('Poll Results', Array.isArray(pollRows) ? pollRows : []);
    doc.end();
  });
}

// Close session and generate summary + PDF report + email to faculty
app.post('/api/session/end', ensureAuthenticated, async (req, res) => {
  const { sessionId } = req.body;
  const s = sessions[sessionId];
  if (!s || s.ownerEmail !== req.session.userEmail) {
    return res.status(404).json({ ok: false, message: 'Session not found.' });
  }
  if (s.closed) {
    return res.json({ ok: true, summary: s.summary || null });
  }

  s.closed = true;

  if (String(lastActiveSessionId) === String(sessionId)) {
    const ownerEmail = String(s.ownerEmail || '').trim().toLowerCase();
    const remaining = Object.values(sessions).find(
      (x) => x && !x.closed && String(x.ownerEmail || '').trim().toLowerCase() === ownerEmail,
    );
    if (remaining) {
      lastActiveSessionId = remaining.id;
      globalSessionActive = true;
      io.emit('active-session', { sessionId: remaining.id });
      emitSessionScoped('active-session', remaining.id, { sessionId: remaining.id });
    } else {
      lastActiveSessionId = null;
      globalSessionActive = false;
      io.emit('active-session', { sessionId: null });
    }
  }

  // Broadcast session ended so student dashboard can enable voice assistant again.
  emitSessionScoped('session-status', sessionId, { status: 'ended', sessionId });
  persistSessionToMongo(s);

  const history = s.attentionHistory;
  const avgAttention =
    history.length > 0
      ? history.reduce((acc, v) => acc + v.score, 0) / history.length
      : 0;

  // Best engagement period: highest 10-point window
  let bestWindowStart = null;
  let bestWindowAvg = 0;
  const windowSize = 10;
  for (let i = 0; i + windowSize <= history.length; i++) {
    const window = history.slice(i, i + windowSize);
    const wAvg = window.reduce((acc, v) => acc + v.score, 0) / window.length;
    if (wAvg > bestWindowAvg) {
      bestWindowAvg = wAvg;
      bestWindowStart = window[0].t;
    }
  }

  const attentionDropTimings = s.alerts.map((a) => a.t);

  // Count of low-attention moments (data points below 45%)
  const lowAttentionCount = history.filter((p) => Number(p.score) < 45).length;

  // Session duration (human-readable)
  const startMs = new Date(s.startTime).getTime();
  const endMs = Date.now();
  const durationMin = Math.round((endMs - startMs) / 60000);
  const sessionDuration = durationMin < 60 ? `${durationMin} minutes` : `${Math.floor(durationMin / 60)}h ${durationMin % 60}m`;

  // AI suggestions: use stored from live detection, or generate from full history for PDF
  const dropForPdf = detectSustainedAttentionDrop(history);
  const aiSuggestions = (s.aiSuggestions && s.aiSuggestions.length > 0) ? s.aiSuggestions : dropForPdf.suggestions;

  const owner = users[s.ownerEmail] || {};
  const facultyName = owner.name ? owner.name : s.ownerEmail;
  const facultyDepartment = owner.department ? owner.department : '';
  const facultyDesignation = owner.designation ? owner.designation : '';
  const institution = 'Rajalakshmi Engineering College (Autonomous)';
  const reportGeneratedAt = new Date().toISOString();

  // Final attendance report (hybrid: hand + face + attention)
  const attRows = Object.values(attendanceRecords).filter((r) => r.sessionId === s.id);
  const attendancePresent = attRows.filter((r) => r.status === 'Present').length;
  const attendanceAbsent = attRows.filter((r) => r.status === 'Absent').length;
  const attendanceOD = attRows.filter((r) => r.status === 'OD').length;
  const attendanceTotal = attRows.length;

  const summary = {
    topic: s.topic,
    venue: s.venue,
    dateTime: { start: s.startTime, end: s.endTime },
    averageAttention: Number(avgAttention.toFixed(2)),
    attentionDropTimings,
    bestEngagementStart: bestWindowStart,
    bestEngagementAverage: Number(bestWindowAvg.toFixed(2)),
    lowAttentionCount,
    sessionDuration,
    facultyName,
    facultyDepartment,
    facultyDesignation,
    institution,
    reportGeneratedAt,
    aiSuggestions,
    attendanceTotal,
    attendancePresent,
    attendanceAbsent,
    attendanceOD,
  };

  // Report authenticity: canonical payload → SHA256 hash → RSA sign (RSA-2048 SHA256)
  const reportId = `R${s.id}-${Date.now()}`;
  summary.reportId = reportId;
  const canonicalPayload = JSON.stringify({
    reportId,
    sessionId: s.id,
    topic: summary.topic,
    venue: summary.venue,
    dateTime: summary.dateTime,
    averageAttention: summary.averageAttention,
    lowAttentionCount: summary.lowAttentionCount,
    reportGeneratedAt: summary.reportGeneratedAt,
  });
  summary.reportHash = security.hashData(canonicalPayload);
  summary.reportSignature = security.signData(summary.reportHash);

  // Base URL for verification link and QR code. Prefer PUBLIC_BASE_URL so links work from other devices.
  if (process.env.BASE_URL) {
    summary.reportVerifyBaseUrl = process.env.BASE_URL.replace(/\/$/, '');
  } else {
    const pub = normalizeEmailBaseUrl(process.env.PUBLIC_BASE_URL) || normalizeEmailBaseUrl(process.env.SERVER_URL);
    if (pub) {
      summary.reportVerifyBaseUrl = pub;
    } else {
      const host = (req.get && req.get('host')) || '';
      const isLocalhost = !host || host.startsWith('localhost') || host.startsWith('127.0.0.1');
      if (isLocalhost) {
        const lanIP = getLocalIP();
        summary.reportVerifyBaseUrl = lanIP ? `http://${lanIP}:${PORT}` : `http://localhost:${PORT}`;
      } else {
        summary.reportVerifyBaseUrl = `${req.protocol || 'http'}://${host}`;
      }
    }
  }

  s.summary = summary;

  // Build PDF with summary and attention trend graph, then email to faculty
  const historyForChart = s.attentionHistory.slice(-120); // last ~60s at 2s interval
  let pdfBuffer = null;
  try {
    pdfBuffer = await buildSessionPdfBuffer(summary, historyForChart.length ? historyForChart : []);
  } catch (err) {
    console.error('Error building PDF', err);
  }
  const ranking = computeStudentTopAndBottomLast60s(s, Date.now());
  summary.studentTop5Last60s = ranking.top5;
  summary.studentBottom5Last60s = ranking.bottom5;
  const studentScoreRowsForSummary = computeStudentScoreRowsLast60(s, Date.now());
  const studentThresholdRows = buildStudentThresholdRows(studentScoreRowsForSummary);
  summary.studentThresholdRows = studentThresholdRows;
  let rankingPdfBuffer = null;
  try {
    rankingPdfBuffer = await buildStudentRankingPdfBuffer(summary, ranking);
  } catch (err) {
    console.error('Error building student ranking PDF', err);
  }
  const { quizRows, pollRows } = buildQuizAndPollRows(s);
  let quizPollPdfBuffer = null;
  let quizPollExcelBuffer = null;
  try {
    quizPollPdfBuffer = await buildQuizPollResultsPdfBuffer(summary, quizRows, pollRows);
  } catch (err) {
    console.error('Error building quiz/poll PDF', err);
  }
  try {
    quizPollExcelBuffer = await buildQuizPollResultsExcelBuffer(summary, quizRows, pollRows);
  } catch (err) {
    console.error('Error building quiz/poll Excel', err);
  }

  // Limit the number of attention drop timings listed directly in the email body
  const dropTimingsList = Array.isArray(summary.attentionDropTimings) ? summary.attentionDropTimings : [];
  const MAX_DROP_TIMINGS_IN_EMAIL = 5;
  let attentionDropLine = 'None detected';
  if (dropTimingsList.length > 0) {
    const shown = dropTimingsList.slice(0, MAX_DROP_TIMINGS_IN_EMAIL);
    const remaining = dropTimingsList.length - shown.length;
    attentionDropLine = shown.join(', ');
    if (remaining > 0) {
      attentionDropLine += ` (and ${remaining} more period${remaining > 1 ? 's' : ''} of low attention)`;
    }
  }

  const emailText = [
    'Dear Faculty,',
    '',
    `Topic: ${summary.topic}`,
    `Venue: ${summary.venue}`,
    `Start time: ${summary.dateTime.start}`,
    `End time: ${summary.dateTime.end}`,
    `Average attention level: ${summary.averageAttention}`,
    `Attention drop timings: ${attentionDropLine}`,
    `Best engagement period start: ${summary.bestEngagementStart || 'Not available'}`,
    `Best engagement average: ${summary.bestEngagementAverage}`,
    '',
    'Individual threshold values (last 60s):',
    'S.No | Register Number | Threshold Value | Status | Message',
    ...(studentThresholdRows.length
      ? studentThresholdRows.map((row) => `${row.sNo} | ${row.registerNumber} | ${Number(row.thresholdValue || 0).toFixed(2)}% | ${row.thresholdLabel} | ${row.thresholdMessage}`)
      : ['No student threshold values available for this session.']),
    pdfBuffer ? '\nPlease see the attached PDF for the full report and trend graph.' : '',
    rankingPdfBuffer ? 'The Top 5 and Bottom 5 student attention report (last 60 seconds) is attached as a separate PDF.' : '',
    quizPollPdfBuffer ? 'Quiz and poll results PDF is attached.' : '',
    quizPollExcelBuffer ? 'Quiz and poll results Excel file (with separate Quiz/Poll sheets) is attached.' : '',
  ].join('\n');

  let emailSent = false;
  let emailError = null;
  try {
    if (smtpConfigured) {
      const mailOptions = {
        from: process.env.FROM_EMAIL || process.env.SMTP_USER,
        to: s.ownerEmail,
        subject: `Classroom Attention Report - ${summary.topic}`,
        text: emailText,
      };
      if (pdfBuffer) {
        mailOptions.attachments = [];
        mailOptions.attachments.push({ filename: `attention-report-${summary.topic.replace(/\s+/g, '-')}.pdf`, content: pdfBuffer });
      }
      if (rankingPdfBuffer) {
        if (!mailOptions.attachments) mailOptions.attachments = [];
        mailOptions.attachments.push({
          filename: `student-ranking-last60s-${summary.topic.replace(/\s+/g, '-')}.pdf`,
          content: rankingPdfBuffer,
        });
      }
      if (quizPollPdfBuffer) {
        if (!mailOptions.attachments) mailOptions.attachments = [];
        mailOptions.attachments.push({
          filename: `quiz-poll-results-${summary.topic.replace(/\s+/g, '-')}.pdf`,
          content: quizPollPdfBuffer,
        });
      }
      if (quizPollExcelBuffer) {
        if (!mailOptions.attachments) mailOptions.attachments = [];
        mailOptions.attachments.push({
          filename: `quiz-poll-results-${summary.topic.replace(/\s+/g, '-')}.xlsx`,
          content: quizPollExcelBuffer,
        });
      }
      const thresholdCsv = buildStudentThresholdCsv(studentThresholdRows);
      if (thresholdCsv) {
        if (!mailOptions.attachments) mailOptions.attachments = [];
        mailOptions.attachments.push({
          filename: `student-threshold-values-last60s-${summary.topic.replace(/\s+/g, '-')}.csv`,
          content: Buffer.from(thresholdCsv, 'utf8'),
        });
      }
      await transporter.sendMail(mailOptions);
      emailSent = true;
      console.log('Session report email sent to', s.ownerEmail);
    } else {
      console.log('Email skipped: SMTP not configured. Set SMTP_USER and SMTP_PASS (and optionally SMTP_HOST, SMTP_PORT) in environment.');
      emailError = 'SMTP not configured';
    }
  } catch (err) {
    console.error('Error sending email summary', err);
    emailError = err.message || 'Email send failed';
  }

  return res.json({ ok: true, summary, emailSent, emailError });
});

// Get history of all sessions for this faculty
app.get('/api/session/history', ensureAuthenticated, (req, res) => {
  const email = req.session.userEmail;
  const list = Object.values(sessions)
    .filter((s) => s.ownerEmail === email)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map((s) => ({
      id: s.id,
      topic: s.topic,
      venue: s.venue,
      startTime: s.startTime,
      endTime: s.endTime,
      closed: s.closed,
      averageAttention: s.summary ? s.summary.averageAttention : null,
    }));

  res.json({ ok: true, sessions: list });
});

// Download PDF report for a closed session (for future reference from faculty dashboard)
app.get('/api/session/:id/report', ensureAuthenticated, async (req, res) => {
  const sessionId = req.params.id;
  const s = sessions[sessionId];
  if (!s || s.ownerEmail !== req.session.userEmail) {
    return res.status(404).json({ ok: false, message: 'Session not found.' });
  }
  if (!s.closed || !s.summary) {
    return res.status(400).json({ ok: false, message: 'Report available only for ended sessions.' });
  }
  try {
    const historyForChart = (s.attentionHistory || []).slice(-120);
    const pdfBuffer = await buildSessionPdfBuffer(s.summary, historyForChart.length ? historyForChart : []);
    const filename = `attention-report-${(s.topic || 'session').replace(/\s+/g, '-')}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
    res.send(pdfBuffer);
  } catch (err) {
    console.error('Error generating session report PDF', err);
    res.status(500).json({ ok: false, message: 'Failed to generate report.' });
  }
});

// Download sleep detection report PDF for a session.
app.get('/api/session/:id/sleep-detection-report', ensureAuthenticated, async (req, res) => {
  const sessionId = req.params.id;
  const s = sessions[sessionId];
  if (!s || s.ownerEmail !== req.session.userEmail) {
    return res.status(404).json({ ok: false, message: 'Session not found.' });
  }
  const rows = buildSleepReportRows(s);
  const summary = {
    sessionId,
    topic: String(s.topic || ''),
    venue: String(s.venue || ''),
    generatedAt: new Date().toISOString(),
  };
  try {
    const pdfBuffer = await buildSleepDetectionPdfBuffer(summary, rows);
    const filename = `sleep-detection-report-${(s.topic || sessionId).replace(/\s+/g, '-')}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(pdfBuffer);
  } catch (err) {
    console.error('Error generating sleep detection report PDF', err);
    return res.status(500).json({ ok: false, message: 'Failed to generate sleep detection report.' });
  }
});

// Download student ranking PDF (Top 5 and Bottom 5 in last 60 seconds) for a closed session.
app.get('/api/session/:id/student-ranking-report', ensureAuthenticated, async (req, res) => {
  const sessionId = req.params.id;
  const s = sessions[sessionId];
  if (!s || s.ownerEmail !== req.session.userEmail) {
    return res.status(404).json({ ok: false, message: 'Session not found.' });
  }
  if (!s.closed || !s.summary) {
    return res.status(400).json({ ok: false, message: 'Session report is available after session end.' });
  }
  try {
    const ranking = computeStudentTopAndBottomLast60s(s, Date.now());
    const pdfBuffer = await buildStudentRankingPdfBuffer(s.summary, ranking);
    const filename = `student-ranking-last60s-${(s.topic || 'session').replace(/\s+/g, '-')}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error('Error generating student ranking PDF', err);
    res.status(500).json({ ok: false, message: 'Failed to generate student ranking report.' });
  }
});

// Download quiz/poll results PDF for a closed session.
app.get('/api/session/:id/quiz-poll-report', ensureAuthenticated, async (req, res) => {
  const sessionId = req.params.id;
  const s = sessions[sessionId];
  if (!s || s.ownerEmail !== req.session.userEmail) {
    return res.status(404).json({ ok: false, message: 'Session not found.' });
  }
  if (!s.closed || !s.summary) {
    return res.status(400).json({ ok: false, message: 'Session report is available after session end.' });
  }
  try {
    const { quizRows, pollRows } = buildQuizAndPollRows(s);
    const pdfBuffer = await buildQuizPollResultsPdfBuffer(s.summary, quizRows, pollRows);
    const filename = `quiz-poll-results-${(s.topic || 'session').replace(/\s+/g, '-')}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error('Error generating quiz/poll results PDF', err);
    res.status(500).json({ ok: false, message: 'Failed to generate quiz/poll report.' });
  }
});

// Download quiz/poll results Excel (.xlsx) for a closed session.
app.get('/api/session/:id/quiz-poll-report-excel', ensureAuthenticated, async (req, res) => {
  const sessionId = req.params.id;
  const s = sessions[sessionId];
  if (!s || s.ownerEmail !== req.session.userEmail) {
    return res.status(404).json({ ok: false, message: 'Session not found.' });
  }
  if (!s.closed || !s.summary) {
    return res.status(400).json({ ok: false, message: 'Session report is available after session end.' });
  }
  try {
    const { quizRows, pollRows } = buildQuizAndPollRows(s);
    const excelBuffer = await buildQuizPollResultsExcelBuffer(s.summary, quizRows, pollRows);
    const filename = `quiz-poll-results-${(s.topic || 'session').replace(/\s+/g, '-')}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(excelBuffer);
  } catch (err) {
    console.error('Error generating quiz/poll results Excel', err);
    res.status(500).json({ ok: false, message: 'Failed to generate quiz/poll Excel report.' });
  }
});

// ---- Section 8: Verify report digital signature (public, for QR/link verification) ----
// GET /api/verify-report?reportId=xxx — recomputes hash from summary and verifies RSA signature.
app.get('/api/verify-report', (req, res) => {
  const reportId = req.query.reportId;
  if (!reportId) {
    return res.status(400).json({ ok: false, valid: false, message: 'Missing reportId.' });
  }
  const s = Object.values(sessions).find((sess) => sess.summary && sess.summary.reportId === reportId);
  if (!s || !s.summary) {
    return res.status(404).json({ ok: false, valid: false, message: 'Report not found. It may have expired from server memory.' });
  }
  const sum = s.summary;
  const canonicalPayload = JSON.stringify({
    reportId: sum.reportId,
    sessionId: s.id,
    topic: sum.topic,
    venue: sum.venue,
    dateTime: sum.dateTime,
    averageAttention: sum.averageAttention,
    lowAttentionCount: sum.lowAttentionCount,
    reportGeneratedAt: sum.reportGeneratedAt,
  });
  const hash = security.hashData(canonicalPayload);
  const valid = !!sum.reportSignature && security.verifySignature(hash, sum.reportSignature);
  const payload = {
    ok: true,
    valid,
    message: valid ? 'Report signature is valid. This report has not been tampered.' : 'Report signature verification failed. The report may have been tampered.',
    reportId: sum.reportId,
    topic: sum.topic,
    venue: sum.venue,
  };
  const wantsHtml = String(req.query.format || '').trim().toLowerCase() === 'html'
    || (String(req.query.format || '').trim().toLowerCase() !== 'json'
      && String(req.headers.accept || '').toLowerCase().includes('text/html'));
  if (wantsHtml) {
    const statusText = payload.valid ? 'VALID' : 'INVALID';
    const statusColor = payload.valid ? '#15803d' : '#b91c1c';
    const statusBg = payload.valid ? '#dcfce7' : '#fee2e2';
    const safeMessage = escapeHtml(payload.message || '');
    const safeId = escapeHtml(String(payload.reportId || '—'));
    const safeTopic = escapeHtml(String(payload.topic || '—'));
    const safeVenue = escapeHtml(String(payload.venue || '—'));
    const checkedAt = new Date().toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'medium' });
    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>REC Report Verification</title>
  <style>
    body{margin:0;background:#f6f8ff;font-family:Segoe UI,Arial,sans-serif;color:#1f2937}
    .wrap{max-width:860px;margin:26px auto;padding:0 14px}
    .card{background:#fff;border:1px solid #dbe3ff;border-radius:14px;box-shadow:0 16px 34px rgba(20,15,51,.12);padding:18px}
    .head{display:flex;gap:12px;align-items:center}
    .logo{width:64px;height:64px;border-radius:10px;object-fit:contain;background:#fff;border:1px solid #e5e7eb}
    .college{font-size:22px;font-weight:800;color:#1f2a78;line-height:1.2}
    .sub{font-size:13px;color:#6b7280;margin-top:4px}
    .badge{display:inline-block;margin-top:14px;padding:6px 12px;border-radius:999px;font-size:12px;font-weight:700}
    .msg{margin-top:12px;font-size:15px}
    .grid{margin-top:14px;display:grid;grid-template-columns:170px 1fr;gap:8px 12px}
    .k{font-weight:700;color:#374151}
    .v{color:#111827}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="head">
        <img class="logo" src="/rec-logo.jpg" alt="REC logo" />
        <div>
          <div class="college">Rajalakshmi Engineering College ( An Autonomous Institution)</div>
          <div class="sub">AI Classroom Attention Report Verification</div>
        </div>
      </div>
      <span class="badge" style="color:${statusColor};background:${statusBg};border:1px solid ${statusColor}33;">Signature ${statusText}</span>
      <div class="msg">${safeMessage}</div>
      <div class="grid">
        <div class="k">Report ID</div><div class="v">${safeId}</div>
        <div class="k">Topic</div><div class="v">${safeTopic}</div>
        <div class="k">Venue</div><div class="v">${safeVenue}</div>
        <div class="k">Checked At</div><div class="v">${escapeHtml(checkedAt)}</div>
      </div>
    </div>
  </div>
</body>
</html>`;
    return res.status(payload.valid ? 200 : 409).type('html').send(html);
  }
  return res.json(payload);
});

// 404 fallback (must be after all API and page routes)
app.use((req, res) => {
  if (req.method === 'GET' && !req.path.startsWith('/api')) {
    return res.redirect('/login');
  }
  res.status(404).json({
    error: 'Not found',
    path: req.method + ' ' + req.path,
    hint: 'Check the URL. For the app use /app, /student, /login, or /leadership-login. For AI chat use POST /api/ai/chat.',
  });
});

// ---- WebRTC signaling layer using Socket.IO ----
let lastActiveSessionId = null; // so late-joining students get current session

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  socket.data.sessionId = null;

  function resolveTargetRoom(payload) {
    const sid = payload && payload.sessionId != null ? String(payload.sessionId).trim() : '';
    if (sid) return sessionRoomId(sid);
    if (socket.data && socket.data.sessionId) return sessionRoomId(socket.data.sessionId);
    return 'main-room';
  }

  socket.on('join-role', (role) => {
    socket.data.role = role;
    socket.join('main-room');
    console.log(`Client ${socket.id} joined as ${role}`);
    if (role === 'student' && lastActiveSessionId != null) {
      socket.emit('active-session', { sessionId: lastActiveSessionId });
    }
    socket.to('main-room').emit('peer-joined', { role });
    // Tell the joining client who is already in the room (so student sees faculty if faculty joined first)
    const room = io.sockets.adapter.rooms.get('main-room');
    const roles = [];
    if (room) {
      for (const sid of room) {
        if (sid !== socket.id) {
          const s = io.sockets.sockets.get(sid);
          if (s && s.data && s.data.role) roles.push(s.data.role);
        }
      }
    }
    socket.emit('peers-in-room', { roles });
  });

  socket.on('join-session', (payload) => {
    const sessionId = payload && payload.sessionId != null ? String(payload.sessionId).trim() : '';
    if (!sessionId) return;
    if (socket.data && socket.data.sessionId) {
      socket.leave(sessionRoomId(socket.data.sessionId));
    }
    socket.data.sessionId = sessionId;
    socket.join(sessionRoomId(sessionId));
  });

  // WebRTC offer/answer/candidate relaying
  socket.on('webrtc-offer', (payload) => {
    socket.to(resolveTargetRoom(payload)).emit('webrtc-offer', payload);
  });

  socket.on('webrtc-answer', (payload) => {
    socket.to(resolveTargetRoom(payload)).emit('webrtc-answer', payload);
  });

  socket.on('webrtc-ice-candidate', (payload) => {
    socket.to(resolveTargetRoom(payload)).emit('webrtc-ice-candidate', payload);
  });

  // Faculty broadcasts active session so students can send attention to it (no auth required on student)
  socket.on('set-active-session', (payload) => {
    const sessionId = payload && payload.sessionId != null ? payload.sessionId : null;
    lastActiveSessionId = sessionId;
    globalSessionActive = !!sessionId;
    if (sessionId) {
      const sid = String(sessionId).trim();
      socket.data.sessionId = sid;
      socket.join(sessionRoomId(sid));
    } else if (socket.data && socket.data.sessionId) {
      socket.leave(sessionRoomId(socket.data.sessionId));
      socket.data.sessionId = null;
    }
    io.emit('active-session', { sessionId });
  });

  // Anonymous "I'm confused" signal from students (no identity attached).
  socket.on('student-confused', (payload) => {
    const sessionId = payload && payload.sessionId != null ? payload.sessionId : null;
    if (sessionId && sessions[sessionId] && typeof sessions[sessionId].confusionCount === 'number') {
      sessions[sessionId].confusionCount += 1;
    }
    const safePayload = {
      sessionId,
      timestamp: payload && payload.timestamp ? payload.timestamp : new Date().toISOString(),
    };
    io.to(resolveTargetRoom(payload)).emit('student-confused', safePayload);
  });

  // Hybrid Camera Control: relay commands to faculty (software mode = CSS transforms; PTZ = hardware)
  let cameraMode = 'software'; // 'software' | 'ptz'
  socket.on('camera-control', (payload) => {
    const action = payload && payload.action ? payload.action : null;
    if (!action) return;
    const validActions = ['zoom-in', 'zoom-out', 'pan-left', 'pan-right', 'tilt-up', 'tilt-down', 'stop'];
    if (!validActions.includes(action)) return;
    if (cameraMode === 'software') {
      io.to(resolveTargetRoom(payload)).emit('camera-control', { action, sessionId: payload && payload.sessionId ? payload.sessionId : (socket.data && socket.data.sessionId ? socket.data.sessionId : null) });
    } else if (cameraMode === 'ptz') {
      // PTZ: would integrate ONVIF/RTSP here; placeholder
      io.to(resolveTargetRoom(payload)).emit('camera-control', { action, sessionId: payload && payload.sessionId ? payload.sessionId : (socket.data && socket.data.sessionId ? socket.data.sessionId : null) });
    }
  });

  // AI Auto-Focus: move camera when zone attention < 45%; 15s cooldown
  let lastCameraFocusTime = 0;
  const CAMERA_FOCUS_COOLDOWN_MS = 15 * 1000;
  socket.on('camera-focus', (payload) => {
    const zone = payload && payload.zone ? payload.zone : null;
    if (!zone) return;
    const now = Date.now();
    if (now - lastCameraFocusTime < CAMERA_FOCUS_COOLDOWN_MS) return;
    lastCameraFocusTime = now;
    const label = ZONE_LABELS[zone] || ZONE_DISPLAY_LABELS[zone] || zone;
    io.to(resolveTargetRoom(payload)).emit('camera-focus-ack', { zone, label, sessionId: payload && payload.sessionId ? payload.sessionId : (socket.data && socket.data.sessionId ? socket.data.sessionId : null) });
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    socket.to('main-room').emit('peer-left', { role: socket.data.role });
  });
});

// Listen on all interfaces (0.0.0.0) so dashboards are reachable via LAN IP from other devices
function getLocalIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return null;
}

server.listen(PORT, '0.0.0.0', () => {
  const localIP = getLocalIP();
  const pubBase = normalizeEmailBaseUrl(process.env.PUBLIC_BASE_URL);
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Student page: http://localhost:${PORT}/student`);
  console.log(`Faculty dashboard: http://localhost:${PORT}/ (requires login)`);
  if (pubBase) {
    console.log(`Public base URL (emails, verify links, report QR): ${pubBase}`);
  }
  if (localIP) {
    console.log(`Access from other devices (same network):`);
    console.log(`  Faculty: http://${localIP}:${PORT}/`);
    console.log(`  Student: http://${localIP}:${PORT}/student`);
    if (httpsServer && httpsPort) {
      console.log(`Secure (recommended for phones / camera):`);
      console.log(`  Faculty: https://${localIP}:${httpsPort}/`);
      console.log(`  Student: https://${localIP}:${httpsPort}/student`);
    }
  }
  if (!smtpConfigured) {
    console.log('Email: SMTP not configured. Session report emails will not be sent. Set SMTP_USER, SMTP_PASS (and optionally SMTP_HOST, SMTP_PORT) to enable.');
  } else {
    console.log('Email: SMTP configured. Session report emails will be sent to faculty on session end.');
  }
  if (smtpConfigured && String(process.env.DAILY_ATTENDANCE_EMAIL_ENABLED || '').trim().toLowerCase() === 'true') {
    startDailyFacultyAttendanceEmailScheduler();
    const tz = String(process.env.DAILY_ATTENDANCE_TZ || 'Asia/Kolkata').trim();
    const h = parseInt(String(process.env.DAILY_ATTENDANCE_EMAIL_HOUR || '18'), 10) || 18;
    const mi = parseInt(String(process.env.DAILY_ATTENDANCE_EMAIL_MINUTE || '0'), 10) || 0;
    console.log(`Daily faculty attendance CSV email: ENABLED at ${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')} (${tz}) — CSV + branded HTML to each faculty with rows that day.`);
  }
  if (!firewallCredentialStrong) {
    console.warn('Security warning: FIREWALL_USERNAME/FIREWALL_PASSWORD are weak or default. Set strong values in .env immediately.');
  }
});

if (httpsServer && httpsPort) {
  httpsServer.listen(httpsPort, '0.0.0.0', () => {
    console.log(`HTTPS server running on https://localhost:${httpsPort}`);
  });
}

