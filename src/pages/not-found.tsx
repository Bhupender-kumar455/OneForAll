import { Link } from "wouter";
import { AlertCircle } from "lucide-react";

import { BUTTON_BASE } from "@/lib/styles";
import { cn } from "@/lib/utils";

export default function NotFound() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4 text-foreground">
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-6">
        <div className="flex items-center gap-2">
          <AlertCircle className="h-5 w-5 text-destructive" />
          <h1 className="text-lg font-semibold tracking-tight">
            Page not found
          </h1>
        </div>
        <p className="mt-3 text-[13px] leading-6 text-muted-foreground">
          That route does not exist. The formatter and the text extractor are
          both one click away.
        </p>
        <div className="mt-4 flex gap-2">
          <Link
            href="/"
            className={cn(
              BUTTON_BASE,
              "h-9 border border-border px-3 hover:bg-muted",
            )}
          >
            Code formatter
          </Link>
          <Link
            href="/extract"
            className={cn(
              BUTTON_BASE,
              "h-9 border border-border px-3 hover:bg-muted",
            )}
          >
            Text extractor
          </Link>
        </div>
      </div>
    </div>
  );
}
