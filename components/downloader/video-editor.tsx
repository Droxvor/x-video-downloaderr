"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Download as DownloadIcon,
  Scissors as ScissorsIcon,
  Trash2 as TrashIcon,
  TriangleAlert as ExclamationTriangleIcon,
  X as XIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { exportSegments } from "@/lib/ffmpeg-client";

interface VideoEditorProps {
  /** Must be same-origin (routed through /api/download) — ffmpeg fetches raw bytes from this. */
  sourceUrl: string;
  filenameSeed: string;
  aspectRatio: string;
  onClose: () => void;
}

interface Segment {
  id: string;
  start: number;
  end: number;
}

type Status = "editing" | "loading" | "processing" | "done" | "error";

// Segments shorter than this (in seconds) are rejected — avoids degenerate
// zero-length cuts from a split landing right on an existing boundary.
const MIN_SEGMENT_LENGTH = 0.15;

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return "0:00.0";
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

export function VideoEditor({ sourceUrl, filenameSeed, aspectRatio, onClose }: VideoEditorProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const segmentIdRef = useRef(0);
  const nextSegmentId = useCallback(() => `seg-${segmentIdRef.current++}`, []);

  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>("editing");
  const [progress, setProgress] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [resultSize, setResultSize] = useState<number | null>(null);

  // Revoke the exported blob URL on unmount / re-export so we don't leak memory.
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
    setSegments([{ id: nextSegmentId(), start: 0, end: dur }]);
  }, [nextSegmentId]);

  const handleTimeUpdate = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    setCurrentTime(video.currentTime);
  }, []);

  const isBusy = status === "loading" || status === "processing";

  const splitTargetIndex = useMemo(() => {
    return segments.findIndex(
      (seg) =>
        currentTime > seg.start + MIN_SEGMENT_LENGTH && currentTime < seg.end - MIN_SEGMENT_LENGTH,
    );
  }, [segments, currentTime]);

  const handleSplit = useCallback(() => {
    if (splitTargetIndex === -1) return;
    setSegments((prev) => {
      const seg = prev[splitTargetIndex];
      const left: Segment = { id: nextSegmentId(), start: seg.start, end: currentTime };
      const right: Segment = { id: nextSegmentId(), start: currentTime, end: seg.end };
      const next = [...prev];
      next.splice(splitTargetIndex, 1, left, right);
      return next;
    });
  }, [splitTargetIndex, currentTime, nextSegmentId]);

  const handleDelete = useCallback((id: string) => {
    setSegments((prev) => (prev.length <= 1 ? prev : prev.filter((seg) => seg.id !== id)));
    setSelectedId((prev) => (prev === id ? null : prev));
  }, []);

  const handleSelectSegment = useCallback((seg: Segment) => {
    setSelectedId(seg.id);
    if (videoRef.current) videoRef.current.currentTime = seg.start;
  }, []);

  const handleExport = useCallback(async () => {
    if (segments.length === 0) return;
    setStatus("loading");
    setErrorMessage(null);
    setProgress(0);
    if (resultUrl) {
      URL.revokeObjectURL(resultUrl);
      setResultUrl(null);
    }
    try {
      setStatus("processing");
      const blob = await exportSegments(
        sourceUrl,
        segments.map(({ start, end }) => ({ start, end })),
        (ratio) => setProgress(ratio),
      );
      const url = URL.createObjectURL(blob);
      setResultUrl(url);
      setResultSize(blob.size);
      setStatus("done");
    } catch (err) {
      console.error("[v0] Export failed:", err);
      setErrorMessage(
        "Export fehlgeschlagen. Dein Browser unterstützt das möglicherweise nicht — versuch es mit einem anderen Browser oder lade den vollständigen Clip herunter.",
      );
      setStatus("error");
    }
  }, [sourceUrl, segments, resultUrl]);

  const totalOutputDuration = useMemo(
    () => segments.reduce((sum, seg) => sum + (seg.end - seg.start), 0),
    [segments],
  );

  const progressLabel = useMemo(() => {
    if (status === "loading") return "Editor wird geladen…";
    if (status === "processing") return `Exportiere… ${Math.round(progress * 100)}%`;
    return "";
  }, [status, progress]);

  const canSplit = splitTargetIndex !== -1 && !isBusy;

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
            Video bearbeiten
          </span>
          <button
            type="button"
            onClick={onClose}
            disabled={isBusy}
            aria-label="Editor schließen"
            className="text-ink-muted transition-colors hover:text-ink disabled:opacity-40"
          >
            <XIcon className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="overflow-y-auto">
          <div
            className="relative flex w-full items-center justify-center bg-black"
            style={{ aspectRatio, maxHeight: "42vh" }}
          >
            <video
              ref={videoRef}
              src={sourceUrl}
              controls
              playsInline
              preload="metadata"
              onLoadedMetadata={handleLoadedMetadata}
              onTimeUpdate={handleTimeUpdate}
              className="h-full w-full object-contain"
            />
          </div>

          <div className="flex flex-col gap-4 p-4">
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between font-mono text-[11px] text-ink-faint">
                <span>Position {formatTime(currentTime)}</span>
                <span className="text-ink-muted">Ergebnis {formatTime(totalOutputDuration)}</span>
              </div>

              {/* Timeline: proportional blocks per remaining segment, playhead marker */}
              <div className="relative h-6 w-full border border-line bg-surface-2">
                {segments.map((seg, i) => {
                  const left = duration > 0 ? (seg.start / duration) * 100 : 0;
                  const width = duration > 0 ? ((seg.end - seg.start) / duration) * 100 : 100;
                  const isSelected = seg.id === selectedId;
                  return (
                    <button
                      key={seg.id}
                      type="button"
                      onClick={() => handleSelectSegment(seg)}
                      title={`Segment ${i + 1}: ${formatTime(seg.start)}–${formatTime(seg.end)}`}
                      style={{ left: `${left}%`, width: `${Math.max(0, width)}%` }}
                      className={cn(
                        "absolute inset-y-0 border-r border-surface-2 transition-colors",
                        isSelected ? "bg-ink" : "bg-ink-muted/60 hover:bg-ink-muted",
                      )}
                    />
                  );
                })}
                <div
                  className="absolute inset-y-0 w-px bg-red-500"
                  style={{ left: `${duration > 0 ? (currentTime / duration) * 100 : 0}%` }}
                  aria-hidden="true"
                />
              </div>

              <button
                type="button"
                onClick={handleSplit}
                disabled={!canSplit}
                className="flex items-center justify-center gap-1.5 self-start border border-line px-2 py-1 font-mono text-[10px] uppercase tracking-[0.06em] text-ink-muted transition-colors hover:border-line-strong hover:text-ink disabled:opacity-40"
              >
                <ScissorsIcon className="h-3 w-3" aria-hidden="true" />
                An Position teilen
              </button>
            </div>

            {/* Segment list: order = export order */}
            <div className="flex flex-col gap-1.5">
              <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                Segmente ({segments.length})
              </span>
              <ul className="flex flex-col gap-1">
                {segments.map((seg, i) => {
                  const isSelected = seg.id === selectedId;
                  return (
                    <li key={seg.id}>
                      <div
                        className={cn(
                          "flex items-center gap-2 border px-2.5 py-1.5",
                          isSelected ? "border-line-strong bg-surface-2" : "border-line",
                        )}
                      >
                        <button
                          type="button"
                          onClick={() => handleSelectSegment(seg)}
                          className="flex flex-1 items-center gap-2 text-left"
                        >
                          <span className="font-mono text-[10px] text-ink-faint">{i + 1}</span>
                          <span className="font-mono text-[11px] text-ink">
                            {formatTime(seg.start)}–{formatTime(seg.end)}
                          </span>
                          <span className="font-mono text-[10px] text-ink-faint">
                            ({formatTime(seg.end - seg.start)})
                          </span>
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDelete(seg.id)}
                          disabled={isBusy || segments.length <= 1}
                          aria-label={`Segment ${i + 1} löschen`}
                          className="text-ink-muted transition-colors hover:text-ink disabled:opacity-30"
                        >
                          <TrashIcon className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
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
                  <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-ink">Clip fertig</span>
                  <span className="font-mono text-[11px] text-ink-faint">
                    {formatTime(totalOutputDuration)}
                    {resultSize ? ` · ${(resultSize / (1024 * 1024)).toFixed(1)} MB` : ""}
                  </span>
                </div>
                <a
                  href={resultUrl}
                  download={`${filenameSeed}-bearbeitet.mp4`}
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
              disabled={isBusy || segments.length === 0}
              className={cn(
                "flex items-center justify-center gap-2 border border-ink bg-ink px-4 py-2.5 font-mono text-[12px] font-medium uppercase tracking-[0.06em] text-canvas",
                "transition-opacity duration-100 hover:opacity-90 active:translate-y-px disabled:opacity-40",
              )}
            >
              <ScissorsIcon className="h-3.5 w-3.5" aria-hidden="true" />
              {status === "done"
                ? "Erneut exportieren"
                : segments.length > 1
                  ? "Segmente zusammenführen & exportieren"
                  : "Exportieren"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
