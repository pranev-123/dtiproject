# REC Classroom Attention — Demo & Evaluation Checklist

Use this checklist to verify **perfect output** of the project for evaluation or demonstration.

---

## Before You Start

- [ ] **Node.js** installed (`node --version` and `npm --version` work).
- [ ] In terminal, from the project folder (`dti`): run **`npm install`** then **`npm start`**.
- [ ] Open browser to **http://localhost:3000** (or the URL/port shown in terminal).
- [ ] Required assets in `public/`: `rec-logo.jpg`, and optionally `background image.jpg` (login), `rec-mascot.png`, `aadhi-rec.png`, `rec.jpg` for mascot/chat.
- [ ] **SMTP** (optional): Set `SMTP_USER`, `SMTP_PASS` (and optionally `SMTP_HOST`, `SMTP_PORT`, `FROM_EMAIL`) in `.env` for registration/login credential emails and forgot-password emails.

---

## 1. Faculty Login & Registration

- [ ] **http://localhost:3000** or **http://localhost:3000/login** loads the faculty login page.
- [ ] REC logo and “Rajalakshmi Engineering College” title display correctly.
- [ ] Email and Password fields; **Sign in** and **Register** buttons visible.
- [ ] **Register**: Opens **http://localhost:3000/register** with fields — Official college email, Name, **Staff ID**, Department, Designation (dropdown). Staff ID is required.
- [ ] After faculty registration: account created; **login credential email** sent (if SMTP configured) with logo in footer and “Rajalakshmi Engineering College (An Autonomous Institution), Rajalakshmi nagar, Thandalam, Chennai 602105”.
- [ ] **Faculty password** = the **legacy number format sent in encrypted credentials email** (e.g. `Rec.<department>@+<last3or4digits>$`) or the updated password if changed later.
- [ ] **Forgot password**: Sends a fresh encrypted credential email; use that password to sign in.
- [ ] On successful login, redirect to Faculty Dashboard. **Students cannot access the faculty dashboard** (redirected to student page if they try).

---

## 2. Faculty Dashboard

- [ ] Header shows REC logo, college name, and “Faculty Dashboard” tag without extra gaps.
- [ ] **Start session**: fill Topic, Venue, Start/End time → “Start attention tracking”.
- [ ] After starting: “Waiting for face recognition from students…” or “Waiting for students…” appears until at least one student sends attention data.
- [ ] **Live Pulse**: When students with camera/face detected join, average attention % appears (green / yellow / red).
- [ ] **Trend graph**: Last 60 seconds of attention updates; legend shows “Rising” or “Falling” when there is enough data.
- [ ] **Digital Twin** zones (Front Row, Middle Row, Back Left/Center/Right) show when zone data is received.
- [ ] **REC Smart Assist** (chat FAB): opens chat; FAQ chips and text questions get appropriate answers.
- [ ] **Voice**: Click mic FAB → say “REC Smart Assist” or “Show attention level” → command is recognized and spoken reply is given.
- [ ] **Smart Attendance (hand-raise)**: Smart Attendance card shows rows with register number and status (Present/Absent/OD) after at least one student joins and the attendance window completes.
- [ ] **End session**: “End session” closes the session; summary (average attention, report option) appears.
- [ ] Faculty can access the dashboard for the full session (no unintended logout); change password / logout available from dashboard.

---

## 3. Student Login & Registration

- [ ] **http://localhost:3000/student/login** loads the student login page.
- [ ] REC logo and student login UI; fields: college email, password (legacy number from encrypted credentials mail or updated password).
- [ ] **Register**: Opens **http://localhost:3000/student/register** — college email (@rajalakshmi.edu.in) and 8-digit **register number** required.
- [ ] After student registration: **login credential email** sent (if SMTP configured) with logo in footer and college address.
- [ ] **Student password** = the **legacy number format sent in encrypted credentials email** (e.g. `Rec.<department>@+<last3or4digits>$`) or the updated password if changed later.
- [ ] **Forgot password**: Sends a fresh encrypted credential email; use that password to sign in.
- [ ] On successful login, redirect to **http://localhost:3000/student**. **Faculty cannot access the student dashboard** (redirected to faculty dashboard if they try).

