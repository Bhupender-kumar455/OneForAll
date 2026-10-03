import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  Copy,
  Download,
  FileImage,
  Loader2,
  ScanText,
  Trash2,
  Upload,
} from "lucide-react";

import { Panel } from "@/components/panel";
import { SiteHeader } from "@/components/site-header";
import { formatBytes } from "@/lib/bytes";
import type { OcrClient, OcrProgress } from "@/lib/ocr/ocr";
import { BUTTON_BASE } from "@/lib/styles";
import { cn } from "@/lib/utils";

/** Images above this size are refused: recognition would stall the tab for minutes. */
const MAX_IMAGE_BYTES = 25_000_000;

/** Curated subset of Tesseract's data files; English is the default. */
const OCR_LANGUAGES = [
  { code: "eng", label: "English" },
  { code: "spa", label: "Spanish" },
  { code: "fra", label: "French" },
  { code: "deu", label: "German" },
  { code: "ita", label: "Italian" },
  { code: "por", label: "Portuguese" },
  { code: "nld", label: "Dutch" },
  { code: "rus", label: "Russian" },
  { code: "ara", label: "Arabic" },
  { code: "hin", label: "Hindi" },
  { code: "chi_sim", label: "Chinese (Simplified)" },
  { code: "chi_tra", label: "Chinese (Traditional)" },
  { code: "jpn", label: "Japanese" },
  { code: "kor", label: "Korean" },
];

/** Turns Tesseract's stage names into something a person would read. */
function progressLabel(status: string): string {
  switch (status) {
    case "loading tesseract core":
      return "Loading OCR engine";
    case "initializing tesseract":
      return "Starting engine";
    case "loading language traineddata":
      return "Downloading language data";
    case "initializing api":
      return "Preparing recognition";
    case "recognizing text":
      return "Reading text";
    default:
      return status;
  }
}


