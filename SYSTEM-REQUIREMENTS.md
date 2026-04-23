## System Requirements – REC AI Classroom Dashboards

This document lists the recommended system requirements for running and using the REC AI Classroom Attention dashboards (Faculty, Student, Leadership).

---

### 1. Faculty & Leadership Dashboards (Teacher / HoD / Principal devices)

**Use case:** Running the Faculty Dashboard and Leadership Dashboard in a browser with live video, attention graphs, and AI assistant.

- **Processor**
  - **Minimum:** Intel Core i3 (8th gen or newer) or AMD Ryzen 3
  - **Recommended:** **Intel Core i5 (8th gen or newer)** or AMD Ryzen 5  
    Better for running browser, video, and screen sharing together.

- **Memory (RAM)**
  - Minimum: 8 GB
  - Recommended: **16 GB** for smooth performance with multiple tabs and apps.

- **Operating System**
  - Windows 10 / 11 (64‑bit)
  - macOS 11 (Big Sur) or later
  - Recent Linux distribution (e.g. Ubuntu 20.04+)

- **Web Browser**
  - Recommended: Latest **Google Chrome** or **Microsoft Edge (Chromium)**
  - Alternative: Firefox (supported but not primary target)
  - Ensure camera and microphone permissions are allowed.

- **Network**
  - Stable broadband connection
  - Recommended: **≥ 10 Mbps download / 5 Mbps upload** per classroom device

- **Display**
  - 1080p or higher resolution recommended  
  - Helps view Live Pulse, trend graph, Smart Attendance, and reports clearly.

---

### 2. Student Devices (Camera & Attention Streaming)

**Use case:** Students joining from their own device, sharing camera to the Faculty Dashboard.

- **Processor**
  - Works on Intel Core i3 and above; for best experience, **Intel Core i5** or equivalent.
  - Modern Android / iOS devices also supported (depending on college policy).

- **Memory (RAM)**
  - Minimum: 4 GB (Chromebooks / entry‑level laptops)
  - Recommended: 8 GB on Windows / macOS laptops

- **Devices**
  - Laptops / desktops with built‑in or USB webcam
  - Android phones (Chrome) and iOS devices (Safari/Chrome), if allowed

- **Web Browser**
  - Latest version of:
    - **Google Chrome** (recommended)
    - **Microsoft Edge**
    - **Safari** (for iOS / macOS)
  - Camera and microphone permissions must be enabled.

- **Network**
  - Minimum: **5 Mbps download / 2 Mbps upload** per student for stable camera streaming
  - Wi‑Fi or wired Ethernet strongly recommended inside campus

- **Camera**
  - At least **720p** resolution
  - Good lighting and clear view of the student’s face improve attention accuracy.

---

### 3. Application Server (Node.js Backend)

**Use case:** Hosting the REC AI dashboards (Node.js + WebSocket + AI integration).

- **Processor**
  - Minimum: Intel Core i3 / Ryzen 3
  - Recommended: **Intel Core i5 (quad‑core or better)** or Ryzen 5  
    Especially if multiple classes and dashboards connect simultaneously.

- **Memory (RAM)**
  - Minimum: 4 GB
  - Recommended: **8 GB or more**

- **Storage**
  - At least **20 GB free** for Node.js runtime, logs, PDF reports, and basic data.

- **Operating System**
  - Windows 10 / 11
  - Or Linux server (Ubuntu 20.04+ / Debian 11+)

- **Software**
  - **Node.js** 18 or newer (project currently tested with Node 24)
  - **npm** 8 or newer
  - SMTP access (optional) for sending session report emails

- **Network**
  - Reliable internet connection for:
    - AI API calls (Gemini / Claude)
    - Student camera WebRTC signaling
    - Leadership / faculty dashboards

---

### 4. Optional Infrastructure (Recommended for Production)

- **HTTPS reverse proxy** (Nginx / Apache / IIS) for:
  - TLS termination (https://)
  - Load balancing and static file caching
- **Database server** (if moving beyond JSON file storage)
- **Monitoring & Logs**
  - Centralised log collection (e.g. ELK, CloudWatch)
  - Basic CPU / memory / disk monitoring

---

### Summary

- **Intel Core i5 + 8–16 GB RAM** is a good target for both the **faculty device** and the **Node.js server**.
- Students can run on modest hardware (i3 + 4–8 GB) with a modern browser and stable Wi‑Fi.
- Chrome/Edge + good lighting + stable network have more impact on user experience than raw CPU alone.

