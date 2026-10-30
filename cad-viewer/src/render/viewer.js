// Interactive 2D viewport: pan/zoom (mouse, wheel, touch), a content canvas and
// an overlay canvas for tools. The displayed document provides `bbox` and `draw()`.

const ZOOM_STEP = 1.0016;

export class Viewer {
  constructor(host, events = {}) {
    this.host = host;
    this.events = events;
    this.canvas = document.createElement('canvas');
    this.overlay = document.createElement('canvas');
    this.canvas.className = 'view-canvas';
    this.overlay.className = 'view-overlay';
    host.append(this.canvas, this.overlay);
    this.ctx = this.canvas.getContext('2d');
    this.octx = this.overlay.getContext('2d');
    this.doc = null;
    this.view = { cx: 0, cy: 0, scale: 1 };
    this.theme = { bg: '#1d2127', fg: '#ffffff', mono: false };
    this.tool = null;
    this.snapshot = document.createElement('canvas');
    this.snapView = null;
    this.slow = false;
    this.pointers = new Map();
    this.cursor = null;
    this.idleTimer = 0;
    this.frame = 0;
    this.overlayFrame = 0;
    this.interacting = false;
    this.resize = this.resize.bind(this);
    new ResizeObserver(this.resize).observe(host);
    this.bindInput();
    this.resize();
  }

