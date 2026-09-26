"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Download as DownloadIcon,
  Scissors as ScissorsIcon,
  TriangleAlert as ExclamationTriangleIcon,
  X as XIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { trimVideo } from "@/lib/ffmpeg-client";

interface VideoEditorProps {
  /** Must be same-origin (routed through /api/download) — ffmpeg fetches raw bytes from this. */
  sourceUrl: string;
  filenameSeed: string;
  aspectRatio: string;
  onClose: () => void;
}

type Status = "scrubbing" | "loading" | "processing" | "done" | "error";

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return "0:00.0";
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

const RANGE_THUMB_CLASSES =
  "pointer-events-none absolute inset-0 h-full w-full cursor-pointer appearance-none bg-transparent " +
  "[&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:border [&::-webkit-slider-thumb]:border-ink [&::-webkit-slider-thumb]:bg-canvas [&::-webkit-slider-thumb]:shadow-sm " +
  "[&::-moz-range-thumb]:pointer-events-auto [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:rounded-none [&::-moz-range-thumb]:border [&::-moz-range-thumb]:border-ink [&::-moz-range-thumb]:bg-canvas " +
  "[&::-webkit-slider-runnable-track]:bg-transparent [&::-moz-range-track]:bg-transparent";

export function VideoEditor({ sourceUrl, filenameSeed, aspectRatio, onClose }: VideoEditorProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [duration, setDuration] = useState(0);
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(0);
  const [status, setStatus] = useState<Status>("scrubbing");
  const [progress, setProgress] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [resultSize, setResultSize] = useState<number | null>(null);

  // Revoke the trimmed-clip blob URL on unmount / re-trim so we don't leak memory.
  useEffect(() => {
    return () => {
      if (resultUrl) URL.revokeObjectURL(resultUrl);
    };
  }, [resultUrl]);

  const handleLoadedMetadata = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const dur = video.duration;
    setDuration(dur);
    setEnd(dur);
  }, []);

  const clampStart = useCallback(
    (value: number) => Math.min(value, Math.max(0, end - 0.1)),
    [end],
  );
  const clampEnd = useCallback(
    (value: number) => Math.max(value, Math.min(duration, start + 0.1)),
    [start, duration],
  );

  const handleStartChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const value = clampStart(Number(event.target.value));
      setStart(value);
      if (videoRef.current) videoRef.current.currentTime = value;
    },
    [clampStart],
  );

  const handleEndChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const value = clampEnd(Number(event.target.value));
      setEnd(value);
      if (videoRef.current) videoRef.current.currentTime = value;
    },
    [clampEnd],
  );

  const handleSetStartToCurrent = useCallback(() => {
    const t = videoRef.current?.currentTime ?? 0;
    setStart(clampStart(t));
  }, [clampStart]);

  const handleSetEndToCurrent = useCallback(() => {
    const t = videoRef.current?.currentTime ?? duration;
    setEnd(clampEnd(t));
  }, [clampEnd, duration]);

  const handlePreviewTrim = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = start;
    video.play();
    const stopAtEnd = () => {
      if (video.currentTime >= end) {
        video.pause();
        video.removeEventListener("timeupdate", stopAtEnd);
      }
    };
    video.addEventListener("timeupdate", stopAtEnd);
  }, [start, end]);

  const handleExport = useCallback(async () => {
    setStatus("loading");
    setErrorMessage(null);
    setProgress(0);
    if (resultUrl) {
      URL.revokeObjectURL(resultUrl);
      setResultUrl(null);
    }
    try {
      setStatus("processing");
      const blob = await trimVideo(sourceUrl, start, end, (ratio) => setProgress(ratio));
      const url = URL.createObjectURL(blob);
      setResultUrl(url);
      setResultSize(blob.size);
      setStatus("done");
    } catch (err) {
      console.error("[v0] Trim failed:", err);
      setErrorMessage("Trimming failed. Your browser might not support this — try a different browser or download the full clip instead.");
      setStatus("error");
    }
  }, [sourceUrl, start, end, resultUrl]);

  const trimmedDuration = Math.max(0, end - start);
  const isBusy = status === "loading" || status === "processing";
  const startPct = duration > 0 ? (start / duration) * 100 : 0;
  const endPct = duration > 0 ? (end / duration) * 100 : 100;

  const progressLabel = useMemo(() => {
    if (status === "loading") return "Loading editor engine…";
    if (status === "processing") return `Trimming… ${Math.round(progress * 100)}%`;
    return "";
  }, [status, progress]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Video editor"
      onClick={(e) => {
        if (e.target === e.currentTarget && !isBusy) onClose();
      }}
    >
      <div className="flex max-h-[92vh] w-full max-w-lg flex-col border border-line-strong bg-surface-1">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <span className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.08em] text-ink">
            <ScissorsIcon className="h-3.5 w-3.5" aria-hidden="true" />
            Trim video
          </span>
          <button
            type="button"
            onClick={onClose}
            disabled={isBusy}
            aria-label="Close editor"
            className="text-ink-muted transition-colors hover:text-ink disabled:opacity-40"
          >
            <XIcon className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="overflow-y-auto">
          <div
            className="relative flex w-full items-center justify-center bg-black"
            style={{ aspectRatio, maxHeight: "48vh" }}
          >
            <video
              ref={videoRef}
              src={sourceUrl}
              controls
              playsInline
              preload="metadata"
              onLoadedMetadata={handleLoadedMetadata}
              className="h-full w-full object-contain"
            />
          </div>

          <div className="flex flex-col gap-4 p-4">
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between font-mono text-[11px] text-ink-faint">
                <span>{formatTime(start)}</span>
                <span className="text-ink-muted">clip length {formatTime(trimmedDuration)}</span>
                <span>{formatTime(end)}</span>
              </div>

              <div className="relative h-4 w-full">
                <div className="absolute top-1/2 h-1.5 w-full -translate-y-1/2 bg-line" />
                <div
                  className="absolute top-1/2 h-1.5 -translate-y-1/2 bg-ink"
                  style={{ left: `${startPct}%`, width: `${Math.max(0, endPct - startPct)}%` }}
                />
                <input
                  type="range"
                  min={0}
                  max={duration || 1}
                  step={0.05}
                  value={start}
                  onChange={handleStartChange}
                  disabled={isBusy || duration === 0}
                  aria-label="Trim start"
                  className={cn(RANGE_THUMB_CLASSES, "z-20")}
                />
                <input
                  type="range"
                  min={0}
                  max={duration || 1}
                  step={0.05}
                  value={end}
                  onChange={handleEndChange}
                  disabled={isBusy || duration === 0}
                  aria-label="Trim end"
                  className={cn(RANGE_THUMB_CLASSES, "z-10")}
                />
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleSetStartToCurrent}
                  disabled={isBusy}
                  className="border border-line px-2 py-1 font-mono text-[10px] uppercase tracking-[0.06em] text-ink-muted transition-colors hover:border-line-strong hover:text-ink disabled:opacity-40"
                >
                  Set start here
                </button>
                <button
                  type="button"
                  onClick={handleSetEndToCurrent}
                  disabled={isBusy}
                  className="border border-line px-2 py-1 font-mono text-[10px] uppercase tracking-[0.06em] text-ink-muted transition-colors hover:border-line-strong hover:text-ink disabled:opacity-40"
                >
                  Set end here
                </button>
                <button
                  type="button"
                  onClick={handlePreviewTrim}
                  disabled={isBusy || duration === 0}
                  className="ml-auto border border-line px-2 py-1 font-mono text-[10px] uppercase tracking-[0.06em] text-ink-muted transition-colors hover:border-line-strong hover:text-ink disabled:opacity-40"
                >
                  Preview selection
                </button>
              </div>
            </div>

            {status === "error" && errorMessage && (
              <div className="flex items-start gap-2 border border-line-strong bg-surface-2 p-3">
                <ExclamationTriangleIcon className="mt-0.5 h-4 w-4 shrink-0 text-ink" aria-hidden="true" />
                <p className="text-[12px] leading-relaxed text-ink-muted">{errorMessage}</p>
              </div>
            )}

            {isBusy && (
              <div className="flex flex-col gap-1.5">
                <div className="h-1.5 w-full bg-line">
                  <div
                    className="h-full bg-ink transition-[width] duration-150"
                    style={{ width: status === "loading" ? "8%" : `${Math.max(4, progress * 100)}%` }}
                  />
                </div>
                <p className="font-mono text-[11px] text-ink-faint">{progressLabel}</p>
              </div>
            )}

            {status === "done" && resultUrl && (
              <div className="flex items-center justify-between border border-line-strong bg-surface-2 p-3">
                <div className="flex flex-col gap-0.5">
                  <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-ink">Clip ready</span>
                  <span className="font-mono text-[11px] text-ink-faint">
                    {formatTime(trimmedDuration)}
                    {resultSize ? ` · ${(resultSize / (1024 * 1024)).toFixed(1)} MB` : ""}
                  </span>
                </div>
                <a
                  href={resultUrl}
                  download={`${filenameSeed}-trimmed.mp4`}
                  className="flex items-center gap-1.5 border border-ink bg-ink px-3 py-1.5 font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-canvas transition-transform duration-100 hover:opacity-90 active:translate-y-px"
                >
                  <DownloadIcon className="h-3.5 w-3.5" aria-hidden="true" />
                  Download
                </a>
              </div>
            )}

            <button
              type="button"
              onClick={handleExport}
              disabled={isBusy || duration === 0}
              className={cn(
                "flex items-center justify-center gap-2 border border-ink bg-ink px-4 py-2.5 font-mono text-[12px] font-medium uppercase tracking-[0.06em] text-canvas",
                "transition-opacity duration-100 hover:opacity-90 active:translate-y-px disabled:opacity-40",
              )}
            >
              <ScissorsIcon className="h-3.5 w-3.5" aria-hidden="true" />
              {status === "done" ? "Trim again" : "Trim clip"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
