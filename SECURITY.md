# Security (Cryptography & Integrity)

This document describes the cryptographic and integrity measures used in the AI Classroom Attention System. All crypto uses the **Node.js built-in `crypto` module** on the server; the student dashboard uses the **Web Crypto API** for signing (HMAC-SHA256).

## Security rules

- **Never store plain passwords** — passwords are hashed with bcrypt before storage.
- **Encrypt sensitive session data** — use `security.encryptData()` before storing or transmitting when needed.
- **Verify signatures before processing** — attention payloads with a signature are verified; invalid signature → reject (401).
- **Use environment variables for keys** — see below.
- **Rotate keys periodically** — change `SESSION_SECRET`, `ENCRYPTION_KEY` / `ENCRYPTION_IV`, and optionally RSA keys on a schedule.

## Environment variables (keys)

Set these in production; otherwise the server uses derived/default values (suitable only for development).

| Variable | Purpose |
|----------|---------|
| `SESSION_SECRET` | Session signing; must be ≥ 32 chars. Also used to derive AES key/IV if not set. |
| `ENCRYPTION_KEY` | AES-256 key (32 bytes), hex-encoded (64 hex chars). |
| `ENCRYPTION_IV` | AES IV (16 bytes), hex-encoded (32 hex chars). |
| `RSA_PUBLIC_KEY_PEM` | RSA public key (PEM) for signature verification. |
| `RSA_PRIVATE_KEY_PEM` | RSA private key (PEM) for signing server-originated messages. |

If RSA keys are not set, a 2048-bit key pair is generated once at startup.

## Modules (server: `lib/security.js`)

1. **AES-256-CBC** — `encryptData(data)`, `decryptData(encrypted)` for sensitive data.
2. **RSA digital signatures** — `signData(data)`, `verifySignature(data, signature)` (SHA256 + RSA 2048).
3. **SHA256 hashing** — `hashData(data)` for session IDs, device identifiers, integrity hashes.
4. **Secure session tokens** — `secureSessionToken()` (32 random bytes, hex).
5. **Attention payload signing** — per-session HMAC key; `signAttentionPayload(payload, signingKeyHex)`, `verifyAttentionSignature(payload, signature, signingKeyHex)`.

## Attention data flow

- When a faculty session is created, the server generates a **session signing key** (secure random) and stores it with the session.
- The student dashboard receives this key in the first successful response from `POST /api/attention/public` and stores it locally.
- For each subsequent attention submission, the client builds a canonical payload (sorted keys, no `signature`/`hash`), computes **HMAC-SHA256** with the session key and **SHA256** integrity hash, then sends `{ ...payload, signature, hash }`.
- The server verifies the integrity hash (if present), then the HMAC signature; if either fails, the message is rejected. Device identifiers are stored only in hashed form.

## Optional encrypted payloads

The public attention endpoint accepts an alternative body: `{ encryptedData, signature, hash }`. The server verifies `hash` over `encryptedData`, decrypts with AES-256-CBC, then verifies the signature over the decrypted payload. This allows end-to-end encryption of the payload when the client has the server’s encryption key (e.g. derived from the session).
