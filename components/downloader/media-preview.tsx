"use client";

import { memo, useCallback, useRef, useState } from "react";
import {
  Check as CheckIcon,
  Download as DownloadIcon,
  Scissors as ScissorsIcon,
  TriangleAlert as ExclamationTriangleIcon,
  Image as ImageIcon,
  Play as PlayIcon,
  Video as VideoIcon,
} from "lucide-react";
import type { ResolvedAsset, VideoVariant } from "@/lib/types";
import { buildDownloadHref, cn, formatDuration } from "@/lib/utils";
import { VideoEditor } from "@/components/downloader/video-editor";

const KIND_LABEL: Record<ResolvedAsset["kind"], string> = {
  video: "Video",
  photo: "Photo",
  gif: "GIF",
};

/**
 * Where the preview element currently points.
 *
 * "direct" hits X's own CDN (video.twimg.com / pbs.twimg.com) straight on —
 * fast, and it always serves the right Content-Type, so the browser never
 * has a reason to refuse it as unplayable. "proxy" is only a fallback for
 * the rare case the CDN ever blocks hotlinking; it goes through our own
 * /api/download?mode=inline route instead.
 */
type PreviewSource = "direct" | "proxy";

function KindIcon({ kind }: { kind: ResolvedAsset["kind"] }) {
  if (kind === "photo") return <ImageIcon className="h-3.5 w-3.5" aria-hidden="true" />;
  return <VideoIcon className="h-3.5 w-3.5" aria-hidden="true" />;
}

interface MediaPreviewProps {
  asset: ResolvedAsset;
  filenameSeed: string;
  /** 1-based position, shown only when a post has more than one asset. */
  position?: number;
  total?: number;
}

function LoadFailure({ downloadHref }: { downloadHref: string }) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 text-center">
      <ExclamationTriangleIcon className="h-5 w-5 text-white/60" aria-hidden="true" />
      <p className="text-[12px] leading-relaxed text-white/60">
        Preview didn&apos;t load. The file itself should still be fine to download.
      </p>
      <a
        href={downloadHref}
        download
        className="flex items-center gap-1.5 border border-white/70 px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.06em] text-white transition-colors hover:bg-white/10"
      >
        <DownloadIcon className="h-3.5 w-3.5" aria-hidden="true" />
        Download anyway
      </a>
    </div>
  );
}

