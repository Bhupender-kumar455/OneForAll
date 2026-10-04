/**
 * WebRTC signaling layer.
 *
 * Two browsers negotiate a direct connection through the Firebase Realtime
 * Database, then open a DataChannel and stream the file with backpressure:
 *
 *   Sender A                                   Receiver B
 *   createTransferRecord()  -> transfers/{id}
 *   open share link -------------------------->
 *                                              load + adopt receiverUid
 *   createOffer()          -> offer ---------->
 *                                              acceptOffer() -> answer
 *   acceptAnswer()         <- answer ----------
 *   once open: file-start/chunk/file-complete ->  reassemble + download
 */
import { waitForAuthUser } from "../firebase/auth";
import {
  addReceiverCandidate,
  addSenderCandidate,
  createTransferRecord,
  deleteTransfer,
  isConfigured,
  loadTransfer,
  onValue,
  ref,
  update,
  db,
  writeTransferAnswer,
  writeTransferOffer,
  writeTransferStatus,
  type TransferDto,
} from "../firebase/database";
import { mirrorRemoteCandidates, toStoredCandidate } from "./ice";
import { Peer } from "./peer";
import { DataReceiver } from "./receiver";
import { DataSender, type SenderOptions } from "./sender";
import type { TransferFile, TransferId, TransferStatus } from "./types";

export type TransferProgress = {
  onStatus?: (status: TransferStatus) => void;
  onProgress?: (bytesTransferred: number, total: number) => void;
  onComplete?: () => void;
  onCancelled?: (reason: string) => void;
  onError?: (message: string) => void;
  onFileStart?: (name: string, size: number, mime: string) => void;
};

export interface Handle {
  transferId: TransferId;
  status: TransferStatus;
  cancel: (reason?: string) => void;
}

const ANSWER_TIMEOUT_MS = 60_000;
const CONNECTION_TIMEOUT_MS = 60_000;

/**
 * Sender entry point: publish the transfer record, produce the offer, wait for
 * the receiver's answer, then stream the file once the channel opens.
 */
export async function startTransfer(
  file: File,
  handlers: TransferProgress = {},
): Promise<Handle> {
  if (!isConfigured()) {
    throw new Error(
      "Firebase is not configured. Set VITE_FIREBASE_* environment variables to use transfers.",
    );
  }

  const owner = await waitForAuthUser();
  const transferFile: TransferFile = {
    name: file.name,
    size: file.size,
    mime: file.type || "application/octet-stream",
    checksum: await sha256(file),
  };

  const transferId = await createTransferRecord(owner.uid, transferFile);
  const peer = new Peer(
    transferId,
    (candidate) =>
      void addSenderCandidate(transferId, toStoredCandidate(candidate)).catch(() => {}),
    (state) => handlers.onStatus?.(state as TransferStatus),
    (state) => {
      if (state === "connected") handlers.onStatus?.("connected");
      if (state === "failed") handlers.onError?.("The connection failed");
    },
  );

  const channel = peer.createDataChannel();
  const offer = await peer.createOffer();
  if (!offer.sdp) throw new Error("Failed to create a WebRTC offer");
  await writeTransferOffer(transferId, offer.sdp);

  // Wait for the receiver's answer (or a cancellation / timeout).
  const answerSdp = await waitForAnswer(transferId);
  await peer.acceptAnswer({ type: "answer", sdp: answerSdp });

  // Mirror the receiver's ICE candidates into the connection.
  const unsubscribe = mirrorRemoteCandidates(
    transferId,
    "receiverCandidates",
    peer,
    handlers.onError,
  );

  const senderOptions: SenderOptions = {
    onStatus: (status) => handlers.onStatus?.(status as TransferStatus),
    onProgress: handlers.onProgress,
    onComplete: handlers.onComplete,
    onCancelled: handlers.onCancelled,
    onError: handlers.onError,
  };
  const sender = new DataSender(transferId, channel, file, senderOptions);

  // Run asynchronously: the UI should show "waiting" until the channel opens.
  void (async () => {
    try {
      await peer.waitForChannelOpen(channel, CONNECTION_TIMEOUT_MS);
      await writeTransferStatus(transferId, "transferring");
      await sender.sendFile();
    } catch (err: unknown) {
      handlers.onError?.(
        err instanceof Error ? err.message : String(err),
      );
      handlers.onStatus?.("failed");
    }
  })();

  function teardown(reason?: string): void {
    unsubscribe();
    sender.cancel(reason);
    peer.close();
    void deleteTransfer(transferId);
  }

  handlers.onStatus?.("waiting");
  return { transferId, status: "waiting", cancel: teardown };
}

