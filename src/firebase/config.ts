/**
 * Firebase app initialization.
 *
 * The app reads its config from environment variables so it can run locally
 * (`VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_APP_ID`, ...) and in production
 * (Vercel / Replit inject these at build time).  If the variables are absent
 * the SDK is initialised with the default offline config and the whole module
 * becomes a no-op, which keeps `pnpm dev`/`pnpm build` working without any
 * Firebase account while you experiment.
 */
import { initializeApp, type FirebaseApp } from "firebase/app";
import type { FirebaseOptions } from "firebase/app";

export interface FirebaseConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  databaseURL: string;
  storageBucket: string;
  messagingSenderId: string;
  appId: string;
}

/**
 * Load the Firebase config from the environment.
 *
 * Each key is referenced statically (`import.meta.env.VITE_...`) because Vite
 * replaces those expressions at build time; a dynamic `import.meta.env[key]`
 * would come back `undefined` in the browser.  Missing values fall back to an
 * empty string, which `isFirebaseConfigured()` treats as "transfers disabled".
 */
export function loadFirebaseConfig(): FirebaseConfig {
  const env = import.meta.env;
  const projectId = env.VITE_FIREBASE_PROJECT_ID ?? "";
  return {
    apiKey: env.VITE_FIREBASE_API_KEY ?? "",
    authDomain: env.VITE_FIREBASE_AUTH_DOMAIN ?? "",
    projectId,
    // `getDatabase()` cannot connect without this, and the SDK does NOT infer
    // it from the project ID. Copy the exact URL from the Firebase console
    // (Realtime Database -> the URL shown above the data tree); it carries the
    // region for databases created outside us-central1. The fallback covers
    // the common `<project>-default-rtdb.firebaseio.com` shape.
    databaseURL:
      env.VITE_FIREBASE_DATABASE_URL ??
      (projectId ? `https://${projectId}-default-rtdb.firebaseio.com` : ""),
    storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET ?? "",
    messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID ?? "",
    appId: env.VITE_FIREBASE_APP_ID ?? "",
  };
}

let cachedApp: FirebaseApp | null = null;

export function getFirebaseApp(): FirebaseApp {
  if (cachedApp) return cachedApp;

  const config = loadFirebaseConfig();

  // Keep the whole module importable/usable when there is no Firebase project
  // configured (local-only dev, `pnpm build` without env vars, etc.).
  if (!config.apiKey || !config.projectId || !config.databaseURL) {
    console.warn(
      "[transfer] Firebase is not configured (missing VITE_FIREBASE_* env vars). " +
        "Transfers are disabled.",
    );
    // Initialise with a placeholder so `getDatabase()` still returns an object
    // and the rest of the app can load.  No reads happen while unconfigured
    // because every entry point checks `isFirebaseConfigured()` first.
    cachedApp = initializeApp(
      { apiKey: "unconfigured", projectId: "unconfigured" },
      "unconfigured",
    );
    return cachedApp;
  }

  cachedApp = initializeApp(config);
  return cachedApp;
}

export function isFirebaseConfigured(): boolean {
  const config = loadFirebaseConfig();
  // The database URL is required: the Realtime Database is the signaling
  // channel, and without it every read/write fails at connect time.
  return Boolean(config.apiKey && config.projectId && config.databaseURL);
}