function MediaPreviewImpl({ asset, filenameSeed, position, total }: MediaPreviewProps) {
  const variants = asset.variants ?? [];
  const [variantIndex, setVariantIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [previewSource, setPreviewSource] = useState<PreviewSource>("direct");
  const [loadFailed, setLoadFailed] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const activeVariant: VideoVariant | undefined = variants[variantIndex];

  const handleQualityChange = useCallback((event: React.ChangeEvent<HTMLSelectElement>) => {
    setVariantIndex(Number(event.target.value));
    setIsPlaying(false);
    setLoadFailed(false);
    setPreviewSource("direct");
  }, []);

  const handlePlayClick = useCallback(() => {
    videoRef.current?.play();
  }, []);

  const handlePlayingState = useCallback((playing: boolean) => () => setIsPlaying(playing), []);

  /**
   * First failure: drop from the direct CDN URL to the proxy, in case the
   * CDN ever blocks hotlinking. Only surface the "preview failed" state if
   * the proxy fails too — so a single bad load never strands the user.
   */
  const handleLoadError = useCallback(() => {
    setPreviewSource((current) => {
      if (current === "direct") return "proxy";
      setLoadFailed(true);
      return current;
    });
  }, []);

  const [justDownloaded, setJustDownloaded] = useState(false);
  const handleDownloadClick = useCallback(() => {
    setJustDownloaded(true);
    window.setTimeout(() => setJustDownloaded(false), 1600);
  }, []);

  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const handleOpenEditor = useCallback(() => setIsEditorOpen(true), []);
  const handleCloseEditor = useCallback(() => setIsEditorOpen(false), []);

  const previewUrlFor = useCallback(
    (remoteUrl: string, seed: string) =>
      previewSource === "direct" ? remoteUrl : buildDownloadHref(remoteUrl, seed, "inline"),
    [previewSource],
  );

  const inlineSrc =
    asset.kind === "photo"
      ? previewUrlFor(asset.previewUrl, `${filenameSeed}-${asset.id}`)
      : activeVariant
        ? previewUrlFor(activeVariant.url, `${filenameSeed}-${asset.id}`)
        : undefined;

  const posterSrc =
    asset.kind === "video" ? previewUrlFor(asset.previewUrl, `${filenameSeed}-${asset.id}-poster`) : undefined;

  const downloadHref = buildDownloadHref(
    asset.kind === "photo" ? asset.previewUrl : (activeVariant?.url ?? asset.previewUrl),
    `${filenameSeed}-${asset.id}`,
    "attachment",
  );

  // The editor's ffmpeg instance fetches raw bytes itself, so it always
  // needs the same-origin proxy URL — never the direct CDN link, since
  // twimg.com doesn't reliably send CORS headers for cross-origin reads.
  const editorSourceUrl = activeVariant
    ? buildDownloadHref(activeVariant.url, `${filenameSeed}-${asset.id}`, "inline")
    : undefined;

  const aspectRatio = asset.width && asset.height ? `${asset.width} / ${asset.height}` : "16 / 9";
  const duration = formatDuration(asset.durationMs);
  const showPlayButton = asset.kind === "video" && !isPlaying;
  const canEdit = asset.kind !== "photo" && Boolean(editorSourceUrl);

  return (
    <div className="group border border-line bg-surface-1 h-fit transition-colors duration-150 hover:border-line-strong">
      <div
        className="relative flex w-full items-center justify-center overflow-hidden bg-black"
        style={{ aspectRatio, maxHeight: "70vh" }}
      >
        {asset.kind === "photo" ? (
          loadFailed ? (
            <LoadFailure downloadHref={downloadHref} />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element -- original-resolution image, intentionally unoptimized
            <img
              key={inlineSrc}
              src={inlineSrc}
              alt="Downloaded post photo"
              className="h-full w-full object-contain"
              loading="lazy"
              onError={handleLoadError}
            />
          )
        ) : loadFailed ? (
          <LoadFailure downloadHref={downloadHref} />
        ) : (
          <>
            <video
              ref={videoRef}
              key={inlineSrc}
              src={inlineSrc}
              poster={posterSrc}
              controls
              playsInline
              loop={asset.kind === "gif"}
              muted={asset.kind === "gif"}
              autoPlay={asset.kind === "gif"}
              preload="metadata"
              onPlay={handlePlayingState(true)}
              onPause={handlePlayingState(false)}
              onEnded={handlePlayingState(false)}
              onError={handleLoadError}
              className="h-full w-full object-contain"
            >
              Your browser cannot play this video.
            </video>
            {showPlayButton && (
              <button
                type="button"
                onClick={handlePlayClick}
                aria-label="Play video"
                className="absolute inset-0 flex items-center justify-center bg-black/10 transition-colors duration-150 hover:bg-black/25"
              >
                <span className="flex h-14 w-14 items-center justify-center border border-white/70 bg-black/50 text-white backdrop-blur-sm transition-transform duration-150 group-hover:scale-105 active:scale-95">
                  <PlayIcon className="h-6 w-6 translate-x-0.5" aria-hidden="true" />
                </span>
              </button>
            )}
          </>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-line p-3">
        <span className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-muted">
          <KindIcon kind={asset.kind} />
          {KIND_LABEL[asset.kind]}
          {typeof position === "number" && total && total > 1 ? ` · ${position}/${total}` : null}
        </span>

        {asset.width > 0 && (
          <span className="font-mono text-[11px] text-ink-faint">
            {asset.width}&times;{asset.height}
          </span>
        )}
        {duration && <span className="font-mono text-[11px] text-ink-faint">{duration}</span>}

        {variants.length > 1 && (
          <label className="ml-auto flex items-center gap-1.5">
            <span className="sr-only">Quality</span>
            <select
              value={variantIndex}
              onChange={handleQualityChange}
              className={cn(
                "border border-line bg-surface-1 px-2 py-1 font-mono text-[11px] text-ink",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink",
              )}
            >
              {variants.map((variant, i) => (
                <option key={variant.url} value={i}>
                  {variant.label}
                </option>
              ))}
            </select>
          </label>
        )}

        {canEdit && (
          <button
            type="button"
            onClick={handleOpenEditor}
            className={cn(
              "flex items-center gap-1.5 border border-line px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.06em] text-ink-muted",
              "transition-colors hover:border-line-strong hover:text-ink",
              variants.length <= 1 && "ml-auto",
            )}
          >
            <ScissorsIcon className="h-3.5 w-3.5" aria-hidden="true" />
            Edit
          </button>
        )}

        <a
          href={downloadHref}
          download
          onClick={handleDownloadClick}
          className={cn(
            "flex items-center gap-1.5 border border-ink bg-ink px-3 py-1.5 font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-canvas",
            "transition-transform duration-100 hover:opacity-90 active:translate-y-px",
            variants.length <= 1 && !canEdit && "ml-auto",
          )}
        >
          {justDownloaded ? (
            <>
              <CheckIcon className="h-3.5 w-3.5" aria-hidden="true" />
              Saving
            </>
          ) : (
            <>
              <DownloadIcon className="h-3.5 w-3.5" aria-hidden="true" />
              Download
            </>
          )}
        </a>
      </div>

      {isEditorOpen && editorSourceUrl && (
        <VideoEditor
          sourceUrl={editorSourceUrl}
          filenameSeed={`${filenameSeed}-${asset.id}`}
          aspectRatio={aspectRatio}
          onClose={handleCloseEditor}
        />
      )}
    </div>
  );
}

export const MediaPreview = memo(MediaPreviewImpl);
