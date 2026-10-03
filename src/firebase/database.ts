/**
 * Firebase Realtime Database for the P2P transfer layer.
 *
 * Firebase carries ONLY the small signaling and session metadata.  The actual
 * file bytes travel over the WebRTC DataChannel (see `webrtc/`), exactly as
 * the project plan specifies.
 *
 * Data model
 * ----------
 * transfers/{transferId}
 *   ownerUid:     UID of the sender who created the transfer
 *   receiverUid:  UID of the assigned receiver (null until the receiver joins)
 *   file:         { name, size, mime, checksum }  (UI metadata, see 5.2)
 *   status:       waiting | connecting | connected | transferring | completed
 *                 | cancelled | failed | expired
 *   createdAt:    epoch ms
 *   expiresAt:    epoch ms (30-60 min for MVP, see 8.3)
 *   offer:        SDP description (until negotiation completes)
 *   answer:       SDP description
 *   senderCandidates: { [candidateId]: string }
 *   receiverCandidates: { [candidateId]: string }
 *   bytesReceived: number  (transfer metrics, see 5.2)
 */

import { ref, get, set, update, onValue, remove } from "firebase/database";
import { getDatabase } from "firebase/database";
import { getFirebaseApp, isFirebaseConfigured } from "./config";
import type { TransferFile, TransferStatus, TransferId } from "../webrtc/types";

// `getFirebaseApp()` always returns a usable app (it falls back to a
// placeholder when unconfigured), so this handle can be created eagerly.
export const db = getDatabase(getFirebaseApp());
export { ref, onValue, update, get, set, remove } from "firebase/database";

/** Estate of a single transfer (subset of what Firebase stores). */
export interface TransferDto {
  ownerUid: string;
  receiverUid: string | null;
  file: TransferFile;
  status: TransferStatus;
  createdAt: number;
  expiresAt: number;
  offer: string | null;
  answer: string | null;
  senderCandidates: Record<string, string>;
  receiverCandidates: Record<string, string>;
  bytesReceived: number;
}

const EXPIRY_MINUTES = 30;

export function expiryMs(now: number): number {
  return now + EXPIRY_MINUTES * 60_000;
}

export function createTransferDto(
  ownerUid: string,
  file: TransferFile,
): TransferDto {
  const now = Date.now();
  return {
    ownerUid,
    receiverUid: null,
    file,
    status: "waiting",
    createdAt: now,
    expiresAt: expiryMs(now),
    offer: null,
    answer: null,
    senderCandidates: {},
    receiverCandidates: {},
    bytesReceived: 0,
  };
}

export function isTransferExpired(dto: TransferDto): boolean {
  return Date.now() > dto.expiresAt;
}

export function validateTransferFile(file: TransferFile): string | null {
  if (!file.name || file.name.length > 512) {
    return "Invalid file name";
  }
  if (typeof file.size !== "number" || file.size <= 0 || file.size > 1_000_000_000) {
    return "Invalid file size";
  }
  if (!file.mime || file.mime.length > 256) {
    return "Invalid MIME type";
  }
  return null;
}

export function isConfigured() {
  return isFirebaseConfigured();
}

/** Load the current state of a transfer (for the receiver to verify). */
export function loadTransfer(transferId: string): Promise<TransferDto | null> {
  if (!isConfigured()) return Promise.resolve(null);
  return get(ref(db, `transfers/${transferId}`)).then((snap) => {
    const dto = snap.val() as TransferDto | null;
    return dto ? dto : null;
  });
}

/**
 * Create a brand new transfer (the sender side) and return its ID.
 *
 * Rejects immediately when Firebase is unconfigured so the UI can explain
 * that transfers need credentials instead of failing later mid-handshake.
 */
export async function createTransferRecord(
  ownerUid: string,
  file: TransferFile,
): Promise<string> {
  const validationError = validateTransferFile(file);
  if (validationError) throw new Error(validationError);
  if (!isConfigured()) throw new Error("Firebase is not configured");

  const transferId = crypto.randomUUID();
  await writeTransferRecord(transferId, createTransferDto(ownerUid, file));
  return transferId;
}

function writeTransferRecord(transferId: string, dto: TransferDto): Promise<void> {
  return set(ref(db, `transfers/${transferId}`), dto);
}

export function writeTransferStatus(
  transferId: string,
  status: TransferStatus,
): Promise<void> {
  if (!isConfigured()) return Promise.reject(new Error("Firebase not configured"));
  return update(ref(db, `transfers/${transferId}`), { status });
}

export function writeTransferOffer(
  transferId: string,
  offer: string,
): Promise<void> {
  if (!isConfigured()) return Promise.reject(new Error("Firebase not configured"));
  return set(ref(db, `transfers/${transferId}/offer`), offer);
}

export function writeTransferAnswer(
  transferId: string,
  answer: string,
): Promise<void> {
  if (!isConfigured()) return Promise.reject(new Error("Firebase not configured"));
  return set(ref(db, `transfers/${transferId}/answer`), answer);
}

export function addSenderCandidate(
  transferId: string,
  candidateId: string,
  candidate: string,
): Promise<void> {
  if (!isConfigured()) return Promise.reject(new Error("Firebase not configured"));
  return update(ref(db, `transfers/${transferId}/senderCandidates`), {
    [candidateId]: candidate,
  });
}

export function addReceiverCandidate(
  transferId: string,
  candidateId: string,
  candidate: string,
): Promise<void> {
  if (!isConfigured()) return Promise.reject(new Error("Firebase not configured"));
  return update(ref(db, `transfers/${transferId}/receiverCandidates`), {
    [candidateId]: candidate,
  });
}

export function deleteTransfer(transferId: string): Promise<void> {
  if (!isConfigured()) return Promise.resolve();
  return remove(ref(db, `transfers/${transferId}`));
}