---

## 4. Student Page (Dashboard)

- [ ] **http://localhost:3000/student** requires login; unauthenticated users redirect to `/student/login`.
- [ ] REC logo and student UI (camera, learning mode, help) display correctly.
- [ ] When faculty has an **active session**: “Start camera” and session controls become available.
- [ ] **Start camera**: Camera turns on; “Face not detected” or “Attention monitoring active” appears; **attention score is only sent when a face is detected** (no score before recognition).
- [ ] **Web Camera**: Use a USB web camera; when multiple cameras exist, a dropdown appears to select the device. No extra packages required (uses browser Web APIs).
- [ ] **Attendance window**: Hand-raise window is 10 minutes (students raise hand within 10 minutes of session start to mark Present).
- [ ] **Learning modes**: Listening / Note-taking / Discussion can be selected; note-taking mode avoids penalizing “looking down”.
- [ ] **REC EduMate** (help panel): Open via button; type or use voice. Voice: “REC EduMate” then ask e.g. “What does attention score mean?” — reply is spoken and shown.
- [ ] **Anonymous “I am confused”** button sends confusion signal when session is active.
- [ ] **Notes**: Side-panel “Notes” section; type and save private notes (persisted on this device only).
- [ ] **OD upload**: In OD section, student uploads mandatory OD proof (PDF/image) when on OD for this class; status becomes OD in faculty Smart Attendance.
- [ ] **Free rooms**: Side-panel shows “Free rooms” with time **8:00 AM – 5:00 PM** and list of rooms available for study during college hours.
- [ ] **Stream to faculty** (if shown): Optional; streams video to dashboard when faculty is connected.

---

## 5. End-to-End Flow (Perfect Output)

- [ ] Faculty **registers** (if new) → receives encrypted credential email → **logs in** with the mailed legacy-number password → starts session with topic/venue/time.
- [ ] Student **registers** (if new) → receives encrypted credential email → **logs in** at `/student/login` with the mailed legacy-number password.
- [ ] Student opens `/student` → sees active session → starts camera.
- [ ] Student’s face in view → attention score appears on student side and is sent; faculty pulse and trend update.
- [ ] Within the attendance window, student raises hand at least once in front of camera → Smart Attendance marks them Present (or Absent if no hand; OD if OD proof uploaded).
- [ ] Faculty sees average attention and trend; can use voice (“How do I improve attention?”) and chat.
- [ ] Faculty ends session → summary (average attention, optional report/email) is shown and emailed PDF report contains a register-number-only attendance table.
- [ ] **Role separation**: Student visiting `/` is redirected to `/student`; faculty visiting `/student` is redirected to `/`.
- [ ] No console errors during the above flow (check browser DevTools F12 → Console).

---

## 6. Optional / Nice to Have

- [ ] Session report PDF downloads after ending session (if configured).
- [ ] Email report to faculty (if SMTP set in environment).
- [ ] Registration and forgot-password emails include REC logo in footer and college address.
- [ ] PWA: Add to home screen / install prompt (if supported).
- [ ] On phone: Use same Wi‑Fi and **http://&lt;computer-IP&gt;:3000** and **http://&lt;computer-IP&gt;:3000/student** for student.

---

## Quick Command Reference

| Action                | Command / Step                                                |
|-----------------------|---------------------------------------------------------------|
| Run project           | `npm install` then `npm start` in `dti` folder               |
| Faculty login         | http://localhost:3000/login (password = encrypted credentials mail password) |
| Faculty register     | http://localhost:3000/register                               |
| Faculty forgot pwd   | http://localhost:3000/forgot-password                        |
| Student login         | http://localhost:3000/student/login (password = encrypted credentials mail password) |
| Student register      | http://localhost:3000/student/register                       |
| Student forgot pwd   | http://localhost:3000/student/forgot-password                |
| Student dashboard     | http://localhost:3000/student (after login)                  |
| Wake voice (Faculty) | “REC Smart Assist” or “Smart Assist”                         |
| Wake voice (Student) | “REC EduMate” or “Hey REC”                                   |

---

When all items relevant to your demo are checked, the project is delivering **perfect output** for evaluation.
