/**
 * Security & Cryptography Module
 * Uses Node.js built-in crypto only.
 * - AES-256-CBC encrypt/decrypt for sensitive data
 * - RSA digital signatures for message authenticity
 * - SHA256 hashing for session IDs, device identifiers, integrity
 * - Secure session tokens; HMAC for attention payload signing
 *
 * Security rules: never store plain passwords; encrypt sensitive session data;
 * verify signatures before processing; use env vars for keys; rotate keys periodically.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ---- MODULE 1 & 2: AES-256-CBC ----
const ALGORITHM = 'aes-256-cbc';
const KEY_LEN = 32;
const IV_LEN = 16;

// Use env for key/IV in production; otherwise derive from a fixed secret for dev (single process).
function getEncryptionKey() {
  const envKey = process.env.ENCRYPTION_KEY;
  if (envKey && Buffer.isBuffer(envKey)) return envKey;
  if (typeof envKey === 'string' && envKey.length >= KEY_LEN * 2) {
    return Buffer.from(envKey.slice(0, KEY_LEN * 2), 'hex');
  }
  return crypto.scryptSync(process.env.SESSION_SECRET || 'dev-secret', 'salt', KEY_LEN);
}

function getEncryptionIV() {
  const envIv = process.env.ENCRYPTION_IV;
  if (envIv && Buffer.isBuffer(envIv)) return envIv;
  if (typeof envIv === 'string' && envIv.length >= IV_LEN * 2) {
    return Buffer.from(envIv.slice(0, IV_LEN * 2), 'hex');
  }
  return crypto.createHash('sha256').update(process.env.SESSION_SECRET || 'dev-iv').digest().slice(0, IV_LEN);
}

/**
 * Encrypt sensitive data before storing or transmitting.
 * @param {string} data - Plain text (UTF-8)
 * @returns {string} Hex-encoded ciphertext
 */