export default function TextExtractor() {
  const [imageBlob, setImageBlob] = useState<Blob | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imageName, setImageName] = useState("");
  const [language, setLanguage] = useState("eng");

  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<OcrProgress | null>(null);
  const [text, setText] = useState("");
  const [confidence, setConfidence] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tooLarge, setTooLarge] = useState(false);

  const [dragging, setDragging] = useState(false);
  const [copied, setCopied] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const [nonce, setNonce] = useState(0);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const clientRef = useRef<OcrClient | null>(null);
  const runId = useRef(0);

  const loadImage = useCallback((blob: Blob, name: string) => {
    setImageUrl((previous) => {
      if (previous) URL.revokeObjectURL(previous);
      return URL.createObjectURL(blob);
    });
    setTooLarge(false);
    setImageBlob(blob);
    setImageName(name);
    setText("");
    setConfidence(null);
    setError(null);
  }, []);

  const handleFile = useCallback(
    (file: File) => {
      setTooLarge(file.size > MAX_IMAGE_BYTES);
      loadImage(file, file.name);
    },
    [loadImage],
  );

  // Clipboard images (e.g. a screenshot tool that only copies) are handled the
  // same as a file drop.
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const items = event.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) {
            event.preventDefault();
            handleFile(file);
            return;
          }
        }
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [handleFile]);

  // Recognition runs whenever a new image arrives, the language changes, or the
  // user hits Re-run. A newer run supersedes the one in flight.
  useEffect(() => {
    if (!imageBlob || tooLarge) return;
    const id = (runId.current += 1);
    let cancelled = false;

    setBusy(true);
    setError(null);
    setText("");
    setConfidence(null);
    setProgress(null);

    void (async () => {
      try {
        // Loaded on demand so Tesseract stays out of the initial bundle.
        const { OcrClient } = await import("@/lib/ocr/ocr");
        if (!clientRef.current) clientRef.current = new OcrClient();
        const client = clientRef.current;
        client.setProgressHandler((next) => {
          if (!cancelled && id === runId.current) setProgress(next);
        });

        const result = await client.recognize(imageBlob, language);
        if (cancelled || id !== runId.current) return;
        setText(result.text);
        setConfidence(result.confidence);
        setBusy(false);
      } catch (cause: unknown) {
        if (cancelled || id !== runId.current) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setBusy(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [imageBlob, language, nonce, tooLarge]);

  // Release the worker (and its loaded language data) when leaving the page.
  useEffect(
    () => () => {
      void clientRef.current?.dispose();
      clientRef.current = null;
    },
    [],
  );

  const stats = useMemo(() => {
    const bytes = new TextEncoder().encode(text).length;
    const lines = text ? text.replace(/\n$/, "").split("\n").length : 0;
    return { chars: text.length, lines, bytes };
  }, [text]);

  const clear = () => {
    setImageUrl((previous) => {
      if (previous) URL.revokeObjectURL(previous);
      return null;
    });
    setImageBlob(null);
    setImageName("");
    setText("");
    setConfidence(null);
    setError(null);
    setTooLarge(false);
  };

  const handleCopy = async () => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard unavailable */
    }
  };

  const handleDownload = () => {
    if (!text) return;
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = imageName.replace(/\.[^.]+$/, "") + ".txt" || "extracted.txt";
    anchor.click();
    URL.revokeObjectURL(url);
    setDownloaded(true);
    window.setTimeout(() => setDownloaded(false), 1600);
  };

  const percent = Math.round((progress?.progress ?? 0) * 100);

  return (
    <div className="min-h-[100dvh] bg-background text-foreground">
      <SiteHeader active="extract" />

      <main className="px-4 pb-16 pt-10 sm:px-6 lg:px-10">
        <div className="fade-in">
          <h1 className="text-3xl font-semibold tracking-[-0.02em] sm:text-4xl">
            Text Extractor
          </h1>
          <p className="mt-3 max-w-2xl text-[15px] leading-7 text-muted-foreground">
            Drop an image or paste a screenshot to read the text inside it. Optical
            character recognition runs in your browser — your image is never
            uploaded.
          </p>
        </div>

        {/* Controls */}
        <div className="mt-8 flex flex-wrap items-end gap-x-6 gap-y-4 rounded-lg border border-border bg-card p-4">
          <label className="flex items-center gap-2">
            <span className="whitespace-nowrap font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
              Language
            </span>
            <div className="relative">
              <select
                value={language}
                aria-label="OCR language"
                onChange={(event) => setLanguage(event.target.value)}
                className="h-8 w-[190px] cursor-pointer rounded-md border border-border bg-background pl-2.5 pr-2 text-[13px] font-medium text-foreground outline-none transition-colors hover:bg-muted focus-visible:border-foreground/40"
              >
                {OCR_LANGUAGES.map((option) => (
                  <option key={option.code} value={option.code}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          </label>

          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => setNonce((value) => value + 1)}
              disabled={!imageBlob || busy || tooLarge}
              className={cn(
                BUTTON_BASE,
                "h-9 bg-primary px-4 text-primary-foreground hover:bg-primary/85",
              )}
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ScanText className="h-4 w-4" />
              )}
              Extract text
            </button>
          </div>
        </div>

        {/* Image + output */}
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          <Panel
            title="Image"
            subtitle={imageName || "No image selected"}
            actions={
              <>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className={cn(
                    BUTTON_BASE,
                    "h-7 px-2 text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  <Upload className="h-3.5 w-3.5" /> Choose
                </button>
                <button
                  type="button"
                  onClick={clear}
                  disabled={!imageBlob}
                  aria-label="Clear image"
                  className={cn(
                    BUTTON_BASE,
                    "h-7 w-7 text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </>
            }
          >
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) handleFile(file);
                event.target.value = "";
              }}
            />
            <div
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragging(false);
                const file = event.dataTransfer.files?.[0];
                if (file) handleFile(file);
              }}
              className={cn(
                "editor-scroll flex h-[52vh] min-h-[340px] items-center justify-center overflow-auto p-4 transition-colors",
                dragging && "bg-muted",
              )}
            >
              {tooLarge ? (
                <div className="flex max-w-sm items-start gap-3">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <div>
                    <p className="text-[13px] font-medium text-foreground">
                      {formatBytes(imageBlob?.size ?? 0)} image — over the{" "}
                      {formatBytes(MAX_IMAGE_BYTES)} limit
                    </p>
                    <p className="mt-1 text-[13px] leading-6 text-muted-foreground">
                      Recognition on an image this large would freeze the tab for
                      a long time. Try a smaller screenshot.
                    </p>
                  </div>
                </div>
              ) : imageUrl ? (
                <img
                  src={imageUrl}
                  alt={imageName || "Source image"}
                  className="max-h-full max-w-full object-contain"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-8 py-10 text-center transition-colors hover:bg-muted"
                >
                  <FileImage className="h-6 w-6 text-muted-foreground/60" />
                  <span className="text-[13px] font-medium">
                    Drop an image here
                  </span>
                  <span className="text-[12px] text-muted-foreground">
                    or click to choose · paste with ⌘V
                  </span>
                </button>
              )}
            </div>

            {busy && (
              <div className="border-t border-border px-3 py-2">
                <div className="flex items-center justify-between font-mono text-[11px] text-muted-foreground">
                  <span>{progress ? progressLabel(progress.status) : "Starting…"}</span>
                  <span>{percent}%</span>
                </div>
                <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary transition-[width] duration-200"
                    style={{ width: `${percent}%` }}
                  />
                </div>
              </div>
            )}
          </Panel>

          <Panel
            title="Extracted text"
            subtitle={
              text
                ? `${stats.lines} lines · ${formatBytes(stats.bytes)}${
                    confidence !== null ? ` · ${Math.round(confidence)}% confidence` : ""
                  }`
                : "Result appears here"
            }
            actions={
              <>
                <button
                  type="button"
                  onClick={handleCopy}
                  disabled={!text}
                  className={cn(
                    BUTTON_BASE,
                    "h-7 px-2 text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  {copied ? (
                    <Check className="h-3.5 w-3.5" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                  {copied ? "Copied" : "Copy"}
                </button>
                <button
                  type="button"
                  onClick={handleDownload}
                  disabled={!text}
                  aria-label="Download extracted text"
                  className={cn(
                    BUTTON_BASE,
                    "h-7 w-7 text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  {downloaded ? (
                    <Check className="h-3.5 w-3.5" />
                  ) : (
                    <Download className="h-3.5 w-3.5" />
                  )}
                </button>
              </>
            }
          >
            <div className="editor-scroll relative h-[52vh] min-h-[340px] overflow-auto">
              {error ? (
                <div className="flex h-full items-start gap-3 p-4">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                  <div>
                    <p className="text-[13px] font-medium text-foreground">
                      Couldn&apos;t read this image
                    </p>
                    <pre className="mt-1 whitespace-pre-wrap font-mono text-xs leading-5 text-muted-foreground">
                      {error}
                    </pre>
                  </div>
                </div>
              ) : text ? (
                <pre className="min-h-full whitespace-pre-wrap p-4 font-mono text-[13px] leading-6 text-foreground">
                  {text}
                </pre>
              ) : (
                <div className="flex h-full items-center justify-center p-6 text-center">
                  <div>
                    <ScanText className="mx-auto h-5 w-5 text-muted-foreground/60" />
                    <p className="mt-2 text-[13px] text-muted-foreground">
                      {busy
                        ? "Reading the image…"
                        : imageBlob
                          ? "Nothing recognized yet"
                          : "Extracted text appears here"}
                    </p>
                  </div>
                </div>
              )}
            </div>
          </Panel>
        </div>

        {/* Status strip */}
        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border border-border bg-card px-4 py-2.5 font-mono text-[11px] text-muted-foreground">
          <span>OCR</span>
          <span>{OCR_LANGUAGES.find((item) => item.code === language)?.label}</span>
          <span>{text ? `${stats.chars} characters` : "no text yet"}</span>
          <span className="ml-auto hidden items-center gap-1.5 sm:flex">
            engine assets load once, then cache
          </span>
        </div>
      </main>
    </div>
  );
}