  get width() { return this.host.clientWidth; }
  get height() { return this.host.clientHeight; }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.width, h = this.height;
    for (const c of [this.canvas, this.overlay]) {
      c.width = Math.max(1, Math.round(w * dpr));
      c.height = Math.max(1, Math.round(h * dpr));
      c.style.width = w + 'px';
      c.style.height = h + 'px';
    }
    this.dpr = dpr;
    this.render(true);
  }

  setDocument(doc) {
    this.doc = doc;
    this.snapView = null;
    this.zoomExtents();
  }

  setTheme(theme) {
    this.theme = theme;
    this.host.style.background = theme.bg;
    this.render(true);
  }

  setTool(tool) {
    this.tool?.cancel?.();
    this.tool = tool;
    this.overlay.style.cursor = tool?.cursor || 'default';
    this.renderOverlay();
  }

  // ---------- coordinates ----------
  screenToWorld(sx, sy) {
    const { cx, cy, scale } = this.view;
    return [cx + (sx - this.width / 2) / scale, cy - (sy - this.height / 2) / scale];
  }

  worldToScreen(x, y) {
    const { cx, cy, scale } = this.view;
    return [this.width / 2 + (x - cx) * scale, this.height / 2 - (y - cy) * scale];
  }

  visibleBounds() {
    const [x0, y1] = this.screenToWorld(0, 0);
    const [x1, y0] = this.screenToWorld(this.width, this.height);
    return [x0, y0, x1, y1];
  }

  applyTransform(ctx) {
    const { cx, cy, scale } = this.view;
    const d = this.dpr;
    ctx.setTransform(d * scale, 0, 0, -d * scale, d * (this.width / 2 - cx * scale), d * (this.height / 2 + cy * scale));
  }

  // ---------- view changes ----------
  zoomToBox(bb, pad = 0.05) {
    const w = Math.max(bb[2] - bb[0], 1e-9), h = Math.max(bb[3] - bb[1], 1e-9);
    const W = Math.max(this.width, 1), H = Math.max(this.height, 1);
    const scale = Math.min(W / (w * (1 + 2 * pad)), H / (h * (1 + 2 * pad)));
    this.view = { cx: (bb[0] + bb[2]) / 2, cy: (bb[1] + bb[3]) / 2, scale: Number.isFinite(scale) && scale > 0 ? scale : 1 };
    this.changed(true);
  }

  zoomExtents() {
    if (this.doc) this.zoomToBox(this.doc.bbox);
  }

  zoomAt(factor, sx = this.width / 2, sy = this.height / 2) {
    const [wx, wy] = this.screenToWorld(sx, sy);
    const scale = Math.min(Math.max(this.view.scale * factor, 1e-9), 1e9);
    this.view.scale = scale;
    // Keep the world point under the cursor fixed.
    this.view.cx = wx - (sx - this.width / 2) / scale;
    this.view.cy = wy + (sy - this.height / 2) / scale;
    this.changed(false);
  }

  panBy(dx, dy) {
    this.view.cx -= dx / this.view.scale;
    this.view.cy += dy / this.view.scale;
    this.changed(false);
  }

  changed(final) {
    this.events.onView?.(this.view);
    if (final || !this.slow) {
      this.render(true);
      return;
    }
    // Large drawing: move the last full frame now, re-render once the gesture settles.
    this.interacting = true;
    this.render(false);
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { this.interacting = false; this.render(true); }, 140);
  }

  // ---------- rendering ----------
  render(full = true) {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => (full ? this.renderFull() : this.renderQuick()));
  }

  renderFull() {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = this.theme.bg;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    if (this.doc) {
      const t0 = performance.now();
      this.applyTransform(ctx);
      this.doc.draw(ctx, { scale: this.view.scale, bounds: this.visibleBounds(), dpr: this.dpr, viewer: this }, this.theme);
      const dt = performance.now() - t0;
      this.slow = dt > 28;
      // Keep a copy for fast pan/zoom feedback.
      const s = this.snapshot;
      if (s.width !== this.canvas.width || s.height !== this.canvas.height) { s.width = this.canvas.width; s.height = this.canvas.height; }
      const sctx = s.getContext('2d');
      sctx.setTransform(1, 0, 0, 1, 0, 0);
      sctx.drawImage(this.canvas, 0, 0);
      this.snapView = { ...this.view };
    }
    this.renderOverlay();
  }

  renderQuick() {
    if (!this.snapView) return this.renderFull();
    const ctx = this.ctx;
    const k = this.view.scale / this.snapView.scale;
    // World point at the snapshot's screen origin moves to:
    const [sx, sy] = this.worldToScreenFrom(this.snapView, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = this.theme.bg;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(k, 0, 0, k, sx * this.dpr, sy * this.dpr);
    ctx.drawImage(this.snapshot, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.renderOverlay();
  }

  /** Screen position (css px) in the current view of the top-left corner of a snapshot taken with `v`. */
  worldToScreenFrom(v) {
    const wx = v.cx + (0 - this.width / 2) / v.scale;
    const wy = v.cy - (0 - this.height / 2) / v.scale;
    return this.worldToScreen(wx, wy);
  }

  renderOverlay() {
    cancelAnimationFrame(this.overlayFrame);
    this.overlayFrame = requestAnimationFrame(() => {
      const o = this.octx;
      o.setTransform(1, 0, 0, 1, 0, 0);
      o.clearRect(0, 0, this.overlay.width, this.overlay.height);
      this.events.drawOverlay?.(o, this);
      this.tool?.drawOverlay?.(o, this);
    });
  }

  /** Exports the current view as a PNG data URL (used for the AI "look at this view" feature). */
  captureView(maxSide = 1568) {
    const w = this.canvas.width, h = this.canvas.height;
    const k = Math.min(1, maxSide / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.round(w * k);
    c.height = Math.round(h * k);
    const ctx = c.getContext('2d');
    ctx.drawImage(this.canvas, 0, 0, c.width, c.height);
    ctx.drawImage(this.overlay, 0, 0, c.width, c.height);
    return c.toDataURL('image/png');
  }

  // ---------- input ----------
  bindInput() {
    const el = this.overlay;
    el.style.touchAction = 'none';
    el.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      const r = el.getBoundingClientRect();
      const dy = ev.deltaMode === 1 ? ev.deltaY * 33 : ev.deltaY;
      this.zoomAt(Math.pow(ZOOM_STEP, -dy), ev.clientX - r.left, ev.clientY - r.top);
    }, { passive: false });

    el.addEventListener('pointerdown', (ev) => {
      el.setPointerCapture(ev.pointerId);
      const r = el.getBoundingClientRect();
      this.pointers.set(ev.pointerId, { x: ev.clientX - r.left, y: ev.clientY - r.top, sx: ev.clientX - r.left, sy: ev.clientY - r.top, button: ev.button, moved: false, type: ev.pointerType });
      if (this.pointers.size === 2) this.pinch = this.pinchState();
    });

    el.addEventListener('pointermove', (ev) => {
      const r = el.getBoundingClientRect();
      const x = ev.clientX - r.left, y = ev.clientY - r.top;
      const p = this.pointers.get(ev.pointerId);
      if (!p) {
        this.cursor = [x, y];
        const w = this.screenToWorld(x, y);
        this.events.onCursor?.(w, [x, y]);
        this.tool?.move?.(w, [x, y], this);
        this.renderOverlay();
        return;
      }
      if (this.pointers.size === 2 && this.pinch) {
        p.x = x; p.y = y;
        const now = this.pinchState();
        this.zoomAt(now.d / this.pinch.d, now.x, now.y);
        this.panBy(now.x - this.pinch.x, now.y - this.pinch.y);
        this.pinch = now;
        for (const q of this.pointers.values()) q.moved = true;
        return;
      }
      const dx = x - p.x, dy = y - p.y;
      p.x = x; p.y = y;
      if (!p.moved && Math.hypot(x - p.sx, y - p.sy) > (p.type === 'touch' ? 8 : 4)) p.moved = true;
      if (p.moved) {
        const dragTool = this.tool?.drag && p.button === 0 && p.type !== 'touch';
        if (dragTool) this.tool.drag(this.screenToWorld(p.sx, p.sy), this.screenToWorld(x, y), this);
        else this.panBy(dx, dy);
      }
      this.cursor = [x, y];
      const w = this.screenToWorld(x, y);
      this.events.onCursor?.(w, [x, y]);
      this.renderOverlay();
    });

    const end = (ev) => {
      const p = this.pointers.get(ev.pointerId);
      this.pointers.delete(ev.pointerId);
      if (this.pointers.size < 2) this.pinch = null;
      if (!p) return;
      if (p.moved && this.tool?.drag && p.button === 0 && p.type !== 'touch') {
        this.tool.dragEnd?.(this.screenToWorld(p.sx, p.sy), this.screenToWorld(p.x, p.y), this);
        return;
      }
      if (!p.moved && ev.type === 'pointerup' && (p.button === 0 || p.type === 'touch')) {
        const w = this.screenToWorld(p.x, p.y);
        this.tool?.click?.(w, [p.x, p.y], this, ev);
        this.renderOverlay();
      }
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('pointerleave', () => { if (!this.pointers.size) { this.cursor = null; this.renderOverlay(); } });
    el.addEventListener('dblclick', (ev) => {
      if (this.tool?.dblclick?.(this, ev)) return;
      this.zoomExtents();
    });
    el.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      this.tool?.contextmenu?.(this, ev);
    });
  }

  pinchState() {
    const [a, b] = [...this.pointers.values()];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)) };
  }
}
