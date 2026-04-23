# Building an Android APK for REC Classroom Attention

The app is a Progressive Web App (PWA). You can package it as an **Android APK** in two ways.

---

## Option 1: PWA Builder (easiest, no Android SDK)

1. **Deploy your app** to a public **HTTPS** URL (e.g. `https://yourcollege.edu/rec-attention` or a staging server).  
   The APK must point at a real URL; `localhost` will not work.

2. Open **[PWA Builder](https://www.pwabuilder.com/)** in your browser.

3. Enter your app URL (e.g. `https://yourcollege.edu/rec-attention/app`) and click **Start**.

4. When the report is ready, open the **Android** section and click **Package for stores** or **Download** to get the Android package.

5. You get an **AAB** (Android App Bundle) or **APK**. Install the APK on devices or upload the AAB to Google Play.

**Note:** PWA Builder uses Trusted Web Activity (TWA). Your server should serve `/.well-known/assetlinks.json` (see below) so the app can verify ownership when published.

---

## Option 2: Bubblewrap (TWA, for custom package name / signing)

Use this if you want a specific package name (e.g. `com.rajalakshmi.recattention`) or to sign the APK yourself.

### Prerequisites

- **Node.js** (v14+)
- **Java JDK 11**
- **Android SDK** (Android Studio or command-line tools)

### Steps

1. **Install Bubblewrap**
   ```bash
   npm install -g @bubblewrap/cli
   ```

2. **Initialize the TWA project**
   ```bash
   bubblewrap init --manifest https://YOUR-DOMAIN.com/manifest-app.json
   ```
   Use your **HTTPS** app URL. When prompted:
   - **Domain:** your domain (e.g. `yourcollege.edu`)
   - **Package name:** e.g. `com.rajalakshmi.recattention`
   - **App name:** REC Classroom Attention

3. **Build the APK**
   ```bash
   cd rec-classroom-attention  # or the folder name Bubblewrap created
   bubblewrap build
   ```
   The APK is generated in the `app/build/outputs` directory.

4. **Asset links (required for TWA)**  
   So Android trusts your app to open your site, your server must serve Digital Asset Links.  
   See **Asset links** below.

---

## Asset links (for TWA verification)

For Trusted Web Activity, your site must serve:

**URL:** `https://YOUR-DOMAIN.com/.well-known/assetlinks.json`

This project can generate it from environment variables:

- `TWA_PACKAGE_NAME` – Android package name (e.g. `com.rajalakshmi.recattention`)
- `TWA_SHA256_FINGERPRINT` – SHA256 fingerprint of your app signing key (colon-separated, e.g. `AA:BB:CC:...`)

Get the fingerprint from your keystore:
```bash
keytool -list -v -keystore your-release-key.keystore -alias your-alias
```

If these env vars are set, the server serves `assetlinks.json` at `/.well-known/assetlinks.json`.  
Alternatively, put a static `assetlinks.json` file in `public/.well-known/assetlinks.json` (create the `.well-known` folder if needed).

---

## Summary

| Method        | Best for                          | Needs HTTPS? | Needs Android SDK? |
|---------------|-----------------------------------|--------------|---------------------|
| PWA Builder  | Quick APK, minimal setup          | Yes          | No                  |
| Bubblewrap   | Custom package name, own signing  | Yes          | Yes                 |

You **cannot** build an APK that points at `http://localhost`. Deploy the app to an HTTPS URL first, then use PWA Builder or Bubblewrap to generate the APK.
