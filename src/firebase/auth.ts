/**
 * Anonymous Firebase Authentication.
 *
 * The P2P MVP uses Firebase Anonymous Auth: each browser gets a temporary,
 * unclaimed UID that can read/write only the records it owns.  No account
 * registration is required from the user, which matches the MVP's privacy
 * goal ("create a transfer from a browser without creating an account").
 */
import { getAuth, signInAnonymously, type Auth, type User } from "firebase/auth";
import { getFirebaseApp } from "./config";

let cachedAuth: Auth | null = null;

export function getFirebaseAuth(): Auth {
  if (cachedAuth) return cachedAuth;
  cachedAuth = getAuth(getFirebaseApp());
  return cachedAuth;
}

let cachedUser: User | null = null;
let pending: Promise<User> | null = null;

/**
 * Resolve to a signed-in user, signing in anonymously if necessary.
 *
 * If the anonymous provider is not enabled in the Firebase console, or the
 * `authDomain` is missing from the config, the SDK rejects this quickly and
 * the reason surfaces to the caller as the transfer's error message.
 *
 * The promise is cached so several callers (the sender and the receiver both
 * ask) trigger only one sign-in.
 */
export function waitForAuthUser(): Promise<User> {
  const existing = cachedUser ?? getFirebaseAuth().currentUser;
  if (existing) {
    cachedUser = existing;
    return Promise.resolve(existing);
  }
  if (!pending) {
    pending = signInAnonymously(getFirebaseAuth())
      .then((credential) => {
        cachedUser = credential.user;
        return credential.user;
      })
      .catch((err: unknown) => {
        // Let a later attempt retry rather than caching the failure forever.
        pending = null;
        throw err;
      });
  }
  return pending;
}

export function signOut(): Promise<void> {
  const auth = getFirebaseAuth();
  cachedUser = null;
  pending = null;
  return auth.signOut();
}

export function getCachedUser(): User | null {
  return cachedUser;
}