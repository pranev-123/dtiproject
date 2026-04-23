/**
 * Load sensitive values from files (Docker Swarm / Compose secrets, Kubernetes secret mounts, etc.).
 * Convention: if SESSION_SECRET_FILE=/run/secrets/session_secret exists, its contents are copied into
 * process.env.SESSION_SECRET when SESSION_SECRET is not already set (explicit env wins).
 */
const fs = require('fs');

const FILE_SUFFIX = '_FILE';

function readSecretFile(filePath) {
  const p = String(filePath || '').trim();
  if (!p) return '';
  try {
    return String(fs.readFileSync(p, 'utf8')).trim();
  } catch (_) {
    return '';
  }
}

/**
 * For every environment variable named like KEY_FILE, if the path exists and KEY is unset/empty,
 * set process.env.KEY from the file contents.
 */
function applySecretsFromFiles() {
  const keys = Object.keys(process.env);
  for (let i = 0; i < keys.length; i += 1) {
    const envKey = keys[i];
    if (!envKey.endsWith(FILE_SUFFIX)) continue;
    const baseKey = envKey.slice(0, -FILE_SUFFIX.length);
    if (!baseKey) continue;
    const existing = String(process.env[baseKey] || '').trim();
    if (existing) continue;
    const pathVal = String(process.env[envKey] || '').trim();
    if (!pathVal) continue;
    const secret = readSecretFile(pathVal);
    if (secret) process.env[baseKey] = secret;
  }
}

module.exports = { applySecretsFromFiles, readSecretFile };
