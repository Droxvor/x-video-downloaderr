"use client";

// Client-only, in-browser video trimming/editing. No server compute
// involved: the wasm core is fetched once from a CDN and reused for every
// export in this tab. Deliberately using the single-threaded core (not
// core-mt) because the multi-threaded build needs SharedArrayBuffer, which
// requires Cross-Origin-Opener/Embedder-Policy headers we don't otherwise
// want to set site-wide just for this one feature.
const CORE_VERSION = "0.12.6";
const CORE_BASE = `https://unpkg.com/@ffmpeg/core@${CORE_VERSION}/dist/umd`;

export interface Segment {
  start: number;
  end: number;
}

let instance: import("@ffmpeg/ffmpeg").FFmpeg | null = null;
let loadPromise: Promise<import("@ffmpeg/ffmpeg").FFmpeg> | null = null;
// Single stable listener registered once per instance; re-registering a new
// `ffmpeg.on("progress", ...)` closure on every call would pile up listeners
// across repeated exports in the same session. Retargeting this ref instead
// keeps exactly one listener alive for the lifetime of the wasm instance.
let activeProgressHandler: ((ratio: number) => void) | undefined;

export async function getFFmpeg(
  onProgress?: (ratio: number) => void,
): Promise<import("@ffmpeg/ffmpeg").FFmpeg> {
  activeProgressHandler = onProgress;
  if (instance) return instance;
  if (!loadPromise) {
    loadPromise = (async () => {
      const { FFmpeg } = await import("@ffmpeg/ffmpeg");
      const { toBlobURL } = await import("@ffmpeg/util");
      const ffmpeg = new FFmpeg();
      ffmpeg.on("progress", ({ progress }) => {
        // ffmpeg occasionally reports progress slightly outside [0, 1].
        activeProgressHandler?.(Math.min(1, Math.max(0, progress)));
      });
      const [coreURL, wasmURL] = await Promise.all([
        toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, "text/javascript"),
        toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, "application/wasm"),
      ]);
      await ffmpeg.load({ coreURL, wasmURL });
      instance = ffmpeg;
      return ffmpeg;
    })();
  }
  return loadPromise;
}

function toBlob(data: Uint8Array): Blob {
  // readFile returns a Uint8Array backed by a generic ArrayBufferLike;
  // copy it into a plain ArrayBuffer-backed view so it satisfies BlobPart.
  const copy = new Uint8Array(data.length);
  copy.set(data);
  return new Blob([copy], { type: "video/mp4" });
}

/**
 * Cuts each segment out of the video at sourceUrl and concatenates the
 * results, in the given order, into a single mp4 Blob. sourceUrl MUST be
 * same-origin (route it through /api/download) since this fetches the bytes
 * directly and X's CDN doesn't reliably send CORS headers for cross-origin
 * reads.
 *
 * Every segment is re-encoded (not stream-copied) so that all segments share
 * identical codec parameters — required for the final concat step to work
 * reliably regardless of where the cut points fall relative to keyframes.
 */
export async function exportSegments(
  sourceUrl: string,
  segments: Segment[],
  onProgress?: (ratio: number) => void,
): Promise<Blob> {
  if (segments.length === 0) {
    throw new Error("No segments to export");
  }

  const { fetchFile } = await import("@ffmpeg/util");
  const totalSteps = segments.length + 1; // one encode per segment + final concat
  let stepIndex = 0;
  const ffmpeg = await getFFmpeg((ratio) => {
    onProgress?.((stepIndex + ratio) / totalSteps);
  });

  const inputName = "input.mp4";
  const outputName = "output.mp4";
  const concatListName = "concat.txt";
  const segmentFiles: string[] = [];

  await ffmpeg.writeFile(inputName, await fetchFile(sourceUrl));

  try {
    for (let i = 0; i < segments.length; i++) {
      stepIndex = i;
      const { start, end } = segments[i];
      const duration = Math.max(0.05, end - start);
      const segmentName = `seg${i}.mp4`;
      await ffmpeg.exec([
        "-ss", start.toFixed(3),
        "-i", inputName,
        "-t", duration.toFixed(3),
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-c:a", "aac",
        "-movflags", "+faststart",
        segmentName,
      ]);
      segmentFiles.push(segmentName);
    }

    stepIndex = segments.length;
    if (segmentFiles.length === 1) {
      // Nothing to concatenate — the single re-encoded segment is the result.
      const data = await ffmpeg.readFile(segmentFiles[0]);
      return toBlob(data as Uint8Array);
    }

    const concatList = segmentFiles.map((name) => `file '${name}'`).join("\n");
    await ffmpeg.writeFile(concatListName, concatList);
    await ffmpeg.exec(["-f", "concat", "-safe", "0", "-i", concatListName, "-c", "copy", outputName]);

    const data = await ffmpeg.readFile(outputName);
    return toBlob(data as Uint8Array);
  } finally {
    await ffmpeg.deleteFile(inputName).catch(() => {});
    await ffmpeg.deleteFile(concatListName).catch(() => {});
    await ffmpeg.deleteFile(outputName).catch(() => {});
    for (const name of segmentFiles) await ffmpeg.deleteFile(name).catch(() => {});
  }
}
