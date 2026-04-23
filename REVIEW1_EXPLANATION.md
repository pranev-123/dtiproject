# How to Explain the Project for Review 1

Use this as a script or outline when presenting to your reviewer (ma'am/sir).

---

## 1. One-line summary (start with this)

**“Our project is an AI-based Classroom Attention System for Rajalakshmi Engineering College. It lets faculty see live, anonymised attention levels of the class, while students get a simple dashboard with camera-based attention feedback, learning modes, and in-built help—all with strong privacy: no facial recognition and no video stored.”**

---

## 2. Problem we are solving

- In large classes, faculty cannot easily tell if students are engaged or confused.
- Students may hesitate to ask doubts publicly.
- There was no single system that gave **live attention feedback** to the teacher and **anonymous confusion signals** from students, while keeping **privacy** (no face identity, no recording).

---

## 3. Our solution in brief

- **Faculty**: Start a session (topic, venue, time). See a **Live Pulse** (average class attention %) and a **trend graph**. Get teaching tips and optional **zone-wise** (front/middle/back) insight. End session and get a summary/report.
- **Students**: Join the session, turn on camera. Get an **attention score** on their own screen (no identity sent). Use **Listening / Note-taking / Discussion** modes. Press **“I didn’t understand”** to send an **anonymous** confusion signal. Use **REC EduMate** (chat + voice) for FAQs and college info. During the attendance window, raise their hand once in front of the camera for **privacy-safe Smart Attendance**.
- **Leadership**: HoDs and above get a **REC Insight** dashboard with session summaries, average attention, and low-attention sessions for their scope (e.g. department). They can also ask the AI assistant about the college and metrics.

---

## 4. Three dashboards (explain one by one)

| Dashboard   | Who uses it        | Main purpose |
|------------|--------------------|--------------|
| **Faculty**   | Teachers            | Start/end sessions, see live pulse & trend, Smart Attendance table (Present/Absent/OD by register number), teaching tips, zone insight, chat/voice assistant (REC Smart Assist), session report + emailed PDF. |
| **Student**  | Students            | Join session, camera on, see own attention score, learning modes, anonymous “I am confused”, Smart Attendance via hand-raise, OD proof upload when on duty, REC EduMate (FAQ + voice), notes, free rooms. |
| **Leadership** | HoD / leadership  | View overall engagement, session list, average/low-attention counts, department attendance percentages (Present/Absent/OD); REC Insight chat + voice (about college, metrics). |

---

## 5. Important technical points (for review)

- **Privacy**: No facial recognition; no storage of video. Only anonymised numeric attention scores (and optional confusion count) go to the server. Face detection and attention run in the **student’s browser**.
- **Tech**: Node.js (Express), Socket.IO (real-time), WebRTC for optional streaming, in-browser face/attention logic. Faculty and student roles are separate (different login and redirects).
- **AI assistants**: All three dashboards have a **voice + chat** assistant (REC Smart Assist for faculty, REC EduMate for students, REC Insight for leadership). They answer FAQs, “about college”, and dashboard-related questions; **no audio is sent to the server**—voice runs in the browser.

---

## 6. Suggested demo flow for Review 1 (2–3 minutes)

1. **Start**: “Ma’am, this is our AI Classroom Attention System for REC.”
2. **Faculty**: Open faculty login → login with the encrypted credentials mail password (legacy number format) → **Start session** (topic, venue, time) → show **Live Pulse** and **Trend** (you can say: “When students join, this shows average attention and trend.”) → optionally show **REC Smart Assist** (mic → “About college” or “How do I improve attention?”).
3. **Student**: Open student login in another tab/browser → login → open student dashboard → **Start camera** → show **attention score** and **learning mode** → show **REC EduMate** (e.g. “What does attention score mean?” or “About college”) → show **“I didn’t understand”** (anonymous confusion).
4. **Leadership** (if time): Open leadership login → show **REC Insight** dashboard (session summary, average attention) → show voice/chat: “About college” or “What is overall average attention?”
5. **End**: “Faculty can end the session and get a summary/report. All data is anonymised; we don’t store video or use facial recognition.”

---

## 7. If ma’am asks: “What is unique?”

- **Live attention** to the teacher without identifying students.
- **Anonymous confusion** so students can signal “I didn’t understand” without raising hands.
- **Learning modes** (e.g. note-taking) so looking down at notes is not counted as inattention.
- **Same system** for faculty, students, and leadership with **in-built AI voice/chat** (including “about college”) and **no server-side audio**.

---

## 8. Quick URLs (for demo)

| Page           | URL                          |
|----------------|------------------------------|
| Faculty login  | http://localhost:3000/login   |
| Faculty dashboard | http://localhost:3000/     |
| Student login  | http://localhost:3000/student/login |
| Student dashboard | http://localhost:3000/student |
| Leadership login | http://localhost:3000/leadership-login |

**Run server**: In project folder (`dti`): `npm install` then `npm start`.

---

You can print this or keep it open while explaining. Keep the one-line summary and demo flow handy so you stay clear and within time.
