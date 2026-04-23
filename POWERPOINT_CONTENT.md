# PowerPoint Presentation Content
## AI-based Classroom Attention System — REC

Follows design thinking structure: Abstract → Scope → Empathy → Point of View → Problem Statement → Solution.

---

## Slide 1: Title
- **AI-based Classroom Attention System**
- Rajalakshmi Engineering College (An Autonomous Institution)
- Design Thinking Approach

---

## Slide 2: Abstract
- **Summary:** A privacy-first system that gives faculty live, anonymised attention levels of the class while students get personal feedback and in-built help—no facial recognition, no video stored.
- Addresses classroom engagement visibility and anonymous confusion signalling.
- Uses laptop-based participation; transparency and consent built-in.

---

## Slide 3: Scope Document — Point 1
- **In scope:** Live attention feedback to faculty (aggregate only), student-facing interface for camera and attendance, Smart Attendance via hand-raise, AI voice/chat assistants, session reports.
- Focus on classroom sessions within college network; faculty, students, and leadership roles.

---

## Slide 4: Scope Document — Point 2
- **Out of scope:** Facial recognition, video storage, phone-based use in classroom, individual student identification in attention data, disciplinary use of attention scores.

---

## Slide 5: Empathy Phase
- **Understanding users**
- Faculty: Need to know if class is engaged without staring at screens; want actionable feedback.
- Students: Hesitate to ask doubts publicly; want fair attention scoring (e.g. note-taking mode).
- Leadership: Need overview of engagement and attendance across departments.
- Observation: Large classes make it hard to read room; no existing tool offers live attention + anonymous confusion.

---

## Slide 6: Empathy Phase — Insights
- Faculty struggle to gauge engagement in real time.
- Students prefer anonymous ways to signal confusion.
- Students are concerned about privacy if attention is monitored.
- Need for a system that is transparent and consent-based (students know they are participating).

---

## Slide 7: Point of View — Explore Phase
- **Faculty POV:** “I need to see live class attention so I can adjust my teaching, without identifying or recording students.”
- **Student POV:** “I want to participate and get feedback, but I don’t want my face or identity shared.”
- **Leadership POV:** “I need department-level metrics and session summaries to support teaching quality.”

---

## Slide 8: Problem Statement
- **Primary problem:** In large classes, faculty cannot easily tell if students are engaged or confused, and students hesitate to ask doubts publicly.
- **Gap:** No single system provides live attention feedback to the teacher and anonymous confusion signals from students, while preserving privacy (no face identity, no recording).

---

## Slide 9: Our Solution
- Live attention scores to faculty (aggregate only).
- Anonymous “I didn’t understand” from students.
- Smart Attendance via hand-raise (per-device).
- Learning modes (Listening, Note-taking, Discussion).
- AI assistants (chat + voice) for faculty, students, leadership.
- Privacy-first: attention computed on student’s device; no video stored.

---

## Slide 10: Three Dashboards
| Dashboard   | Users       | Purpose                           |
|------------|-------------|-----------------------------------|
| Faculty    | Teachers    | Live pulse, trends, attendance     |
| Student    | Students    | Camera, attention, attendance      |
| Leadership | HoDs/Admin  | Summaries, department metrics      |

---

## Slide 11: Faculty Dashboard
- Start/end sessions (topic, venue, time)
- Live Pulse (average attention %)
- Trend graph (last 60 seconds)
- Smart Attendance (register number, Present/Absent/OD)
- REC Smart Assist (chat + voice)
- Session reports and emailed PDF

---

## Slide 12: Student Dashboard
- Join session, start camera (on laptop)
- Own attention score shown locally
- Hand-raise attendance (30-second window)
- Learning modes; anonymous “I didn’t understand”
- REC EduMate; private notes; OD proof upload

---

## Slide 13: Leadership Dashboard
- Overall engagement summary
- Session list with average attention
- Low-attention session count
- Department attendance (Present/Absent/OD)
- REC Insight assistant

---

## Slide 14: Privacy & Transparency
- No facial recognition
- No video stored on server
- Attention computed on student’s device
- Students opt in by opening dashboard
- Faculty sees only aggregate data

---

## Slide 15: Technical Stack
- Node.js, Express, Socket.IO
- WebRTC (optional streaming)
- Face-api.js, MediaPipe Hands
- HTML, CSS, JavaScript
- JSON storage (users, sessions, attendance)

---

## Slide 16: How It Works
1. Faculty starts session → Socket notifies students
2. Students open dashboard, start camera
3. Attention computed locally, anonymised score sent
4. Faculty sees Live Pulse and trend
5. Hand-raise marks attendance; faculty sees table
6. Session end → report and PDF

---

## Slide 17: Unique Aspects
- Live attention without identifying students
- Anonymous confusion signalling
- Learning modes for fair scoring
- AI assistants with no server-side audio
- Transparent, consent-based participation

---

## Slide 18: Demo URLs
- Faculty: `http://localhost:3000/login`
- Student: `http://localhost:3000/student/login`
- Leadership: `http://localhost:3000/leadership-login`
- Run: `npm install` then `npm start`

---

## Slide 19: Demo Flow (2–3 min)
1. Faculty login → start session
2. Student login → start camera
3. Show Live Pulse and trend
4. Show attention score and hand-raise
5. (Optional) Leadership overview
6. End session → show report

---

## Slide 20: Conclusion & Thank You
- Problem: engagement visibility + anonymous confusion
- Solution: privacy-first attention system
- Three dashboards for faculty, students, leadership
- Thank you — Q&A