function encryptData(data) {
  const key = getEncryptionKey();
  const iv = getEncryptionIV();
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(data, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return encrypted;
}

/**
 * Decrypt data encrypted with encryptData.
 * @param {string} encrypted - Hex-encoded ciphertext
 * @returns {string} Plain text (UTF-8)
 */
function decryptData(encrypted) {
  const key = getEncryptionKey();
  const iv = getEncryptionIV();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// ---- Per-session AES helpers (derive key/IV from session signing key) ----
function deriveSessionKey(signingKeyHex) {
  // signingKeyHex is random 32-byte hex; hash to get 32-byte AES key
  return crypto.createHash('sha256').update(Buffer.from(signingKeyHex, 'hex')).digest();
}

function deriveSessionIv(signingKeyHex) {
  // Derive IV deterministically from signing key; length 16 bytes for AES-256-CBC
  return crypto
    .createHash('sha256')
    .update('iv-' + String(signingKeyHex))
    .digest()
    .slice(0, IV_LEN);
}

/**
 * Encrypt a JSON payload string for a specific session using its signing key.
 * Used for end-to-end encryption of attention payloads between browser and server.
 * @param {string} plainText - Canonical payload string
 * @param {string} signingKeyHex - Session signing key (hex)
 * @returns {string} Hex-encoded ciphertext
 */
function encryptForSession(plainText, signingKeyHex) {
  const key = deriveSessionKey(signingKeyHex);
  const iv = deriveSessionIv(signingKeyHex);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(String(plainText), 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return encrypted;
}

/**
 * Decrypt a payload encrypted with encryptForSession.
 * @param {string} encrypted - Hex-encoded ciphertext
 * @param {string} signingKeyHex - Session signing key (hex)
 * @returns {string} Plain text (UTF-8)
 */
function decryptForSession(encrypted, signingKeyHex) {
  const key = deriveSessionKey(signingKeyHex);
  const iv = deriveSessionIv(signingKeyHex);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  let decrypted = decipher.update(String(encrypted), 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// ---- MODULE 3: RSA digital signatures ----
const RSA_MODULUS_LENGTH = 2048;
let _rsaPublicKey = null;
let _rsaPrivateKey = null;

function getRSAKeyPair() {
  if (_rsaPublicKey && _rsaPrivateKey) return { publicKey: _rsaPublicKey, privateKey: _rsaPrivateKey };
  const pemPublic = process.env.RSA_PUBLIC_KEY_PEM;
  const pemPrivate = process.env.RSA_PRIVATE_KEY_PEM;
  if (pemPublic && pemPrivate) {
    _rsaPublicKey = pemPublic;
    _rsaPrivateKey = pemPrivate;
    return { publicKey: _rsaPublicKey, privateKey: _rsaPrivateKey };
  }
  // Persist keys across restarts so stored OD signatures remain verifiable.
  const dataDir = path.join(__dirname, '..', 'data');
  const publicKeyPath = path.join(dataDir, 'rsa_public.pem');
  const privateKeyPath = path.join(dataDir, 'rsa_private.pem');

  try {
    if (fs.existsSync(publicKeyPath) && fs.existsSync(privateKeyPath)) {
      _rsaPublicKey = fs.readFileSync(publicKeyPath, 'utf8');
      _rsaPrivateKey = fs.readFileSync(privateKeyPath, 'utf8');
      return { publicKey: _rsaPublicKey, privateKey: _rsaPrivateKey };
    }
  } catch (_) {
    // If reading fails, fall back to generating new keys below.
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: RSA_MODULUS_LENGTH,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  _rsaPublicKey = publicKey;
  _rsaPrivateKey = privateKey;

  try {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(publicKeyPath, _rsaPublicKey, 'utf8');
    fs.writeFileSync(privateKeyPath, _rsaPrivateKey, 'utf8');
  } catch (_) {
    // Non-fatal: signatures may become unverifiable after restart if keys can't be saved.
  }

  return { publicKey: _rsaPublicKey, privateKey: _rsaPrivateKey };
}

/**
 * Sign data with RSA private key (SHA256). Use for server-originated messages.
 * @param {object|string} data - Data to sign (will be JSON.stringify if object)
 * @returns {string} Hex signature
 */
function signData(data) {
  const { privateKey } = getRSAKeyPair();
  const sign = crypto.createSign('SHA256');
  sign.update(typeof data === 'string' ? data : JSON.stringify(data));
  sign.end();
  return sign.sign(privateKey, 'hex');
}

/**
 * Verify RSA signature. Use for messages that were signed with the matching private key.
 * @param {object|string} data - Original data (same format as when signed)
 * @param {string} signature - Hex signature
 * @returns {boolean}
 */
function verifySignature(data, signature) {
  const { publicKey } = getRSAKeyPair();
  const verify = crypto.createVerify('SHA256');
  verify.update(typeof data === 'string' ? data : JSON.stringify(data));
  verify.end();
  return verify.verify(publicKey, signature, 'hex');
}

// ---- MODULE 7: SHA256 hashing (session IDs, device identifiers, integrity) ----
/**
 * Hash sensitive data (e.g. session IDs, device identifiers).
 * @param {string} data
 * @returns {string} Hex digest
 */
function hashData(data) {
  return crypto.createHash('sha256').update(String(data)).digest('hex');
}

// ---- MODULE 8: Secure session token ----
/**
 * Generate cryptographically secure session token (e.g. for session auth, WebSocket validation).
 * @returns {string} Hex token
 */
function secureSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

// ---- Attention payload: HMAC sign/verify (per-session key from server) ----
const HMAC_ALGO = 'sha256';

/**
 * Sign attention payload with session signing key (HMAC). Used by server to verify client payloads.
 * Client receives the key once and signs each payload; server verifies with same key.
 * @param {object} payload - Canonical payload (no signature/hash fields)
 * @param {string} signingKeyHex - Session signing key (hex)
 * @returns {string} Hex HMAC
 */
function signAttentionPayload(payload, signingKeyHex) {
  const key = Buffer.from(signingKeyHex, 'hex');
  const hmac = crypto.createHmac(HMAC_ALGO, key);
  hmac.update(canonicalPayloadString(payload));
  hmac.end();
  return hmac.digest('hex');
}

/**
 * Verify HMAC signature on attention payload.
 * @param {object} payload - Payload without signature/hash
 * @param {string} signature - Hex HMAC
 * @param {string} signingKeyHex - Session signing key (hex)
 * @returns {boolean}
 */
function verifyAttentionSignature(payload, signature, signingKeyHex) {
  if (!signature || !signingKeyHex) return false;
  try {
    const expected = signAttentionPayload(payload, signingKeyHex);
    const a = Buffer.from(String(signature), 'hex');
    const b = Buffer.from(String(expected), 'hex');
    if (a.length !== b.length || !a.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch (_) {
    return false;
  }
}

/** Canonical string for signing (stable key order for same payload). */
function canonicalPayloadString(payload) {
  const keys = Object.keys(payload).filter((k) => k !== 'signature' && k !== 'hash').sort();
  const obj = {};
  keys.forEach((k) => { obj[k] = payload[k]; });
  return JSON.stringify(obj);
}

/**
 * Compute integrity hash of payload (for optional integrity check before decrypt).
 * @param {object|string} data - Payload or raw string
 * @returns {string} Hex SHA256
 */
function integrityHash(data) {
  const str = typeof data === 'string' ? data : JSON.stringify(data);
  return hashData(str);
}

module.exports = {
  encryptData,
  decryptData,
  encryptForSession,
  decryptForSession,
  signData,
  verifySignature,
  hashData,
  secureSessionToken,
  signAttentionPayload,
  verifyAttentionSignature,
  integrityHash,
  canonicalPayloadString,
  getRSAKeyPair,
};
