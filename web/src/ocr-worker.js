// PaddleOCR (ppu-paddle-ocr + onnxruntime-web) in a Web Worker. WebGPU when available, WASM fallback.
import { PaddleOcrService, isWebGpuAvailable } from 'ppu-paddle-ocr/web';

let service;
let ready;
let backend = 'wasm';

async function init() {
  backend = (await isWebGpuAvailable().catch(() => false)) ? 'webgpu' : 'wasm';
  service = new PaddleOcrService({ debugging: { debug: false, verbose: false } });
  try {
    await service.initialize();
  } catch (err) {
    if (backend !== 'webgpu') throw err;
    // WebGPU present but failing (driver/feature gaps): retry on WASM only.
    backend = 'wasm';
    service = new PaddleOcrService({ session: { executionProviders: ['wasm'] } });
    await service.initialize();
  }
}

self.onmessage = async ({ data }) => {
  const { id, type } = data;
  try {
    if (type === 'init') {
      ready ||= init();
      await ready;
      self.postMessage({ id, ok: true, backend });
      return;
    }
    if (type === 'ocr') {
      ready ||= init();
      await ready;
      const bmp = data.bitmap;
      const canvas = new OffscreenCanvas(bmp.width, bmp.height);
      canvas.getContext('2d').drawImage(bmp, 0, 0);
      bmp.close();
      const t0 = performance.now();
      const res = await service.recognize(canvas, { flatten: true, noCache: true });
      const items = (res.results || []).map((r) => ({ text: r.text, box: r.box, confidence: r.confidence }));
      self.postMessage({ id, ok: true, items, ms: Math.round(performance.now() - t0), backend });
    }
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message || err) });
  }
};
