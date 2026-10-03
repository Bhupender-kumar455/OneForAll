import { useEffect, useState } from "react";
import { Link } from "wouter";
import { Lock, Moon, Sun } from "lucide-react";

import { BUTTON_BASE } from "@/lib/styles";
import { cn } from "@/lib/utils";

/**
 * The app name, and the same name wearing its decorative frame. The bare name is
 * what phones show: the framed one is wide enough that it would have to be
 * clipped mid-symbol on a narrow screen.
 */
const BRAND = "OneForAll";
const BRAND_DECORATED = "▂▃▅▇█▓▒░ OneForAll ░▒▓█▇▅▃▂";

/**
 * Top bar shared by every page. It owns the theme preference (persisted under
 * the same `cc-theme` key the formatter has always used) and the tab navigation
 *    between the code formatter, the text extractor and the file
    transfer view.
 */
export function SiteHeader({ active }: { active: "code" | "extract" | "transfer" }) {
  const [dark, setDark] = useState(() => {
    if (typeof window === "undefined") return false;
    const stored = window.localStorage.getItem("cc-theme");
    if (stored) return stored === "dark";
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  });

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    window.localStorage.setItem("cc-theme", dark ? "dark" : "light");
  }, [dark]);

  const tabClass = (isActive: boolean) =>
    cn(
      "rounded-md px-2 py-1 text-[13px] transition-colors",
      isActive
        ? "bg-muted font-medium text-foreground"
        : "text-muted-foreground hover:text-foreground",
    );

  return (
    <header className="sticky top-0 z-30 border-b border-border bg-background/80 backdrop-blur-md">
      {/*
        A single row at every width: the brand is the only part allowed to
        shrink, so the tabs and the theme toggle stay reachable on a phone
        instead of pushing the row wider than the screen.
      */}
      <div className="flex h-14 items-center justify-between gap-2 px-3 sm:gap-4 sm:px-6 lg:px-10">
        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          <span className="truncate text-sm font-semibold tracking-tight">
            <span className="lg:hidden">{BRAND}</span>
            <span className="hidden lg:inline">{BRAND_DECORATED}</span>
          </span>
          <nav className="flex shrink-0 items-center gap-0.5 sm:ml-3 sm:gap-1">
            <Link href="/" className={tabClass(active === "code")}>
              Formatter
            </Link>
            <Link href="/extract" className={tabClass(active === "extract")}>
              Text Extractor
            </Link>
            <Link href="/transfer" className={tabClass(active === "transfer")}>
              Transfer
            </Link>
            {active === "code" && (
              <span className="hidden items-center gap-1 md:flex">
                <a
                  className="rounded-md px-2 py-1 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
                  href="#languages"
                >
                  Languages
                </a>
                <a
                  className="rounded-md px-2 py-1 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
                  href="#about"
                >
                  About
                </a>
              </span>
            )}
          </nav>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="hidden items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-[11px] text-muted-foreground sm:flex">
            <Lock className="h-3 w-3" /> Runs in your browser
          </span>
          <button
            type="button"
            onClick={() => setDark((value) => !value)}
            aria-label="Toggle theme"
            data-testid="button-toggle-theme"
            className={cn(BUTTON_BASE, "h-9 w-9 border border-border hover:bg-muted")}
          >
            {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>
        </div>
      </div>
    </header>
  );
}
