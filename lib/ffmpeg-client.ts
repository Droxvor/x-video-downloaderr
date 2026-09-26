"use client";

// Client-only, in-browser video trimming. No server compute involved: the
// wasm core is fetched once from a CDN and reused for every trim in this
// tab. Deliberately using the single-threaded core (not core-mt) because the
// multi-threaded build needs SharedArrayBuffer, which requires
// Cross-Origin-Opener/Embedder-Policy headers we don't otherwise want to set
// site-wide just for this one feature.
const CORE_VERSION = "0.12.6";
const CORE_BASE = `https://unpkg.com/@ffmpeg/core@${CORE_VERSION}/dist/umd`;

let instance: import("@ffmpeg/ffmpeg").FFmpeg | null = null;
let loadPromise: Promise<import("@ffmpeg/ffmpeg").FFmpeg> | null = null;

export async function getFFmpeg(
  onProgress?: (ratio: number) => void,
): Promise<import("@ffmpeg/ffmpeg").FFmpeg> {
  if (instance) return instance;
  if (!loadPromise) {
    loadPromise = (async () => {
      const { FFmpeg } = await import("@ffmpeg/ffmpeg");
      const { toBlobURL } = await import("@ffmpeg/util");
      const ffmpeg = new FFmpeg();
      const [coreURL, wasmURL] = await Promise.all([
        toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, "text/javascript"),
        toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, "application/wasm"),
      ]);
      await ffmpeg.load({ coreURL, wasmURL });
      instance = ffmpeg;
      return ffmpeg;
    })();
  }
  const ffmpeg = await loadPromise;
  if (onProgress) {
    ffmpeg.on("progress", ({ progress }) => {
      // ffmpeg occasionally reports progress slightly outside [0, 1].
      onProgress(Math.min(1, Math.max(0, progress)));
    });
  }
  return ffmpeg;
}

/**
 * Trims [startSeconds, endSeconds) out of the video at sourceUrl and
 * resolves with the trimmed file as a Blob. sourceUrl MUST be same-origin
 * (route it through /api/download) since this fetches the bytes directly
 * and X's CDN doesn't reliably send CORS headers for cross-origin reads.
 */
export async function trimVideo(
  sourceUrl: string,
  startSeconds: number,
  endSeconds: number,
  onProgress?: (ratio: number) => void,
): Promise<Blob> {
  const { fetchFile } = await import("@ffmpeg/util");
  const ffmpeg = await getFFmpeg(onProgress);

  const inputName = "input.mp4";
  const outputName = "output.mp4";
  const duration = Math.max(0.05, endSeconds - startSeconds);

  await ffmpeg.writeFile(inputName, await fetchFile(sourceUrl));

  try {
    // Fast path: stream copy, no re-encode. Snaps to the nearest keyframe,
    // which is imperceptible for most clips and avoids a slow CPU re-encode.
    await ffmpeg.exec([
      "-ss", startSeconds.toFixed(3),
      "-i", inputName,
      "-t", duration.toFixed(3),
      "-c", "copy",
      "-avoid_negative_ts", "make_zero",
      outputName,
    ]);
  } catch {
    // Fallback: re-encode for a frame-accurate cut when stream copy fails
    // (e.g. the cut point isn't near a keyframe boundary).
    await ffmpeg.exec([
      "-ss", startSeconds.toFixed(3),
      "-i", inputName,
      "-t", duration.toFixed(3),
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-c:a", "aac",
      "-movflags", "+faststart",
      outputName,
    ]);
  }

  const data = await ffmpeg.readFile(outputName);
  await ffmpeg.deleteFile(inputName).catch(() => {});
  await ffmpeg.deleteFile(outputName).catch(() => {});

  // readFile returns a Uint8Array backed by a generic ArrayBufferLike;
  // copy it into a plain ArrayBuffer-backed view so it satisfies BlobPart.
  const bytes = data as Uint8Array;
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return new Blob([copy], { type: "video/mp4" });
}
