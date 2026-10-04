import { useCallback, useEffect, useRef, useState } from "react";
import { SiteHeader } from "@/components/site-header";
import { BUTTON_BASE } from "@/lib/styles";
import { cn } from "@/lib/utils";
import { startTransfer, joinTransfer, type Handle } from "@/webrtc/signaling";
import type { TransferStatus } from "@/webrtc/types";

/**
 * File Transfer page — the UI over `src/webrtc/`.
 *
 * The sender picks a file, gets a share link, and the receiver opens that link
 * on another device.  Firebase carries only signaling metadata; the file bytes
 * travel over the WebRTC DataChannel (see P2P_File_Transfer_Project_Plan.docx).
 */

type Phase =
  | { kind: "home" }
  | { kind: "send-pick" }
  | { kind: "receive-enter" }
  | {
      kind: "session";
      role: "sender" | "receiver";
      transferId: string | null;
      status: TransferStatus;
      progress: number;
      file: { name: string; size: number } | null;
      error: string | null;
      done: boolean;
      shareUrl: string | null;
      /** Receiver only: whether the reassembled file matched the sender's digest. */
      verified: boolean | null;
    };

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${parseFloat((bytes / 1024 ** i).toFixed(1))} ${units[i]}`;
}

/** Read `?t=<transferId>` from the current URL, if present. */
function transferIdFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("t");
}

function statusLabel(status: TransferStatus): string {
  switch (status) {
    case "waiting":
      return "Waiting for the other device…";
    case "connecting":
      return "Connecting…";
    case "connected":
      return "Connected — starting transfer…";
    case "transferring":
      return "Transferring…";
    case "completed":
      return "Transfer complete";
    case "cancelled":
      return "Transfer cancelled";
    case "failed":
      return "Transfer failed";
    case "expired":
      return "Transfer expired";
    default:
      return status;
  }
}

export default function TransferPage() {
  const [phase, setPhase] = useState<Phase>(() =>
    transferIdFromUrl() ? { kind: "receive-enter" } : { kind: "home" },
  );
  const [dragOver, setDragOver] = useState(false);
  const [pickedFile, setPickedFile] = useState<File | null>(null);
  const [linkInput, setLinkInput] = useState("");
  const handleRef = useRef<Handle | null>(null);
  // Stop an in-flight session if the page unmounts.
  useEffect(() => () => handleRef.current?.cancel("Page closed"), []);

  const sessionUpdate = useCallback((patch: Partial<Extract<Phase, { kind: "session" }>>) => {
    setPhase((prev) =>
      prev.kind === "session" ? { ...prev, ...patch } : prev,
    );
  }, []);

  const beginSend = useCallback(
    async (file: File) => {
      setPhase({
        kind: "session",
        role: "sender",
        transferId: null,
        status: "waiting",
        progress: 0,
        file: { name: file.name, size: file.size },
        error: null,
        done: false,
        shareUrl: null,
        verified: null,
      });
      try {
        const handle = await startTransfer(file, {
          onStatus: (status) => sessionUpdate({ status }),
          onProgress: (sent, total) =>
            sessionUpdate({ progress: total ? Math.round((sent / total) * 100) : 0 }),
          onComplete: () => sessionUpdate({ done: true, status: "completed", progress: 100 }),
          onCancelled: () => sessionUpdate({ status: "cancelled", error: "Transfer cancelled." }),
          onError: (message) => sessionUpdate({ status: "failed", error: message }),
        });
        handleRef.current = handle;
        // The link is ready now, even though the other browser has not shown
        // up yet — the handshake runs in the background.
        sessionUpdate({
          transferId: handle.transferId,
          shareUrl: handle.shareUrl,
        });
      } catch (err: unknown) {
        sessionUpdate({
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [sessionUpdate],
  );

  const beginReceive = useCallback(
    async (transferId: string) => {
      setPhase({
        kind: "session",
        role: "receiver",
        transferId,
        status: "connecting",
        progress: 0,
        file: null,
        error: null,
        done: false,
        shareUrl: null,
        verified: null,
      });
      try {
        const handle = await joinTransfer(transferId, {
          onStatus: (status) => sessionUpdate({ status }),
          onProgress: (got, total) =>
            sessionUpdate({ progress: total ? Math.round((got / total) * 100) : 0 }),
          onFileStart: (name, size) => sessionUpdate({ file: { name, size } }),
          onVerified: (ok) => sessionUpdate({ verified: ok }),
          onComplete: () => sessionUpdate({ done: true, status: "completed", progress: 100 }),
          onCancelled: () => sessionUpdate({ status: "cancelled", error: "Transfer cancelled." }),
          onError: (message) => sessionUpdate({ status: "failed", error: message }),
        });
        handleRef.current = handle;
        sessionUpdate({ transferId: handle.transferId });
      } catch (err: unknown) {
        sessionUpdate({
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [sessionUpdate],
  );

  // Auto-join when the page is opened from a share link.
  useEffect(() => {
    if (phase.kind !== "receive-enter") return;
    const id = transferIdFromUrl();
    if (id) void beginReceive(id);
  }, [phase.kind, beginReceive]);

  const cancelSession = useCallback(() => {
    handleRef.current?.cancel("User cancelled");
    handleRef.current = null;
    sessionUpdate({ status: "cancelled", error: "Transfer cancelled." });
  }, [sessionUpdate]);

  return (
    <div className="min-h-[100dvh] bg-background text-foreground">
      <SiteHeader active="transfer" />
      <main className="px-4 pb-16 pt-10 sm:px-6 lg:px-10">
        {phase.kind === "home" && (
          <div className="fade-in">
            <h1 className="text-3xl font-semibold tracking-[-0.02em] sm:text-4xl">
              File Transfer
            </h1>
            <p className="mt-3 max-w-2xl text-[15px] leading-7 text-muted-foreground">
              Send a file straight to another browser over WebRTC. The file never
              touches a server — Firebase only coordinates the connection.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <button
                type="button"
                className={cn(BUTTON_BASE, "h-11 rounded-lg px-6 text-sm font-semibold")}
                onClick={() => setPhase({ kind: "send-pick" })}
              >
                Send a file
              </button>
              <button
                type="button"
                className={cn(BUTTON_BASE, "h-11 rounded-lg px-6 text-sm font-semibold")}
                onClick={() => setPhase({ kind: "receive-enter" })}
              >
                Receive a file
              </button>
            </div>
            <div className="mt-10 rounded-xl border border-border bg-muted/40 p-6">
              <h2 className="text-sm font-semibold text-muted-foreground">How it works</h2>
              <ol className="mt-4 list-inside list-decimal space-y-1 text-sm leading-6 text-muted-foreground">
                <li>Pick a file and create a transfer.</li>
                <li>Copy the share link to the other device.</li>
                <li>The browsers negotiate a direct WebRTC connection.</li>
                <li>The file streams in 64&nbsp;KiB chunks and downloads automatically.</li>
              </ol>
            </div>
          </div>
        )}

        {phase.kind === "send-pick" && (
          <div className="fade-in max-w-3xl">
            <h1 className="text-3xl font-semibold tracking-[-0.02em]">Send a file</h1>
            <p className="mt-3 text-[15px] leading-7 text-muted-foreground">
              Choose a file to create a transfer link.
            </p>
            <div
              className={cn(
                "mt-6 rounded-xl border border-border bg-background p-6",
                dragOver && "border-primary bg-primary/5",
              )}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                const f = e.dataTransfer?.files?.[0];
                if (f) setPickedFile(f);
              }}
            >
              <label className="flex cursor-pointer items-center gap-4 rounded-lg border border-border bg-muted/40 p-4 transition-colors hover:bg-muted/60">
                <span className="text-sm text-muted-foreground">
                  {pickedFile ? pickedFile.name : "Choose a file or drop it here"}
                </span>
                <input
                  type="file"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) setPickedFile(f);
                  }}
                />
              </label>
              {pickedFile && (
                <p className="mt-3 text-sm text-muted-foreground">
                  {formatBytes(pickedFile.size)}
                </p>
              )}
            </div>
            <button
              type="button"
              disabled={!pickedFile}
              className={cn(
                BUTTON_BASE,
                "mt-6 h-11 w-full rounded-lg text-sm font-semibold disabled:opacity-50",
              )}
              onClick={() => pickedFile && void beginSend(pickedFile)}
            >
              Create transfer link
            </button>
          </div>
        )}

        {phase.kind === "receive-enter" && (
          <div className="fade-in max-w-3xl">
            <h1 className="text-3xl font-semibold tracking-[-0.02em]">Receive a file</h1>
            <p className="mt-3 text-[15px] leading-7 text-muted-foreground">
              Paste the share link to accept an incoming file.
            </p>
            <div className="mt-6 flex flex-col gap-3 rounded-xl border border-border bg-background p-4">
              <label htmlFor="share-link" className="text-sm font-medium">
                Share link
              </label>
              <input
                id="share-link"
                type="text"
                value={linkInput}
                onChange={(e) => setLinkInput(e.target.value)}
                placeholder="https://…/transfer?t=…"
                className="h-11 rounded-lg border border-border bg-background px-3 text-sm"
              />
              <button
                type="button"
                className={cn(BUTTON_BASE, "h-11 rounded-lg text-sm font-semibold")}
                onClick={() => {
                  const id =
                    linkInput.match(/[?&]t=([^&\s]+)/)?.[1] ?? linkInput.trim();
                  if (id) void beginReceive(id);
                }}
              >
                Connect
              </button>
            </div>
          </div>
        )}

        {phase.kind === "session" && (
          <div className="fade-in max-w-3xl">
            <h1 className="text-3xl font-semibold tracking-[-0.02em]">
              {phase.role === "sender" ? "Sending file" : "Receiving file"}
            </h1>
            <p className="mt-3 text-[15px] leading-7 text-muted-foreground">
              {statusLabel(phase.status)}
            </p>

            {phase.file && (
              <p className="mt-2 text-sm text-muted-foreground">
                {phase.file.name} · {formatBytes(phase.file.size)}
              </p>
            )}

            <div className="mt-6 h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-[width]"
                style={{ width: `${phase.progress}%` }}
              />
            </div>
            <p className="mt-2 text-xs text-muted-foreground">{phase.progress}%</p>

            {phase.shareUrl && !phase.done && (
              <div className="mt-6 rounded-xl border border-border bg-muted/40 p-4">
                <p className="text-sm font-medium">Share this link</p>
                <div className="mt-2 flex gap-2">
                  <input
                    readOnly
                    value={phase.shareUrl}
                    className="h-10 flex-1 rounded-lg border border-border bg-background px-3 text-xs"
                  />
                  <button
                    type="button"
                    className={cn(BUTTON_BASE, "h-10 rounded-lg px-4 text-sm")}
                    onClick={() => void navigator.clipboard?.writeText(phase.shareUrl ?? "")}
                  >
                    Copy
                  </button>
                </div>
              </div>
            )}

            {phase.error && (
              <p className="mt-6 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                {phase.error}
              </p>
            )}

            {phase.done && (
              <p className="mt-6 rounded-lg border border-border bg-muted/40 p-3 text-sm">
                {phase.role === "receiver"
                  ? phase.verified === true
                    ? "The file was reconstructed, verified against the sender's checksum, and downloaded."
                    : "The file was reconstructed and downloaded."
                  : "The file was delivered."}
              </p>
            )}

            <div className="mt-6 flex gap-3">
              {!phase.done && (
                <button
                  type="button"
                  className={cn(BUTTON_BASE, "h-11 rounded-lg px-5 text-sm")}
                  onClick={cancelSession}
                >
                  Cancel
                </button>
              )}
              <button
                type="button"
                className={cn(BUTTON_BASE, "h-11 rounded-lg px-5 text-sm")}
                onClick={() => setPhase({ kind: "home" })}
              >
                Start over
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
