// Frame capture, change detection and preprocessing for TV screens (light text on dark UI).
export const WORK_WIDTH = 960;
const THUMB = 32;
export const DIFF_THRESHOLD = 6; // mean abs grey difference (0–255) below which a frame counts as unchanged

const thumbCanvas = new OffscreenCanvas(THUMB, THUMB);
const thumbCtx = thumbCanvas.getContext('2d', { willReadFrequently: true });

/**
 * Copy the current video frame (kept for the frozen view). With digital zoom z > 1 only the centre
 * 1/z of the frame is copied, at native resolution — exactly the region visible in the zoomed viewfinder.
 */
export function grabFrame(video, into, z = 1) {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return null;
  const w = Math.round(vw / z), h = Math.round(vh / z);
  if (into.width !== w || into.height !== h) { into.width = w; into.height = h; }
  into.getContext('2d').drawImage(video, (vw - w) / 2, (vh - h) / 2, w, h, 0, 0, w, h);
  return into;
}

/** 32×32 grey thumbnail; returns {thumb, diff} where diff compares with `prev` (Infinity if none). */
export function thumbDiff(source, prev) {
  thumbCtx.drawImage(source, 0, 0, THUMB, THUMB);
  const d = thumbCtx.getImageData(0, 0, THUMB, THUMB).data;
  const thumb = new Uint8Array(THUMB * THUMB);
  let sum = 0;
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    thumb[j] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
    if (prev) sum += Math.abs(thumb[j] - prev[j]);
  }
  return { thumb, diff: prev ? sum / thumb.length : Infinity };
}

/**
 * Downscale to WORK_WIDTH; optionally grey → invert → Otsu threshold (dark text on white for OCR).
 * @returns {{canvas: OffscreenCanvas, scale: number}} scale = source px per work px
 */
export function prepare(source, { preprocess = true } = {}) {
  const sw = source.width, sh = source.height;
  const w = Math.min(WORK_WIDTH, sw), h = Math.round(sh * (w / sw));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, w, h);
  if (preprocess) {
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    const hist = new Uint32Array(256);
    for (let i = 0; i < d.length; i += 4) {
      const g = 255 - ((d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8);
      d[i] = g; hist[g]++;
    }
    const t = otsu(hist, w * h);
    for (let i = 0; i < d.length; i += 4) {
      const v = d[i] > t ? 255 : 0;
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    ctx.putImageData(img, 0, 0);
  }
  return { canvas, scale: sw / w };
}

function otsu(hist, total) {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, threshold = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; threshold = t; }
  }
  return threshold;
}
