/*
 * DsignX Ops — Firebase settings.
 *
 * Copy these values from the Firebase console:
 *   Project settings (gear icon) → General → Your apps → Web app → SDK setup and configuration → Config.
 *
 * These values identify your Firebase project; they are not secret. Access to data is
 * protected by firestore.rules and by each person's sign-in. Never put the Bird or
 * Cloudinary keys in this file — they belong on the server (see SETUP_GUIDE.md).
 *
 * While apiKey is empty, the app runs in demo mode with sample data.
 * Filled in for the dsignx-ops Firebase project.
 */
window.DSX_CONFIG = {
  firebase: {
    apiKey: "AIzaSyC2mjCSo8k4epirC8DqcWq-1W74a0PBvyg",
    authDomain: "dsignx-ops.firebaseapp.com",
    projectId: "dsignx-ops",
    storageBucket: "dsignx-ops.firebasestorage.app",
    messagingSenderId: "296122930173",
    appId: "1:296122930173:web:54e198afd60c402e813f94"
  },

  // Region the Cloud Functions are deployed to. Must match functions/index.js.
  functionsRegion: "europe-west1",

  // The one email address allowed to complete first-time owner setup.
  // Must match OWNER_EMAIL in firestore.rules.
  ownerEmail: "estelle@dsignx.co.za"
};
