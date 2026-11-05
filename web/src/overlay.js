// Canvas overlay: maps frame coordinates onto an object-fit:cover element and draws tappable rating badges.
const YELLOW = '#f5c518';

export class Overlay {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.badges = []; // [{rect:{x,y,w,h} in CSS px, data}]
  }

  /** cover (live video, matches object-fit:cover) or contain (frozen frame: show everything). */
  transform(fw, fh, fit = 'cover') {
    const W = this.canvas.clientWidth, H = this.canvas.clientHeight;
    const s = fit === 'contain' ? Math.min(W / fw, H / fh) : Math.max(W / fw, H / fh);
    return { s, ox: (W - fw * s) / 2, oy: (H - fh * s) / 2, W, H };
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(this.canvas.clientWidth * dpr), h = Math.round(this.canvas.clientHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** Draw a frozen frame (full colour) under the badges. */
  drawFrame(frame) {
    this.resize();
    const { s, ox, oy, W, H } = this.transform(frame.width, frame.height, 'contain');
    this.ctx.clearRect(0, 0, W, H);
    this.ctx.drawImage(frame, ox, oy, frame.width * s, frame.height * s);
  }

  clear() {
    this.resize();
    this.ctx.clearRect(0, 0, this.canvas.clientWidth, this.canvas.clientHeight);
    this.badges = [];
  }

  /**
   * @param items [{box (frame px), label, ambiguous, data}]
   * @param fw,fh frame size the boxes refer to
   * @param frame optional frozen frame to paint first
   */
  render(items, fw, fh, frame) {
    if (frame) this.drawFrame(frame); else this.clear();
    const ctx = this.ctx;
    const { s, ox, oy, W, H } = this.transform(fw, fh, frame ? 'contain' : 'cover');
    this.badges = [];
    ctx.font = '700 15px -apple-system, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    for (const it of items) {
      const bx = ox + it.box.x * s, by = oy + it.box.y * s, bw = it.box.width * s, bh = it.box.height * s;
      if (bx > W || by > H || bx + bw < 0 || by + bh < 0) continue; // title outside the visible crop
      // faint underline of the recognised text
      ctx.fillStyle = 'rgba(245,197,24,0.35)';
      ctx.fillRect(bx, by + bh, bw, 2);
      const text = it.label;
      const w = Math.ceil(ctx.measureText(text).width) + 16, h = 24;
      let x = bx + bw + 6, y = by + bh / 2 - h / 2;
      if (x + w > W - 4) x = Math.max(4, bx + bw - w); // no room on the right → overlap the end of the text
      if (x + w > W - 4) x = W - 4 - w;
      y = Math.min(Math.max(4, y), H - h - 4);
      ctx.fillStyle = it.ambiguous ? '#ffffff' : YELLOW;
      roundRect(ctx, x, y, w, h, 7);
      ctx.fill();
      ctx.fillStyle = '#000';
      ctx.fillText(text, x + 8, y + h / 2 + 1);
      this.badges.push({ rect: { x: x - 6, y: y - 8, w: w + 12, h: h + 16 }, data: it.data }); // generous hit area
    }
  }

  hit(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    const x = clientX - r.left, y = clientY - r.top;
    for (let i = this.badges.length - 1; i >= 0; i--) {
      const b = this.badges[i].rect;
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return this.badges[i].data;
    }
    return null;
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
