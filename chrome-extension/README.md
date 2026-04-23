# REC Classroom Attention – Chrome Extension

Quick access to the REC AI Classroom Attention System from your browser toolbar.

## What it does

- **Student Dashboard** – Open the student view in one click
- **Faculty Dashboard** – Open the faculty dashboard (login if required)
- **Leadership Dashboard** – Open the leadership overview
- **Leadership Login** – Open the leadership login page

You can set the **Server URL** in the popup (default: `http://localhost:3000`). Use your college server URL when not running locally.

## How to install (unpacked)

1. Open Chrome and go to `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `chrome-extension` folder inside this project

## Optional: custom icon

To use the REC logo as the extension icon:

1. Add PNGs in an `icons` folder: `icon16.png`, `icon48.png`, `icon128.png` (16×16, 48×48, 128×128).
2. In `manifest.json`, add under `"action"`:  
   `"default_icon": { "16": "icons/icon16.png", "48": "icons/icon48.png", "128": "icons/icon128.png" }`  
   and add `"icons": { "16": "icons/icon16.png", "48": "icons/icon48.png", "128": "icons/icon128.png" }`.

You can resize `public/rec-logo.jpg` to create these sizes.