/**
 * Receiver entry point: adopt the transfer, answer the sender's offer and
 * reassemble the incoming file.
 */
export async function joinTransfer(
  transferId: TransferId,
  handlers: TransferProgress = {},
): Promise<Handle> {
  if (!isConfigured()) {
    throw new Error(
      "Firebase is not configured. Set VITE_FIREBASE_* environment variables to use transfers.",
    );
  }

  const receiver = await waitForAuthUser();
  const dto = await loadTransfer(transferId);
  if (!dto) throw new Error("This transfer no longer exists.");
  if (Date.now() > dto.expiresAt) throw new Error("This transfer has expired.");
  if (dto.receiverUid && dto.receiverUid !== receiver.uid) {
    throw new Error("Another receiver already claimed this transfer.");
  }
  const offerSdp = await waitForOffer(transferId, dto);
  if (!offerSdp) throw new Error("The sender never published an offer.");

  const peer = new Peer(
    transferId,
    (candidate) =>
      void addReceiverCandidate(transferId, toStoredCandidate(candidate)).catch(() => {}),
    (state) => handlers.onStatus?.(state as TransferStatus),
    (state) => {
      if (state === "connected") handlers.onStatus?.("connected");
    },
  );

  const answer = await peer.acceptOffer({ type: "offer", sdp: offerSdp });
  if (!answer.sdp) throw new Error("Failed to create a WebRTC answer");
  await writeTransferAnswer(transferId, answer.sdp);
  await update(ref(db, `transfers/${transferId}`), { receiverUid: receiver.uid });

  // Mirror the sender's ICE candidates into the connection.
  const unsubscribe = mirrorRemoteCandidates(
    transferId,
    "senderCandidates",
    peer,
    handlers.onError,
  );

  const channel = await peer.waitForDataChannel(CONNECTION_TIMEOUT_MS);
  const dataReceiver = new DataReceiver(transferId, channel, {
    onStatus: (status) => handlers.onStatus?.(status as TransferStatus),
    onProgress: handlers.onProgress,
    onComplete: (blob, name) => {
      downloadBlob(blob, name);
      handlers.onComplete?.();
    },
    onCancelled: handlers.onCancelled,
    onError: handlers.onError,
    onFileStart: handlers.onFileStart,
  });

  handlers.onStatus?.("waiting");
  return {
    transferId,
    status: "waiting",
    cancel: (reason?: string) => {
      unsubscribe();
      dataReceiver.cancel(reason);
      peer.close();
      void deleteTransfer(transferId);
    },
  };
}

// ── Firebase waiters ────────────────────────────────────────────────────

function waitForAnswer(transferId: TransferId): Promise<string> {
  return new Promise((resolve, reject) => {
    const unsub = onValue(ref(db, `transfers/${transferId}/answer`), (snap) => {
      const answer = snap.val() as string | null;
      if (typeof answer === "string" && answer.length > 0) {
        unsub();
        clearTimeout(timer);
        resolve(answer);
      }
    });
    const timer = setTimeout(() => {
      unsub();
      reject(new Error("The receiver did not answer in time."));
    }, ANSWER_TIMEOUT_MS);
  });
}

function waitForOffer(
  transferId: TransferId,
  dto: TransferDto,
): Promise<string | null> {
  if (dto.offer) return Promise.resolve(dto.offer);
  return new Promise((resolve, reject) => {
    const unsub = onValue(ref(db, `transfers/${transferId}/offer`), (snap) => {
      const offer = snap.val() as string | null;
      if (typeof offer === "string" && offer.length > 0) {
        unsub();
        clearTimeout(timer);
        resolve(offer);
      }
    });
    const timer = setTimeout(() => {
      unsub();
      reject(new Error("The sender did not publish an offer in time."));
    }, ANSWER_TIMEOUT_MS);
  });
}

/** Save a received blob to disk via a temporary object URL. */
function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** SHA-256 hex digest of the whole file, used for integrity verification. */
async function sha256(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
