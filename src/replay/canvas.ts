import type { MaskLevel, ReplayPlugin } from "./config";

const BLOCKED = ".wt-block, [data-wt-block]";
const FRAME_MAX_W = 320;
const FRAME_MAX_CHARS = 60_000;

/** One downscaled webp frame of a video element; null when blocked, not playing, or tainted (cross-origin). */
export function videoFrame(v: HTMLVideoElement, doc: Document = document): { w: number; h: number; data: string } | null {
  if (v.closest(BLOCKED) || v.paused || !v.videoWidth) return null;
  const w = Math.min(FRAME_MAX_W, v.videoWidth);
  const h = Math.round((v.videoHeight * w) / v.videoWidth);
  try {
    const c = doc.createElement("canvas");
    c.width = w;
    c.height = h;
    c.getContext("2d")?.drawImage(v, 0, 0, w, h);
    const data = c.toDataURL("image/webp", 0.5);
    return data.length > FRAME_MAX_CHARS ? null : { w, h, data };
  } catch {
    return null; // tainted canvas or unsupported
  }
}

/** Samples every playing `<video>` at 1 fps as a plugin event (`wt.plugin.video`). Enable via `recordVideoFrames`. */
export function videoFramePlugin(): ReplayPlugin {
  return {
    name: "video",
    start(emit) {
      const t = setInterval(() => {
        document.querySelectorAll("video").forEach((v, i) => {
          const f = videoFrame(v);
          if (f) emit({ index: i, ...f });
        });
      }, 1000);
      return () => clearInterval(t);
    },
  };
}

/** Canvas capture is opt-in and never under strict, whatever the caller asked for. */
export const canvasAllowed = (requested: boolean | undefined, level: MaskLevel): boolean =>
  requested === true && level !== "strict";

/** rrweb sampling/quality options: at most 2 fps at quality 0.5. */
export const CANVAS_OPTS = { sampling: { canvas: 2 }, dataURLOptions: { type: "image/webp", quality: 0.5 } } as const;
