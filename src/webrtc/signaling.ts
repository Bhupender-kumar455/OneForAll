/**
 * WebRTC signaling layer.
 *
 * Two browsers negotiate a direct connection through the Firebase Realtime
 * Database, then open a DataChannel and stream the file with backpressure:
 *
 *   Sender A                                   Receiver B
 *   createTransferRecord()  -> transfers/{id}   (+ the offer; the share link
 *                                                 is available immediately)
 *   open share link -------------------------->  load + claim the transfer
 *                                               acceptOffer()
 *   acceptAnswer()         <- answer ----------
 *   once open: file-start/chunk/file-complete -> reassemble + download
 *
 * A dropped connection is recovered instead of restarted.  Each negotiation is
 * a numbered round: the sender whose channel died publishes a fresh offer,
 * the receiver answers it on a new peer connection, and the receiver then tells
 * the sender exactly which byte ranges it is still missing (see `sender.ts` /
 * `receiver.ts`).  Only those ranges cross the wire.
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
  /** The receiver checked every chunk against the digest it was sent with. */
  onVerified?: (ok: boolean) => void;
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
 * Resume rounds are renegotiations after a drop, so they are much shorter than
 * the first-peer wait: both browsers are already sitting on the page.
 */
const RESUME_TIMEOUT_MS = 30_000;

/** How many times the connection is rebuilt before the transfer is failed. */
const MAX_RESUME_ROUNDS = 3;

