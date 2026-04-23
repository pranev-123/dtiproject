# Deploy REC AI Classroom Attention System

This guide covers running the **Faculty** and **Student** dashboards locally, on a LAN (via IP), and on the cloud (Render, Railway, Heroku). The app provides live camera streaming, AI attention (eye gaze, posture, head orientation), WebSocket alerts, and email (credentials, verification, security alerts).

---

## How to deploy as a webpage (quick overview)

| Goal | What to do |
|------|------------|
| **Same PC only** | Run `npm install` then `npm start` in the project folder. Open **http://localhost:3000/app** (or `/`, `/student`, `/login`). |
| **Other devices on same Wi‑Fi/LAN** | Same as above. Use the IP the server prints (e.g. `http://192.168.1.5:3000/app`). Allow port 3000 in Windows Firewall if needed. |
| **Public webpage (internet, HTTPS)** | Deploy to a cloud host (e.g. **Render**, **Railway**, **Heroku**) so you get a URL like `https://your-app.onrender.com`. See **Option 1: Render** (and Option 2/3) below. |
| **College server** | Copy the project to the server, set `PORT` and `SESSION_SECRET` (and optional `SERVER_URL`, SMTP), run `npm install` and `npm start`. Use a process manager (e.g. **PM2**) and **nginx** (or similar) for HTTPS and reverse proxy. |

**Minimal deploy (any machine):**

```bash
cd dti
npm install
npm start
```

Then open in a browser: **http://localhost:3000/app** (or the URL shown in the terminal). For production, set `SESSION_SECRET` and, for email/links, `SERVER_URL` and SMTP variables (see **Environment variables** below).

---

## Minimum system requirements

### Server (machine running `npm start`)

| Requirement | Minimum |
|-------------|---------|
| **Node.js** | 18.x or later (LTS recommended; required by dependencies such as Helmet) |
| **npm** | 9.x or later (bundled with Node.js) |
| **RAM** | 256 MB for light use; 512 MB+ for multiple concurrent sessions |
| **OS** | Windows 10+, macOS 10.15+, or Linux (e.g. Ubuntu 20.04+) |
| **Network** | One free TCP port (default 3000) for HTTP |

Check versions: `node --version` and `npm --version`.

### Faculty & student devices (browser)

| Requirement | Minimum |
|-------------|---------|
| **Browser** | Chrome, Edge, Firefox, or Safari (latest or previous major version) |
| **JavaScript** | Enabled |
| **Cookies** | Enabled (required for login sessions) |
| **Screen** | 1024×768 or higher recommended |
| **Network** | Stable connection to the server (LAN or internet) |

### Student device (for live camera & AI attention)

| Requirement | Minimum |
|-------------|---------|
| **Camera** | Front-facing webcam (built-in or USB); required for attention scoring |
| **Lighting** | Adequate room light for reliable face detection |
| **CPU** | Dual-core or better recommended (face detection runs in the browser) |
| **Context** | HTTPS or `localhost` (browsers require secure context for camera access) |

Face detection and attention (eye gaze, posture, head orientation) run entirely in the student’s browser; no GPU is required, but a faster device improves responsiveness.

---

## Local & network deployment (same machine + LAN)

### Run the server

From the project root (folder containing `server.js` and `package.json`):

```bash
npm install
npm start
```

The server listens on **all interfaces** (`0.0.0.0`) on the port set in `.env` or `PORT` (default **3000**).

### What the server prints

On startup you will see:

- **Local (same machine):**
  - Faculty dashboard: `http://localhost:3000/`
  - Student page: `http://localhost:3000/student`
  - Faculty login: `http://localhost:3000/login`
  - Student login: `http://localhost:3000/student/login`

- **Network (other devices on same Wi‑Fi/LAN):**
  - The server detects your machine’s IPv4 address and prints:
    - Faculty: `http://<YOUR_IP>:3000/`
    - Student: `http://<YOUR_IP>:3000/student`

Example: if your PC’s IP is `192.168.1.105`, use:

