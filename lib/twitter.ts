import "server-only";
import type { MediaKind, ResolvedAsset, ResolvedPost, VideoVariant } from "@/lib/types";
import { bitrateToLabel } from "@/lib/utils";

const SYNDICATION_ENDPOINT = "https://cdn.syndication.twimg.com/tweet-result";
const FXTWITTER_ENDPOINT = "https://api.fxtwitter.com/i/status";

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const REQUEST_TIMEOUT_MS = 8000;

export class ResolveError extends Error {
  code: "NOT_FOUND" | "NO_MEDIA" | "UPSTREAM_UNAVAILABLE" | "RATE_LIMITED";
  constructor(code: ResolveError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * X's syndication endpoint (the same one its own embed widget calls) expects
 * a short proof-of-work-style token derived from the post id. There is no
 * secret key involved, just this fixed transform.
 */
function deriveToken(id: string): string {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
}

interface RawVideoVariant {
  bitrate?: number;
  content_type: string;
  url: string;
}

function toOriginalPhotoUrl(url: string): string {
  const base = url.split("?")[0] ?? url;
  return `${base}?format=${base.endsWith(".png") ? "png" : "jpg"}&name=orig`;
}

function normalizeVideoVariants(raw: RawVideoVariant[]): VideoVariant[] {
  const seen = new Set<string>();
  return raw
    .filter((v) => v.content_type === "video/mp4" && typeof v.url === "string")
    .filter((v) => (seen.has(v.url) ? false : (seen.add(v.url), true)))
    .map((v) => ({
      bitrate: v.bitrate ?? 0,
      url: v.url,
      label: bitrateToLabel(v.bitrate ?? 0),
    }))
    .sort((a, b) => b.bitrate - a.bitrate);
}

function dedupeAssets(assets: ResolvedAsset[]): ResolvedAsset[] {
  const seen = new Set<string>();
  return assets.filter((asset) => {
    const key = asset.variants?.[0]?.url ?? asset.previewUrl;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function fetchJson(url: URL | string, headers: Record<string, string>): Promise<{ status: number; data: unknown }> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new ResolveError("UPSTREAM_UNAVAILABLE", "Could not reach X right now.");
  }
  const data = await response.json().catch(() => null);
  return { status: response.status, data };
}

/* ------------------------------------------------------------------ */
/* Source 1: X syndication (embed) endpoint                           */
/* ------------------------------------------------------------------ */

interface SyndicationMedia {
  type: "photo" | "video" | "animated_gif";
  media_url_https: string;
  original_info?: { width: number; height: number };
  video_info?: { duration_millis?: number; variants: RawVideoVariant[] };
}

interface SyndicationTweet {
  __typename?: string;
  id_str?: string;
  created_at?: string;
  user?: { name: string; screen_name: string };
  mediaDetails?: SyndicationMedia[];
  quoted_tweet?: SyndicationTweet;
}

function normalizeSyndicationMedia(media: SyndicationMedia, index: number): ResolvedAsset | null {
  const width = media.original_info?.width ?? 0;
  const height = media.original_info?.height ?? 0;

  if (media.type === "photo") {
    return { kind: "photo", id: `photo-${index}`, previewUrl: toOriginalPhotoUrl(media.media_url_https), width, height };
  }

  const variants = normalizeVideoVariants(media.video_info?.variants ?? []);
  if (variants.length === 0) return null;

  return {
    kind: (media.type === "animated_gif" ? "gif" : "video") as MediaKind,
    id: `${media.type}-${index}`,
    previewUrl: media.media_url_https,
    width,
    height,
    variants,
    durationMs: media.video_info?.duration_millis,
  };
}

async function resolveViaSyndication(tweetId: string): Promise<ResolvedPost> {
  const url = new URL(SYNDICATION_ENDPOINT);
  url.searchParams.set("id", tweetId);
  url.searchParams.set("lang", "en");
  url.searchParams.set("token", deriveToken(tweetId));

  const { status, data } = await fetchJson(url, { "User-Agent": BROWSER_UA, Accept: "application/json" });

  if (status === 429) throw new ResolveError("RATE_LIMITED", "X is throttling requests right now. Try again shortly.");
  if (status === 404) throw new ResolveError("NOT_FOUND", "That post does not exist, was deleted, or is private.");
  if (status >= 400) throw new ResolveError("UPSTREAM_UNAVAILABLE", `X returned an unexpected response (${status}).`);

  const tweet = data as SyndicationTweet | null;
  if (!tweet || typeof tweet !== "object" || Object.keys(tweet).length === 0 || tweet.__typename === "TweetTombstone") {
    throw new ResolveError("NOT_FOUND", "That post is protected or no longer available.");
  }

  const media = [...(tweet.mediaDetails ?? []), ...(tweet.quoted_tweet?.mediaDetails ?? [])];
  const assets = dedupeAssets(
    media.map(normalizeSyndicationMedia).filter((a): a is ResolvedAsset => a !== null),
  );
  if (assets.length === 0) {
    throw new ResolveError("NO_MEDIA", "That post does not contain a video, photo, or GIF.");
  }

  return {
    id: tweetId,
    sourceUrl: `https://x.com/${tweet.user?.screen_name ?? "i"}/status/${tweetId}`,
    author: { name: tweet.user?.name ?? "Unknown", handle: tweet.user?.screen_name ?? "" },
    assets,
    createdAt: tweet.created_at,
  };
}

/* ------------------------------------------------------------------ */
/* Source 2: FxTwitter API (fallback, covers posts syndication omits) */
/* ------------------------------------------------------------------ */

interface FxMedia {
  type: "photo" | "video" | "gif";
  url: string;
  thumbnail_url?: string;
  width?: number;
  height?: number;
  duration?: number;
  variants?: RawVideoVariant[];
}

interface FxTweet {
  id: string;
  created_at?: string;
  author?: { name: string; screen_name: string };
  media?: { all?: FxMedia[] };
  quote?: FxTweet;
}

function normalizeFxMedia(media: FxMedia, index: number): ResolvedAsset | null {
  const width = media.width ?? 0;
  const height = media.height ?? 0;

  if (media.type === "photo") {
    return { kind: "photo", id: `photo-${index}`, previewUrl: toOriginalPhotoUrl(media.url), width, height };
  }

  const rawVariants = media.variants?.length
    ? media.variants
    : [{ url: media.url, content_type: "video/mp4", bitrate: 0 }];
  const variants = normalizeVideoVariants(rawVariants);
  if (variants.length === 0) return null;

  return {
    kind: media.type === "gif" ? "gif" : "video",
    id: `${media.type}-${index}`,
    previewUrl: media.thumbnail_url ?? media.url,
    width,
    height,
    variants,
    durationMs: media.duration ? Math.round(media.duration * 1000) : undefined,
  };
}

async function resolveViaFxTwitter(tweetId: string): Promise<ResolvedPost> {
  const { status, data } = await fetchJson(`${FXTWITTER_ENDPOINT}/${tweetId}`, {
    "User-Agent": "RipTweet/2.0",
    Accept: "application/json",
  });

  if (status === 429) throw new ResolveError("RATE_LIMITED", "X is throttling requests right now. Try again shortly.");

  const body = data as { code?: number; tweet?: FxTweet | null } | null;
  const tweet = body?.tweet;
  if (!tweet || status === 404 || status === 401) {
    throw new ResolveError("NOT_FOUND", "That post does not exist, was deleted, or is private.");
  }
  if (status >= 400) throw new ResolveError("UPSTREAM_UNAVAILABLE", `X returned an unexpected response (${status}).`);

  const media = [...(tweet.media?.all ?? []), ...(tweet.quote?.media?.all ?? [])];
  const assets = dedupeAssets(media.map(normalizeFxMedia).filter((a): a is ResolvedAsset => a !== null));
  if (assets.length === 0) {
    throw new ResolveError("NO_MEDIA", "That post does not contain a video, photo, or GIF.");
  }

  return {
    id: tweetId,
    sourceUrl: `https://x.com/${tweet.author?.screen_name ?? "i"}/status/${tweetId}`,
    author: { name: tweet.author?.name ?? "Unknown", handle: tweet.author?.screen_name ?? "" },
    assets,
    createdAt: tweet.created_at,
  };
}

/* ------------------------------------------------------------------ */

const ERROR_PRIORITY: Record<ResolveError["code"], number> = {
  NO_MEDIA: 3,
  RATE_LIMITED: 2,
  UPSTREAM_UNAVAILABLE: 1,
  NOT_FOUND: 0,
};

/**
 * Tries X's own syndication endpoint first, then falls back to FxTwitter.
 * Syndication regularly returns 404 / empty payloads for sensitive,
 * age-restricted or very recent posts even though they are public, which
 * previously surfaced as "post does not exist" for perfectly valid links.
 */
export async function resolvePost(tweetId: string): Promise<ResolvedPost> {
  const errors: ResolveError[] = [];
  for (const source of [resolveViaSyndication, resolveViaFxTwitter]) {
    try {
      return await source(tweetId);
    } catch (error) {
      errors.push(
        error instanceof ResolveError
          ? error
          : new ResolveError("UPSTREAM_UNAVAILABLE", "Something went wrong resolving that link."),
      );
    }
  }
  throw errors.sort((a, b) => ERROR_PRIORITY[b.code] - ERROR_PRIORITY[a.code])[0];
}