/** How many renegotiation windows the receiver waits through per round. */
const RESUME_OFFER_ATTEMPTS = 2;

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
  // No read of the file here: the share link appears immediately, and the
  // integrity data is produced per chunk while the transfer runs.
  const transferFile: TransferFile = {
    name: file.name,
    size: file.size,
    mime: file.type || "application/octet-stream",
  };

  const transferId = await createTransferRecord(owner.uid, transferFile);

  const senderOptions: SenderOptions = {
    onStatus: (status) => handlers.onStatus?.(status as TransferStatus),
    onProgress: handlers.onProgress,
    onComplete: handlers.onComplete,
    onCancelled: handlers.onCancelled,
    onError: handlers.onError,
  };

  let cancelled = false;
  let unsubscribe: (() => void) | null = null;
  // A holder rather than plain `let`: control-flow analysis would otherwise
  // freeze these at their initial `null` inside the closures below.
  const session: { peer: Peer | null; sender: DataSender | null } = {
    peer: null,
    sender: null,
  };

  const teardown = (reason?: string): void => {
    if (cancelled) return;
    cancelled = true;
    unsubscribe?.();
    session.sender?.cancel(reason);
    session.peer?.close();
    void deleteTransfer(transferId);
  };

  // Background handshake.  The share link is already usable by the time the
  // caller renders it, so everything below is allowed to take minutes.
  void (async () => {
    try {
      // The answer from the previous round, so a resume waits for a *new* one
      // rather than accepting the stale description still in the record.
      let previousAnswer: string | null = null;

      for (let round = 0; round <= MAX_RESUME_ROUNDS; round += 1) {
        if (cancelled) return;

        const peer = buildPeer(transferId, "sender", round, handlers);
        session.peer = peer;
        const channel = peer.createDataChannel();
        const offer = await peer.createOffer();
        if (!offer.sdp) throw new Error("Failed to create a WebRTC offer");
        await writeTransferOffer(transferId, offer.sdp);

        const answerSdp: string =
          previousAnswer === null
            ? await waitForAnswer(transferId, PEER_TIMEOUT_MS, () => cancelled)
            : await waitForAnswerChange(
                transferId,
                previousAnswer,
                RESUME_TIMEOUT_MS,
                () => cancelled,
              );
        if (cancelled) return;
        previousAnswer = answerSdp;

        await peer.acceptAnswer({ type: "answer", sdp: answerSdp });
        unsubscribe?.();
        unsubscribe = mirrorRemoteCandidates(
          transferId,
          "receiverCandidates",
          round,
          peer,
          handlers.onError,
        );

        await peer.waitForChannelOpen(channel, CONNECTION_TIMEOUT_MS);
        if (cancelled) return;

        const attempt = new DataSender(transferId, channel, file, senderOptions);
        session.sender = attempt;

        if (round === 0) {
          await writeTransferStatus(transferId, "transferring");
          await attempt.sendFile();
        } else {
          await attempt.resumeStream();
        }

        if (cancelled) return;
        if (attempt.isCancelled) {
          void writeTransferStatus(transferId, "cancelled").catch(() => {});
          return;
        }
        if (attempt.completed) {
          // Reach a terminal state so the record does not look in-flight forever.
          void writeTransferStatus(transferId, "completed").catch(() => {});
          return;
        }
        // Interrupted: rebuild the connection and let the receiver hand back
        // the ranges it is missing. The channel is already dead, so the old
        // peer is closed before the next round negotiates a fresh one.
        peer.close();
      }

      handlers.onError?.("The connection kept dropping, so the file was not fully delivered.");
      handlers.onStatus?.("failed");
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

  const firstOffer = await waitForOffer(transferId, dto, PEER_TIMEOUT_MS);
  if (!firstOffer) throw new Error("The sender never published an offer.");

  // Claim the slot before answering so a second tab cannot take it too.
  await update(ref(db, `transfers/${transferId}`), { receiverUid: receiver.uid });

  let cancelled = false;
  let round = 0;
  let currentOffer = firstOffer;
  let unsubscribe: (() => void) | null = null;
  const session: { peer: Peer | null } = { peer: null };

  const receiverFor = (attempt: number): Peer => {
    const built = buildPeer(transferId, "receiver", attempt, handlers);
    session.peer = built;
    return built;
  };

  const firstPeer = receiverFor(0);
  const answer = await firstPeer.acceptOffer({ type: "offer", sdp: firstOffer });
  if (!answer.sdp) throw new Error("Failed to create a WebRTC answer");
  await writeTransferAnswer(transferId, answer.sdp);

  unsubscribe = mirrorRemoteCandidates(
    transferId,
    "senderCandidates",
    round,
    firstPeer,
    handlers.onError,
  );

  const channel = await firstPeer.waitForDataChannel(CONNECTION_TIMEOUT_MS);

  const dataReceiver = new DataReceiver(transferId, channel, {
    onStatus: (status) => handlers.onStatus?.(status as TransferStatus),
    onProgress: handlers.onProgress,
    onCancelled: handlers.onCancelled,
    onError: handlers.onError,
    onFileStart: handlers.onFileStart,
    // The receiver checks each arriving chunk against its digest and stops on
    // a mismatch, so a corrupt file is never saved.
    onVerified: handlers.onVerified,
    onComplete: (blob, name) => {
      downloadBlob(blob, name);
      void writeTransferStatus(transferId, "completed").catch(() => {});
      handlers.onComplete?.();
      // The bytes are on disk/downloaded now; free the scratch entry.
      void dataReceiver.dispose();
    },
  });

  // Keep the session alive across drops.  The receiver owns the reassembly
  // state, so it is the side that knows which offsets are still missing, and
  // it stays attached to the same `DataReceiver` for the whole transfer.
  void (async () => {
    try {
      for (;;) {
        const ranges = await dataReceiver.waitForInterruption();
        // `null` means the file arrived or the session ended; nothing to resume.
        if (cancelled || ranges === null) return;

        if (round >= MAX_RESUME_ROUNDS) {
          handlers.onError?.("The connection kept dropping, so the file was not fully received.");
          handlers.onStatus?.("failed");
          return;
        }

        let nextOffer: string | null = null;
        for (
          let attempt = 0;
          attempt < RESUME_OFFER_ATTEMPTS && !nextOffer && !cancelled;
          attempt += 1
        ) {
          nextOffer = await waitForValueChange(
            transferId,
            "offer",
            currentOffer,
            RESUME_TIMEOUT_MS,
            () => cancelled,
          );
        }
        if (cancelled) return;
        if (!nextOffer) {
          handlers.onError?.("The sender did not reconnect, so the transfer could not resume.");
          handlers.onStatus?.("failed");
          return;
        }

        currentOffer = nextOffer;
        round += 1;
        unsubscribe?.();
        session.peer?.close();

        const nextPeer = receiverFor(round);
        const nextAnswer = await nextPeer.acceptOffer({ type: "offer", sdp: nextOffer });
        if (!nextAnswer.sdp) throw new Error("Failed to create a WebRTC answer");
        await writeTransferAnswer(transferId, nextAnswer.sdp);
        unsubscribe = mirrorRemoteCandidates(
          transferId,
          "senderCandidates",
          round,
          nextPeer,
          handlers.onError,
        );

        const nextChannel = await nextPeer.waitForDataChannel(CONNECTION_TIMEOUT_MS);
        // Rebinding keeps `seen`, the sink and the byte count intact, so the
        // request below lists only what is genuinely missing.
        dataReceiver.attach(nextChannel);
        dataReceiver.requestResume();
      }
    } catch (err: unknown) {
      if (cancelled) return;
      handlers.onError?.(err instanceof Error ? err.message : String(err));
      handlers.onStatus?.("failed");
    }
  })();

  handlers.onStatus?.("waiting");
  return {
    transferId,
    shareUrl: null,
    cancel: (reason?: string) => {
      cancelled = true;
      unsubscribe?.();
      dataReceiver.cancel(reason);
      session.peer?.close();
      void deleteTransfer(transferId);
    },
  };
}

// ── Peer construction ───────────────────────────────────────────────────

/**
 * Build the peer for one negotiation round.  The round number is part of the
 * candidate paths, so candidates from an earlier round are never replayed into
 * a connection whose SDP they do not belong to.
 */
function buildPeer(
  transferId: TransferId,
  role: "sender" | "receiver",
  round: number,
  handlers: TransferProgress,
): Peer {
  const publish = role === "sender" ? addSenderCandidate : addReceiverCandidate;
  return new Peer(
    transferId,
    (candidate) => void publish(transferId, toStoredCandidate(candidate), round).catch(() => {}),
    (state) => handlers.onStatus?.(state as TransferStatus),
    (state) => {
      if (state === "connected") handlers.onStatus?.("connected");
      // Only the opening round reports a failure directly: a later round exists
      // precisely to recover from one, and the loop owns the outcome there.
      if (state === "failed" && round === 0 && role === "sender") {
        handlers.onError?.("The connection failed");
      }
    },
  );
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

/**
 * Wait for a *different* value than the one already known.
 *
 * Resume reuses the same `offer`/`answer` nodes, so the previous round's
 * description is still there when the new round begins.  Treating that stale
 * value as the new one would apply a description the fresh peer connection
 * never saw.
 */
function waitForValueChange(
  transferId: TransferId,
  path: "offer" | "answer",
  previous: string,
  timeoutMs: number,
  isCancelled?: () => boolean,
): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    let poll: ReturnType<typeof setInterval> | undefined;

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
      if (typeof value === "string" && value.length > 0 && value !== previous) finish(value);
    });

    const timer = setTimeout(() => finish(null), timeoutMs);

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

function waitForAnswerChange(
  transferId: TransferId,
  previous: string,
  timeoutMs: number,
  isCancelled?: () => boolean,
): Promise<string> {
  return waitForValueChange(transferId, "answer", previous, timeoutMs, isCancelled).then(
    (value) => {
      if (value) return value;
      throw new Error(
        isCancelled?.()
          ? "The transfer was cancelled."
          : "The other device did not reconnect in time.",
      );
    },
  );
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