| Page | URL (local) | URL (from other devices) |
|------|-------------|---------------------------|
| Faculty dashboard | `http://localhost:3000/` | `http://192.168.1.105:3000/` |
| Faculty login | `http://localhost:3000/login` | `http://192.168.1.105:3000/login` |
| Student dashboard | `http://localhost:3000/student` | `http://192.168.1.105:3000/student` |
| Student login | `http://localhost:3000/student/login` | `http://192.168.1.105:3000/student/login` |
| Register (faculty) | `http://localhost:3000/register` | `http://192.168.1.105:3000/register` |
| Register (student) | `http://localhost:3000/student/register` | `http://192.168.1.105:3000/student/register` |

### Finding your IP (if not shown)

- **Windows:** `ipconfig` → look for **IPv4 Address** under your active adapter (Wi‑Fi or Ethernet).
- **macOS/Linux:** `ifconfig` or `ip addr` → look for a private address (e.g. `192.168.x.x`).

### Troubleshooting: URL not opening on other devices

If the dashboard URL works on the server PC but **does not open on another device** (phone, another laptop), do the following.

**1. Confirm the server is running and note the IP**

When you run `npm start`, the terminal shows something like:

```
Access from other devices (same network):
  Faculty: http://10.52.221.58:3000/
  Student: http://10.52.221.58:3000/student
```

Use that **exact** IP (e.g. `10.52.221.58`) in the URL on the other device. If your PC has both Wi‑Fi and Ethernet, the IP can change; run `ipconfig` (Windows) and use the IPv4 address of the adapter that is connected to the **same network** as the other device.

**2. Allow port 3000 through Windows Firewall (server PC)**

On the **machine running the server** (Windows):

- Open **Windows Defender Firewall** → **Advanced settings** (or run `wf.msc`).
- Click **Inbound Rules** → **New Rule**.
- Choose **Port** → Next → **TCP**, **Specific local ports:** `3000` → Next.
- Select **Allow the connection** → Next → leave all profiles (Domain, Private, Public) checked → Next.
- Name: e.g. **REC Dashboard port 3000** → Finish.

Or run **PowerShell as Administrator** and run once:

```powershell
New-NetFirewallRule -DisplayName "REC Dashboard 3000" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow
```

**3. Same network**

The other device must be on the **same Wi‑Fi or LAN** as the server (e.g. same building network). Guest Wi‑Fi or a different subnet often cannot reach the server.

**4. Test from the other device**

- Open a browser and go to: `http://<SERVER_IP>:3000/` (e.g. `http://10.52.221.58:3000/`).
- If it still fails, from the other device try: **ping** the server IP (e.g. `ping 10.52.221.58`). If ping fails, the network path is blocked (firewall or different network).

### Firewall (summary)

If other devices cannot open the URLs, allow **inbound TCP on port 3000** (or your `PORT`) in Windows Firewall (or your OS firewall) for the Node process.

### Environment for local/LAN

Create a `.env` file in the project root. Minimum for local run:

- `PORT=3000` (optional; default is 3000)
- `SESSION_SECRET=<long random string, 32+ chars>` (recommended for security)

For **email** (registration credentials, verification links, security alerts, session reports):

- `SMTP_USER` – e.g. Gmail address
- `SMTP_PASS` – Gmail App Password (if 2FA enabled)
- `SMTP_HOST=smtp.gmail.com`
- `SMTP_PORT=587`
- `FROM_EMAIL` (optional; defaults to `SMTP_USER`)

For **verification email links** to work when opening them from another device, set the base URL:

- `SERVER_URL=http://<YOUR_IP>:3000` (e.g. `SERVER_URL=http://192.168.1.105:3000`)

---

## Environment variables (all deployments)

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Server port. Default `3000`. Set by cloud providers. |
| `NODE_ENV` | No | Set to `production` for secure cookies (HTTPS) and production behavior. |
| `SESSION_SECRET` | Yes (production) | Secret for session cookies. Use a long random string (32+ characters). |
| `SERVER_URL` | No | Base URL for verification and email links (e.g. `https://your-app.onrender.com` or `http://192.168.1.105:3000`). Defaults to `http://localhost:PORT`. |
| `SMTP_USER` | No | Sender email (e.g. Gmail). Needed for registration, verification, security alerts, session reports. |
| `SMTP_PASS` | No | SMTP password (e.g. Gmail App Password). |
| `SMTP_HOST` | No | Default `smtp.gmail.com`. |
| `SMTP_PORT` | No | Default `587`. |
| `SMTP_SECURE` | No | Set `true` for port 465. |
| `FROM_EMAIL` | No | From address in emails; defaults to `SMTP_USER`. |

