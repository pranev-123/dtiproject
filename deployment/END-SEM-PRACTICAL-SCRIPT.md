# End-semester practical — 10-minute demo script

Fill in the **blanks** before printing. Use two browsers (or normal + incognito) for faculty vs student.

---

## Before the exam (5 min)

| Field | Your value |
|-------|------------|
| Deployed app URL | `https://________________.onrender.com` (or `http://localhost:3000`) |
| Show live email in demo? | ☐ Yes (SMTP on) ☐ No (skip inbox) |
| MongoDB | ☐ Atlas URI set on host ☐ Local `db.json` only |
| Default login password (if using) | `Rec@2026` (or your `MASTER_LOGIN_PASSWORD`) |

Warm-up: open the URL once, wait for cold start, log in as faculty, open student dashboard in second window.

---

## Minute 0–1 — Intro (say this)

“This is REC Classroom Attention: faculty run sessions, students join with attention and attendance features, leadership has oversight. Data persists in MongoDB when configured; email sends session reports when SMTP is set.”

---

## Minute 1–3 — Registration & login

1. **Student:** open `…/student` → register (note register number if your demo uses it).
2. **Faculty:** open `…/login` → sign in.
3. **Leadership:** open `…/leadership-login` → sign in (if required by examiner).

**Pass:** dashboards load; no “register first” or wrong-role errors.

---

## Minute 3–6 — Live session

1. Faculty: **Start session** (topic / venue / time as your form requires).
2. Student: join / enable camera if the flow needs it; confirm faculty sees activity.
3. Optional quick wins: post a **quiz or poll**; open **screen share** (tab or window); show **Innovation Lab** from profile menu.

**Pass:** session start API succeeds; no “Please sign in again” unless you switched accounts carelessly.

---

## Minute 6–8 — End session & reports

1. Faculty: **End session**.
2. If **email demo**: open faculty inbox (and spam); mention attention / quiz / poll attachments when SMTP is configured.

**Pass:** session ends cleanly; mail appears or you explain SMTP/env for production.

---

## Minute 8–10 — Leadership & wrap-up

1. Leadership: open overview / OD queue / **emergency session** (AHoD only) if asked.
2. Close with: “HTTPS and secrets are via env on Render; `PUBLIC_BASE_URL` fixes links in emails.”

---

## If something breaks (cheat sheet)

| Symptom | Quick fix |
|---------|-----------|
| 401 / sign in again | Incognito window; correct URL (faculty vs student); log in again |
| Too many attempts | Wait lockout minutes or adjust `MAX_FAILED_ATTEMPTS` / `LOCKOUT_DURATION_MINUTES` in env |
| No email | Check `SMTP_USER`, `SMTP_PASS`, port 587 vs 465 + `SMTP_SECURE`, spam folder |
| Empty data after deploy | Verify `MONGODB_URI` and `MONGODB_DB=dti` on the host |

---

## Optional blank test accounts (fill if pre-created)

| Role | Username / email | Password |
|------|------------------|----------|
| Faculty | | |
| Student | | |
| Leadership | | |
