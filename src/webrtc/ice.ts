/**
 * ICE candidate plumbing shared by the sender and the receiver.
 *
 * The two sides of a transfer publish their candidates under different paths
 * (`senderCandidates` / `receiverCandidates`) but the handling is identical:
 * keep the browser's full candidate — `addIceCandidate` rejects one that has
 * neither `sdpMid` nor `sdpMLineIndex` — and add each candidate exactly once,
 * since `onValue` re-delivers the whole list on every write.
 */
import { db, onValue, ref } from "../firebase/database.ts";
import type { Peer } from "./peer.ts";
import type { StoredCandidate } from "./types.ts";

/** Subscribe to a candidate list and mirror it into the connection. */
export function mirrorRemoteCandidates(
  transferId: string,
  path: "senderCandidates" | "receiverCandidates",
  peer: Peer,
  onError?: (message: string) => void,
): () => void {
  const applied = new Set<string>();

  return onValue(ref(db, `transfers/${transferId}/${path}`), (snap) => {
    const candidates = snap.val() as Record<string, StoredCandidate | null> | null;
    if (!candidates) return;

    for (const [id, stored] of Object.entries(candidates)) {
      if (!stored || !stored.candidate || applied.has(id)) continue;
      applied.add(id);

      // The half-trickled a=candidate line is not a usable peer config.
      if (stored.candidate.endsWith("a=end-of-candidates")) continue;

      peer
        .addIceCandidate({
          candidate: stored.candidate,
          sdpMid: stored.sdpMid,
          sdpMLineIndex: stored.sdpMLineIndex,
        })
        .catch((err: unknown) => {
          onError?.(
            `ICE candidate ${id} failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });
    }
  });
}

/** Serialise a candidate for storage without losing its identifying fields. */
export function toStoredCandidate(candidate: RTCIceCandidate): StoredCandidate {
  return {
    candidate: candidate.candidate,
    sdpMid: candidate.sdpMid,
    sdpMLineIndex: candidate.sdpMLineIndex,
  };
}