---

## Option 1: Render (recommended, free tier)

### Prerequisites

- A [Render](https://render.com) account (free).
- Project in a **Git** repository (e.g. GitHub). If the app is in a `dti` subfolder, set **Root Directory** to `dti`.

### Deploy with Blueprint (render.yaml)

1. Push code to GitHub (include `dti` and its `render.yaml` if present).
2. [Render Dashboard](https://dashboard.render.com) → **New** → **Blueprint**.
3. Connect GitHub and select the repository. Set **Root Directory** to `dti` if needed.
4. Click **Apply**. After deploy, the app URL will be like `https://rec-live-video-dashboard.onrender.com`.

### Deploy without Blueprint (manual)

1. **New** → **Web Service**. Connect the repo.
2. **Name:** e.g. `rec-live-video-dashboard`. **Root Directory:** `dti` if applicable.
3. **Runtime:** Node. **Build Command:** `npm install`. **Start Command:** `npm start`.
4. **Environment:** Set `SESSION_SECRET`, and optionally `SERVER_URL` (your Render URL), `SMTP_USER`, `SMTP_PASS`, `FROM_EMAIL`, `SMTP_HOST`, `SMTP_PORT`.
5. **Create Web Service**.

### URLs after deploy

| Page | URL |
|------|-----|
| Faculty dashboard | `https://<your-app>.onrender.com/` |
| Faculty login | `https://<your-app>.onrender.com/login` |
| Student dashboard | `https://<your-app>.onrender.com/student` |
| Student login | `https://<your-app>.onrender.com/student/login` |

Set `SERVER_URL=https://<your-app>.onrender.com` so verification and email links use HTTPS.

### Render free tier notes

- Service may spin down after ~15 minutes of no traffic; first load can take 30–60 seconds.
- For always-on, use a paid plan or another provider.

---

## Option 2: Railway

1. Sign up at [Railway](https://railway.app) and create a new project.
2. Deploy from GitHub; set **Root Directory** to `dti` if the app is in that folder.
3. Set **Build:** `npm install`, **Start:** `npm start` if not auto-detected.
4. **Variables:** `SESSION_SECRET`, and optionally `SERVER_URL`, `SMTP_USER`, `SMTP_PASS`, `FROM_EMAIL`.
5. **Settings** → **Generate Domain** to get a public HTTPS URL.
6. Faculty: `https://<your-app>.up.railway.app/` · Student: `https://<your-app>.up.railway.app/student`

---

## Option 3: Heroku

1. Install [Heroku CLI](https://devcenter.heroku.com/articles/heroku-cli) and log in.
2. From the **dti** folder (or repo root if `dti` is the root):
   ```bash
   heroku create
   heroku config:set SESSION_SECRET=your-long-random-secret
   heroku config:set SERVER_URL=https://<your-app>.herokuapp.com
   git subtree push --prefix dti heroku main   # or: git push heroku main
   ```
3. Heroku sets `PORT` automatically. Faculty: `https://<your-app>.herokuapp.com/` · Student: `https://<your-app>.herokuapp.com/student`

---

## Checklist after deploy

- [ ] App URL loads (HTTPS in production).
- [ ] **Faculty:** Register at `/register` with `@rajalakshmi.edu.in` email; receive encrypted credentials and verification link by email; verify and log in at `/login` using the mailed legacy-number password; change password if prompted.
- [ ] **Student:** Register at `/student/register` with register number and `@rajalakshmi.edu.in` email; receive encrypted credentials and verification link; verify and log in at `/student/login` using the mailed legacy-number password; change password if prompted.
- [ ] Faculty starts a session; student sees session and can start camera / streaming.
- [ ] AI attention (pulse, trend, alerts) works; student camera and face detection run in the browser.
- [ ] Email: verification and security alerts work when SMTP is configured; session report email sent when a session ends (if SMTP set).

Camera and computer vision run in the student’s browser; the server serves the app, WebSockets, and APIs. No extra server-side setup is needed for eye gaze, posture, or head orientation.
[[]]