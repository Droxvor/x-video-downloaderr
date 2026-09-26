import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Formats a bitrate (bits/sec) into a friendly quality label. */
export function bitrateToLabel(bitrate: number): string {
  if (bitrate >= 4_000_000) return "1080p";
  if (bitrate >= 1_800_000) return "720p";
  if (bitrate >= 800_000) return "480p";
  if (bitrate >= 300_000) return "360p";
  return "SD";
}

export function formatDuration(ms?: number): string | null {
  if (!ms || ms <= 0) return null;
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

/**
 * Matches x.com / twitter.com post links (with or without protocol, any
 * subdomain like mobile./m./www.), common embed-fixer mirrors, and the
 * handle-less `/i/web/status/` and `/i/status/` forms.
 */
const TWEET_URL_PATTERN =
  /(?:^|\s|\/\/)(?:[\w-]+\.)*(?:twitter\.com|x\.com|fxtwitter\.com|fixupx\.com|vxtwitter\.com|fixvx\.com)\/(?:#!\/)?(?:i\/web\/|\w{1,15}\/)status(?:es)?\/(\d{1,25})/i;

/** Bare numeric id pasted directly. */
function isBareId(value: string): boolean {
  return /^\d{5,25}$/.test(value);
}

export function extractTweetId(input: string): string | null {
  const trimmed = input.trim();
  const match = trimmed.match(TWEET_URL_PATTERN);
  if (match?.[1]) return match[1];
  if (isBareId(trimmed)) return trimmed;
  return null;
}

export function buildDownloadHref(
  remoteUrl: string,
  filenameSeed: string,
  mode: "inline" | "attachment" = "attachment",
): string {
  const params = new URLSearchParams({ url: remoteUrl, name: filenameSeed });
  if (mode === "inline") {
    params.set("mode", "inline");
  }
  return `/api/download?${params.toString()}`;
}

export function copyToClipboard(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }
  return Promise.reject(new Error("Clipboard API unavailable"));
}

export const SHELL = "mx-auto w-full max-w-5xl px-5 sm:px-8";
