/**
 * Shared button chrome. Every button in the app is this plus the size and
 * colour classes applied at the call site, so the formatter page, the extractor
 * page and the header stay visually identical.
 */
export const BUTTON_BASE =
  "inline-flex items-center justify-center gap-1.5 rounded-md text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none";
