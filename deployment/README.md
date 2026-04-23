# Hardened deployment (reverse proxy, TLS termination, secrets)

This folder contains a **Docker Compose** stack: **nginx** terminates TLS and proxies to the **Node** app on port 3000 inside a private network. Sensitive values are supplied with **Docker secrets** (mounted as files under `/run/secrets/`).

## Prerequisites

- Docker Engine + Docker Compose v2
- TLS certificate and private key for your public hostname (Let's Encrypt, or self-signed for testing)

## 1. TLS certificates (nginx)

Put PEM files in `deployment/certs/` (not committed to git):

- `fullchain.pem` — full certificate chain
- `privkey.pem` — private key

**Self-signed (development only):**

```bash
openssl req -x509 -newkey rsa:4096 -keyout deployment/certs/privkey.pem -out deployment/certs/fullchain.pem -days 365 -nodes -subj "/CN=localhost"
```

## 2. Secrets (Docker Compose `file:` secrets)

Create host files (single line each, no trailing newline preferred):

| Host file | Purpose |
|-----------|---------|
| `deployment/secrets/session_secret` | At least 32 characters; used for `express-session` |
| `deployment/secrets/smtp_pass` | SMTP password (can be empty if SMTP is unused) |

**Generate session secret (example):**

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))" > deployment/secrets/session_secret
```

**Windows (PowerShell):**

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))" | Out-File -Encoding ascii -NoNewline deployment/secrets/session_secret
```

If you do not use email, create an empty `deployment/secrets/smtp_pass` file.

## 3. Non-secret environment

Set variables in your shell or a `.env` file next to `docker-compose.yml` (Compose substitutes `${VAR}` from the environment):

- `SMTP_USER` — if using mail
- `SMTP_HOST`, `SMTP_PORT` — optional overrides
- `PUBLIC_BASE_URL` — public `https://` URL users open (for links in emails, etc.)

## 4. Run

```bash
cd deployment
docker compose up --build -d
```

Browse `https://<your-host>/` (port **443**). HTTP on port **80** redirects to HTTPS.

## Application behaviour behind nginx

- `BEHIND_REVERSE_PROXY=true` — Node serves **HTTP only**; nginx handles TLS (no second HTTPS listener inside the container).
- `TRUST_PROXY=1` — Express trusts one hop (`X-Forwarded-*`) for IP and protocol.
- `SESSION_COOKIE_TRUST_PROXY=true` — session cookies honour `X-Forwarded-Proto: https` from nginx.

## Optional: any secret via `*_FILE`

At startup, `lib/secrets.js` maps `FOO_FILE=/path` → `process.env.FOO` when `FOO` is unset. Supported for `SESSION_SECRET_FILE`, `SMTP_PASS_FILE`, `GEMINI_API_KEY_FILE`, `CLAUDE_API_KEY_FILE`, etc.

## Production checklist

- Use real certificates (Let's Encrypt or institutional PKI).
- Rotate `session_secret` periodically (invalidates existing sessions).
- Restrict firewall: only **80/443** public; do not publish port **3000**.
- Prefer a managed secrets store in cloud (AWS Secrets Manager, Azure Key Vault, etc.) and inject env or files at deploy time instead of plain files on disk.
