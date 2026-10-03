/**
 * Anonymous Firebase Authentication.
 *
 * The P2P MVP uses Firebase Anonymous Auth: each browser gets a temporary,
 * unclaimed UID that can read/write only the records it owns.  No account
 * registration is required from the user, which matches the MVP's privacy
 * goal ("create a transfer from a browser without creating an account").
 */
import { getAuth, signInAnonymously } from "firebase/auth";
import { getFirebaseApp } from "./config";

let cachedAuth: ReturnType<typeof getAuth> | null = null;


export function getFirebaseAuth() {
  if (cachedAuth) return cachedAuth;
  cachedAuth = getAuth(getFirebaseApp());
  return cachedAuth;
}

let cachedUser: any = null;

export function waitForAuthUser(): Promise<any> {
  const auth = getFirebaseAuth();
  const current = auth.currentUser;
  if (current) return Promise.resolve(current);

  return new Promise((resolve, reject) => {
    const unsub = auth.onAuthStateChanged((user) => {
      unsub();
      if (user) {
        cachedUser = user;
        resolve(user);
      } else {
        reject(new Error("User signed out before auth resolved"));
      }
    });

    // Trigger a sign-in so we are guaranteed a UID to write with.  This is a
    // no-op when the user is already signed in, and it is the only way to
    // bootstrap an anonymous session in a fresh tab.
    signInAnonymously(auth)
      .then(() => {
        const resolved = auth.currentUser;
        if (resolved) {
          cachedUser = resolved;
          resolve(resolved);
        } else {
          reject(new Error("Auth failed to produce a user"));
        }
      })
      .catch((err) => {
        reject(err);
      });
  });
}

export function signOut() {
  const auth = getFirebaseAuth();
  cachedUser = null;
  return auth.signOut();
}

export function getCachedUser(): any | null {
  return cachedUser;
}
