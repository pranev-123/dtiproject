/**
 * Browser Firebase bootstrap. Static pages cannot resolve npm package names like "firebase/app";
 * this module loads the same SDK build from the official CDN. Keep FIREBASE_SDK_VERSION in sync
 * with the `firebase` entry in package.json after upgrades.
 */
const FIREBASE_SDK_VERSION = '12.13.0';

import { initializeApp, getApp, getApps } from `https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-app.js`;
import { getAnalytics, isSupported } from `https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-analytics.js`;

const firebaseConfig = {
  apiKey: 'AIzaSyCAVN1xqD4GlvhVlYVu1kL6lG1HnhPDpVs',
  authDomain: 'recai-4de2c.firebaseapp.com',
  projectId: 'recai-4de2c',
  storageBucket: 'recai-4de2c.firebasestorage.app',
  messagingSenderId: '71603932449',
  appId: '1:71603932449:web:94287d5d608a1d11570260',
  measurementId: 'G-1C3LW9HWEG',
};

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);

let analytics = null;

isSupported()
  .then((ok) => {
    if (ok) analytics = getAnalytics(app);
  })
  .catch(() => {});

export { app, analytics, firebaseConfig };
