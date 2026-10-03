import { Link } from "wouter";

import { BUTTON_BASE } from "@/lib/styles";
import { cn } from "@/lib/utils";

/**
 * The shared shell behind the "Transfer" tab. This MVP is a landing page: the
 * full P2P spec (Firebase signaling + WebRTC DataChannel, send/receive flows,
 * chunked backpressure, progress/speed/cancel) is defined in
 * P2P_File_Transfer_Project_Plan.docx and will be built out behind this tab
 * once the plan is handed to a backend agent.
 */
export default function TransferPage() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-10 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">Transfer</h1>
      <p className="mt-3 text-[13px] leading-6 text-muted-foreground">
        Peer-to-peer file transfer between browsers. This is a work in progress:
        Firebase + WebRTC, one sender and one receiver, chunked transfer with
        backpressure, progress and cancel.
      </p>
      <div className="mt-6 flex justify-center gap-2">
        <Link
          href="/"
          className={cn(BUTTON_BASE, "h-9 border border-border px-3 hover:bg-muted")}
        >
          Code formatter
        </Link>
        <Link
          href="/extract"
          className={cn(BUTTON_BASE, "h-9 border border-border px-3 hover:bg-muted")}
        >
          Text extractor
        </Link>
      </div>
    </div>
  );
}
