# REC Classroom Attention Dashboard

Rajalakshmi Engineering College classroom attention platform with role-based dashboards:

- Faculty dashboard
- Student dashboard
- Leadership dashboard

The system supports live attention tracking, session management, role-based access, smart attendance, OD workflows, AI assistant features, and support/contact tools.

## Run Locally

1. Install dependencies:
   - `npm install`
2. Start server:
   - `npm start`
3. Open:
   - Faculty: `http://localhost:3000/`
   - Student: `http://localhost:3000/student`
   - Leadership login: `http://localhost:3000/leadership-login`

If HTTPS certificates are available, secure endpoints run on port `3443`.

## Main Dashboards

- **Faculty**: session start/end, live pulse, trend graph, attendance table, AI chat/voice, support/inbox.
- **Student**: camera-based attention, hand-raise attendance, OD upload/status, documents, AI chat/voice, support/inbox.
- **Leadership**: overview metrics, OD approval queue, AI chat/voice, support/inbox.

## Faculty REC Smart Assist — voice commands

On the **faculty** dashboard, **REC Smart Assist** supports browser-based speech (microphone FAB or wake phrases such as “REC Smart Assist”). Commands are processed locally for recognition; answers may use the AI chat backend.

**Examples**

- **Chat**: “Open chat”, “Close chat”
- **Navigation / UI**: “Open FAQ”, “Show notifications”, “Show innovation”, “Scroll to attendance”, “Scroll to session”, “Refresh sessions”
- **Session**: “Start session”, “End session” (same as the on-screen buttons; subject to form validation)
- **Automation / data**: “Refresh AI agent”, “Update attendance table”
- **Attention / camera hints**: “Show attention level”, “Focus back row”, “Zoom camera” (software/classroom camera hint where configured)
- **Student stream (digital zoom)**: “Zoom in”, “Zoom out”, “Reset view”, “Auto face zoom”, “Auto face zoom off”
- **Other**: general questions are handled like the text chatbot when no command matches

More detail: `/frequently-asked-questions#faculty-voice-commands`

The FAQ page includes an **interactive camera controls demo** (`/frequently-asked-questions#faq-camera-controls`) that mirrors the faculty student-stream zoom UI (manual zoom, auto face zoom, reset) using your local camera preview only.

## Recent Updates

- Extended **faculty** REC Smart Assist with voice commands (chat, FAQ, notifications, innovation, session/attendance navigation, student-stream zoom, start/end session). Documented under FAQ and README.
- Added AI automation dashboard actions across all three roles in `POST /api/automation/run`.
- Added Excel attachment support (`.xls`, `.xlsx`) to AI file attach flows on all three dashboards.
- Added/standardized Support popup with **Open Support Google Form** button:
  - `https://forms.gle/jmwkr8dmg5PGx3bz6`
- Removed default OTP hint text from login pages.
- Reduced login/registration latency:
  - Lower bcrypt rounds from `12` to `10`
  - Removed 1.5-second registration redirect delay

## Data Reset

User/account data is stored in:

- `data/db.json`

It can be reset to an empty state by clearing:

- `users`
- `studentRegistrations`
- `attendanceRecords`
- `supportRequests`
- `automationAuditLogs`
- `firewallNetworkLogs`

## Notes

- SMTP is optional but required for email-based flows (OTP, credential/reset/support notifications).
- Keep role access boundaries intact: student cannot access faculty dashboard and vice versa.

