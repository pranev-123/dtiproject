# AI Chatbot Across Dashboards (Powered by Gemini)

The same AI chatbot (Google Gemini) is available on all three dashboards. Each dashboard has a **chat panel** and **voice assistant** that use the same backend API; only the role (student, faculty, leadership) changes so answers stay relevant to that view.

You can use **any general prompt** in the chatbot (same as in ChatGPT), for example:
- **Time/date:** “What is the time now?”, “What’s the date?”
- **Code:** “Write Python code to read a CSV”, “Java hello world”, “Explain async/await in JavaScript”, “Debug this code”
- **Math & science:** “Solve this equation”, “Explain Newton’s laws”, “What is photosynthesis?”
- **Writing & analysis:** “Summarize this”, “Write a short essay on…”, “Translate to Hindi”, “Explain step by step”
- **Other:** Reasoning, ideas, algorithms, general knowledge, teaching tips, and any other question you would ask a general-purpose AI assistant.

---

## How to use the chatbot

### 1. Student dashboard — REC EduMate

| Where | How to use |
|-------|------------|
| **Chat** | Open the **student dashboard** (`/student`). Click the **floating help button** (bottom-right) to open the REC EduMate panel. Type your question in the input and press Enter or click Send. |
| **Voice** | In the same panel, click the **microphone** button and speak (e.g. “What is the attention score?” or “About college”). You can also say **“REC EduMate”** first when the wake-word is listening, then ask your question. |
| **FAQs** | Tap any “Common questions” chip to send that question and get an answer. |

**Best for:** Privacy, attention score, camera, learning modes, anonymous doubts, college info.

---

### 2. Faculty dashboard — REC Smart Assist

| Where | How to use |
|-------|------------|
| **Chat** | On the **faculty dashboard** (after login at `/`). Click the **mascot/chat FAB** (bottom-right) to open the REC Smart Assist panel. Type your question and send. |
| **Voice** | Click the **microphone FAB** (to the left of the mascot). Speak your question. You can also say **“REC Smart Assist”** or **“Smart Assist”** to wake, then ask. |
| **FAQs** | Use the “Frequently asked” chips in the chat panel, or “Show FAQs” to bring them back. |

**Best for:** Live Pulse, trend graph, teaching tips, sessions, reports, Smart Attendance, college info.

---

### 3. Leadership dashboard — REC Insight

| Where | How to use |
|-------|------------|
| **Chat** | Open the **leadership dashboard** (`/leadership` after leadership login). Click the **REC Insight FAB** (mascot, bottom-right) to open the chat panel. Type and send. |
| **Voice** | Click the **microphone FAB** (to the left of the mascot). Speak in English (e.g. “What is the average attention?” or “How many low-attention sessions?”). |
| **FAQs** | Use the “Frequently asked” chips; click **“× Close”** to collapse them, **“Show FAQs”** to expand again. |

**Best for:** Total sessions, average attention, low-attention sessions, scope, attendance, college info.

---

## Same chatbot, one API

All three dashboards use the **same backend**:

- **Endpoint:** `POST /api/ai/chat`
- **Body:** `{ "message": "your question", "context": "student" | "faculty" | "leadership" }`
- **Response:** `{ "reply": "AI answer text" }`

The server uses one **Google Gemini API key** (in `.env` as `GEMINI_API_KEY`) and one **model** (default `gemini-pro`, overridable with `GEMINI_MODEL`). The only difference per dashboard is the **context** and the **system prompt**:

| Context   | System prompt / role |
|----------|-----------------------|
| `student`   | REC EduMate – student help (privacy, attention, camera, modes, doubts, college). |
| `faculty`   | REC Smart Assist – faculty help (Live Pulse, graph, teaching tips, sessions, attendance, college). |
| `leadership`| REC Insight – leadership help (sessions, average attention, low-attention, scope, college). |

So you get **one chatbot implementation** (same API, same Gemini) with **role-specific behaviour** on each dashboard.

---

## How it’s implemented in code

1. **Server (`server.js`)**  
   - Single route: `POST /api/ai/chat`.  
   - Reads `GEMINI_API_KEY` and `GEMINI_MODEL` from env.  
   - Uses a system prompt from `AI_SYSTEM_PROMPTS[context]` (student / faculty / leadership).  
   - Calls Google Gemini API and returns `{ reply }`.  
   - If the key is missing or the API fails, the client falls back to local (built-in) answers.

2. **Student (`public/student.html`)**  
   - **Chat:** `handleHelpQuestion()` → `fetch('/api/ai/chat', { body: { message, context: 'student' } })` → on success use `data.reply`, else `findBestHelpAnswer(q)`.  
   - **Voice:** `handleStudentVoiceTranscript()` → same API with `context: 'student'`, fallback `findFAQAnswer(t)`.

3. **Faculty (`public/faculty.html`)**  
   - **Chat:** `sendChatMessage()` → `getAIResponse(text)` → `fetch('/api/ai/chat', { body: { message, context: 'faculty' } })`, fallback `getLocalAIResponse(text)`.  
   - **Voice:** `processVoiceCommand()` → `await getAIResponse(command)` (same API + fallback).

4. **Leadership (`public/leadership.html`)**  
   - **Chat:** `leaderSendChat()` → `await leaderGetAIResponse(text)` → `fetch('/api/ai/chat', { body: { message, context: 'leadership' } })`, fallback `leaderGetLocalResponse(text)`.  
   - **Voice:** Same `leaderGetAIResponse()` in the recognition `onresult` handler.

So the **same chatbot** (same API, same model) is **implemented across all three dashboards** by calling `/api/ai/chat` with the appropriate `context` and using the same request/response shape everywhere.

---

## Enabling the chatbot (Gemini API key)

1. Copy `.env.example` to `.env` if you don’t have `.env` yet.  
2. Set in `.env` (same variables as in `.env.example`):

   ```env
   # Google Gemini API key for AI voice assistants (optional; if set, all three dashboards use Gemini)
   GEMINI_API_KEY=your_gemini_api_key_here

   # Optional: model name (default gemini-pro); e.g. gemini-1.5-flash, gemini-1.5-pro
   # GEMINI_MODEL=gemini-pro
   ```

3. Get a free API key at [Google AI Studio](https://aistudio.google.com/app/apikey).  
4. Restart the server (`npm start`). If the key is valid, all three dashboards will use Gemini for chat and voice; if not set or the API fails, they fall back to the built-in local answers.

**Troubleshooting — “Why not using ChatGPT answers?”**  
If you see a message like “only local answers are available” or “AI is not configured”:
- **"Only local answers" / "AI not configured"** — Set **GEMINI_API_KEY** in **.env** and restart the server.
- **"Quota exceeded"** — Check your Gemini API quota at [Google AI Studio](https://aistudio.google.com). The chatbot will use local answers until then.
- **"Invalid or restricted API key"** — Create a new key at [Google AI Studio](https://aistudio.google.com/app/apikey) and update **GEMINI_API_KEY** in `.env`, then restart.

---

## “Powered by GPT-5.2” label

Each dashboard shows **“Powered by GPT-5.2”** in the chatbot/help UI:

- **Student:** Under the “REC EduMate” subtitle in the help panel.  
- **Faculty:** Under the “REC Smart Assist” header in the chat panel.  
- **Leadership:** Under the “REC Insight” header in the chat panel.

The backend now uses **Google Gemini** (set `GEMINI_API_KEY` in `.env`).
