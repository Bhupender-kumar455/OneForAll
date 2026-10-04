/**
 * WebRTC signaling layer.
 *
 * Two browsers negotiate a direct connection through the Firebase Realtime
 * Database, then open a DataChannel and stream the file with backpressure:
 *
 *   Sender A                                   Receiver B
 *   createTransferRecord()  -> transfers/{id}   (+ the offer; the share link
 *                                                 is available immediately)
 *   open share link -------------------------->
 *                                               load + claim the transfer
 *   acceptAnswer()         <- answer ----------  acceptOffer()
 *   once open: file-start/chunk/file-complete ->  reassemble + download
 *
 * IMPORTANT: `startTransfer` and `joinTransfer` return as soon as the session
 * exists.  They must NOT wait for the peer to show up — the sender is how the
 * other side is invited at all, so blocking on the answer would deadlock the
 * UI.  The handshake runs in the background and reports through the handlers.
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
import { sha256Blob, sha256File } from "./checksum";
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
  /**
   * The receiver checked the file it reassembled against the digest the
   * sender published.  `expected` is undefined for older records that predate
   * checksums, in which case the digest could not be confirmed either way.
   */
  onVerified?: (ok: boolean, actual: string, expected?: string) => void;
};

export interface Handle {
  transferId: TransferId;
  /** The URL the other device opens. Only the sender has one. */
  shareUrl: string | null;
  cancel: (reason?: string) => void;
}

/** How long to wait for the other browser before giving up. */
const PEER_TIMEOUT_MS = 5 * 60_000;
const CONNECTION_TIMEOUT_MS = 60_000;

/**
 * Sender entry point.  Publishes the record and the offer, then returns the
 * share link straight away; the answer/ICE/transfer happen in the background.
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
    checksum: await sha256File(file),
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

  const senderOptions: SenderOptions = {
    onStatus: (status) => handlers.onStatus?.(status as TransferStatus),
    onProgress: handlers.onProgress,
    onComplete: handlers.onComplete,
    onCancelled: handlers.onCancelled,
    onError: handlers.onError,
  };
  const sender = new DataSender(transferId, channel, file, senderOptions);

  let cancelled = false;
  let unsubscribe: (() => void) | null = null;

  const teardown = (reason?: string): void => {
    if (cancelled) return;
    cancelled = true;
    unsubscribe?.();
    sender.cancel(reason);
    peer.close();
    void deleteTransfer(transferId);
  };

  // Background handshake.  The share link is already usable by the time the
  // caller renders it, so everything below is allowed to take minutes.
  void (async () => {
    try {
      const answerSdp = await waitForAnswer(transferId, PEER_TIMEOUT_MS, () => cancelled);
      if (cancelled) return;

      await peer.acceptAnswer({ type: "answer", sdp: answerSdp });
      unsubscribe = mirrorRemoteCandidates(
        transferId,
        "receiverCandidates",
        peer,
        handlers.onError,
      );

      await peer.waitForChannelOpen(channel, CONNECTION_TIMEOUT_MS);
      if (cancelled) return;

      await writeTransferStatus(transferId, "transferring");
      await sender.sendFile();
      // Reach a terminal state so the record does not look in-flight forever.
      if (!cancelled && !sender.isCancelled) {
        void writeTransferStatus(transferId, "completed").catch(() => {});
      }
    } catch (err: unknown) {
      if (cancelled) return;
      handlers.onError?.(err instanceof Error ? err.message : String(err));
      handlers.onStatus?.("failed");
    }
  })();

  handlers.onStatus?.("waiting");
  return { transferId, shareUrl: shareUrlFor(transferId), cancel: teardown };
}

/**
 * Receiver entry point.  Claims the transfer, answers the offer, and resolves
 * once the sender's channel has arrived.  Waiting here is safe because the
 * sender is already open in someone else's browser.
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

  const offerSdp = await waitForOffer(transferId, dto, PEER_TIMEOUT_MS);
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

  // Claim the slot before answering so a second tab cannot take it too.
  await update(ref(db, `transfers/${transferId}`), { receiverUid: receiver.uid });
  const answer = await peer.acceptOffer({ type: "offer", sdp: offerSdp });
  if (!answer.sdp) throw new Error("Failed to create a WebRTC answer");
  await writeTransferAnswer(transferId, answer.sdp);

  const unsubscribe = mirrorRemoteCandidates(
    transferId,
    "senderCandidates",
    peer,
    handlers.onError,
  );

  const channel = await peer.waitForDataChannel(CONNECTION_TIMEOUT_MS);
  const expected = dto.file.checksum;

  const dataReceiver = new DataReceiver(transferId, channel, {
    onStatus: (status) => handlers.onStatus?.(status as TransferStatus),
    onProgress: handlers.onProgress,
    onCancelled: handlers.onCancelled,
    onError: handlers.onError,
    onFileStart: handlers.onFileStart,
    onComplete: (blob, name) => {
      // Verify before handing the file over: a corrupted transfer must not be
      // saved as if it were good.
      void (async () => {
        const actual = await sha256Blob(blob);
        const ok = expected ? actual === expected : true;
        handlers.onVerified?.(ok, actual, expected);

        if (!ok) {
          handlers.onError?.(
            "The received file failed its integrity check and was not saved.",
          );
          handlers.onStatus?.("failed");
          return;
        }

        downloadBlob(blob, name);
        void writeTransferStatus(transferId, "completed").catch(() => {});
        handlers.onComplete?.();
      })();
    },
  });

  handlers.onStatus?.("waiting");
  return {
    transferId,
    shareUrl: null,
    cancel: (reason?: string) => {
      unsubscribe();
      dataReceiver.cancel(reason);
      peer.close();
      void deleteTransfer(transferId);
    },
  };
}

// ── Firebase waiters ────────────────────────────────────────────────────

/** Poll for a value that the other browser may not have written yet. */
function waitForValue(
  transferId: TransferId,
  path: "offer" | "answer",
  timeoutMs: number,
  isCancelled?: () => boolean,
): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    let poll: ReturnType<typeof setInterval> | undefined;

    // `finish` only ever runs from a callback or timer below, so `timer` and
    // `unsubscribe` are always assigned by the time it is called.
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (poll) clearInterval(poll);
      unsubscribe();
      resolve(value);
    };

    const unsubscribe = onValue(ref(db, `transfers/${transferId}/${path}`), (snap) => {
      const value = snap.val() as string | null;
      if (typeof value === "string" && value.length > 0) finish(value);
    });

    const timer = setTimeout(() => finish(null), timeoutMs);

    // Stop waiting early when the user cancels the session.
    if (isCancelled) {
      poll = setInterval(() => {
        if (isCancelled()) finish(null);
      }, 500);
    }
  });
}

function waitForAnswer(
  transferId: TransferId,
  timeoutMs: number,
  isCancelled?: () => boolean,
): Promise<string> {
  return waitForValue(transferId, "answer", timeoutMs, isCancelled).then((value) => {
    if (value) return value;
    throw new Error(
      isCancelled?.()
        ? "The transfer was cancelled."
        : "The other device never connected. The link may have expired.",
    );
  });
}

function waitForOffer(
  transferId: TransferId,
  dto: TransferDto,
  timeoutMs: number,
): Promise<string | null> {
  if (dto.offer) return Promise.resolve(dto.offer);
  return waitForValue(transferId, "offer", timeoutMs);
}

/** The URL the receiver opens; mirrors the route in `App.tsx`. */
function shareUrlFor(transferId: TransferId): string {
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  return `${window.location.origin}${base}/transfer?t=${transferId}`;
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