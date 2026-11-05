// Main-thread client for the OCR worker.
let worker;
let seq = 0;
const pending = new Map();
let initPromise;
export const ocrState = { backend: null, lastMs: null, busy: false };

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./ocr-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    const p = pending.get(data.id);
    if (!p) return;
    pending.delete(data.id);
    if (data.backend) ocrState.backend = data.backend;
    data.ok ? p.resolve(data) : p.reject(new Error(data.error));
  };
  worker.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error(e.message || 'OCR worker crashed'));
    pending.clear();
  };
  return worker;
}

function call(msg, transfer = []) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ensureWorker().postMessage({ ...msg, id }, transfer);
  });
}

/** Load models (first call downloads ~10 MB, then cached by the service worker). */
export function initOcr() {
  initPromise ||= call({ type: 'init' }).catch((e) => { initPromise = null; throw e; });
  return initPromise;
}

/** OCR a canvas. Returns [{text, box:{x,y,width,height}, confidence}] in canvas pixel coords. */
export async function recognize(canvas) {
  ocrState.busy = true;
  try {
    const bitmap = await createImageBitmap(canvas);
    const res = await call({ type: 'ocr', bitmap }, [bitmap]);
    ocrState.lastMs = res.ms;
    return res.items;
  } finally {
    ocrState.busy = false;
  }
}
