// Canvas set pieces: forge embers, jitter scope, freeze/thaw, burn, snowflake sigil.
// Every effect has a static reduced-motion rendering.
import { RM } from './ui';

function setup(canvas: HTMLCanvasElement, onResize?: () => void) {
  const ctx = canvas.getContext('2d')!;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const size = { w: 300, h: 150 };
  // The caller's `const { ctx, size } = setup(...)` is not assigned yet during this call,
  // so onResize must only run on later (ResizeObserver) resizes, never synchronously here.
  let ready = false;
  const resize = () => {
    size.w = canvas.clientWidth || 300;
    size.h = canvas.clientHeight || 150;
    canvas.width = Math.round(size.w * dpr);
    canvas.height = Math.round(size.h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (ready) onResize?.();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();
  ready = true;
  return { ctx, size, stop: () => ro.disconnect() };
}

export function loop(fn: (t: number) => boolean | void): () => void {
  let on = true;
  let id = 0;
  const f = (t: number) => {
    if (!on) return;
    if (fn(t) === false) return;
    id = requestAnimationFrame(f);
  };
  id = requestAnimationFrame(f);
  return () => {
    on = false;
    cancelAnimationFrame(id);
  };
}

/** Shows progress no faster than minMs (so people can follow) and never ahead of the real work. */
export function paced(minMs: number, onFrame: (shown: number) => void) {
  let real = 0;
  const start = performance.now();
  let resolve!: () => void;
  const done = new Promise<void>((r) => (resolve = r));
  const ms = RM ? 1 : minMs;
  const stop = loop((t) => {
    const shown = Math.min(real, (t - start) / ms);
    onFrame(shown);
    if (shown >= 1) {
      resolve();
      return false;
    }
  });
  return {
    set(v: number) {
      real = Math.max(real, Math.min(1, v));
    },
    done,
    stop,
  };
}

const rand = (i: number) => {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

// ---------- forge ----------
export function forgeFx(canvas: HTMLCanvasElement) {
  const { ctx, size, stop } = setup(canvas, () => {
    ctx.fillStyle = '#110e0c';
    ctx.fillRect(0, 0, size.w, size.h);
  });
  type P = { x: number; y: number; vx: number; vy: number; life: number; max: number; r: number };
  const ps: P[] = [];
  let heat = 0;
  const spawn = (x: number, y: number, n = 3, speed = 1) => {
    for (let i = 0; i < n; i++) {
      ps.push({ x, y, vx: (Math.random() - 0.5) * 1.8 * speed, vy: (-Math.random() * 1.9 - 0.4) * speed, life: 0, max: 36 + Math.random() * 54, r: 1 + Math.random() * 2.6 });
    }
    if (ps.length > 1200) ps.splice(0, ps.length - 1200);
  };
  if (RM) {
    const draw = () => {
      ctx.fillStyle = '#110e0c';
      ctx.fillRect(0, 0, size.w, size.h);
      const g = ctx.createLinearGradient(0, size.h, 0, size.h * 0.4);
      g.addColorStop(0, `rgba(255,106,31,${0.18 + heat * 0.4})`);
      g.addColorStop(1, 'rgba(255,106,31,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, size.w, size.h);
    };
    draw();
    return { spawn: () => {}, setHeat: (v: number) => ((heat = v), draw()), destroy: stop };
  }
  const stopLoop = loop(() => {
    const { w, h } = size;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = 'rgba(17,14,12,0.2)';
    ctx.fillRect(0, 0, w, h);
    const g = ctx.createLinearGradient(0, h, 0, h * 0.5);
    g.addColorStop(0, `rgba(255,106,31,${0.08 + heat * 0.32})`);
    g.addColorStop(1, 'rgba(255,106,31,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, h * 0.5, w, h * 0.5);
    ctx.globalCompositeOperation = 'lighter';
    for (let i = ps.length - 1; i >= 0; i--) {
      const p = ps[i];
      p.life++;
      p.x += p.vx;
      p.y += p.vy;
      p.vy -= 0.025;
      p.vx *= 0.985;
      const t = p.life / p.max;
      if (t >= 1) {
        ps.splice(i, 1);
        continue;
      }
      const a = 1 - t;
      ctx.fillStyle = t < 0.25 ? `rgba(255,224,160,${a})` : t < 0.6 ? `rgba(255,162,94,${a})` : `rgba(255,106,31,${a * 0.8})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * (1 - t * 0.5), 0, Math.PI * 2);
      ctx.fill();
    }
    if (Math.random() < 0.25 + heat * 0.9) spawn(Math.random() * w, h + 4, 1, 0.7 + heat);
  });
  return {
    spawn,
    setHeat: (v: number) => {
      heat = v;
    },
    destroy: () => {
      stopLoop();
      stop();
    },
  };
}

// ---------- jitter oscilloscope ----------
export function scopeFx(canvas: HTMLCanvasElement, onSample: (dt: number) => void) {
  const { ctx, size, stop } = setup(canvas);
  const pts: number[] = [];
  let last = performance.now();
  let mean = 16.7;
  const stopLoop = loop((now) => {
    const dt = now - last;
    last = now;
    if (dt > 0 && dt < 200) {
      mean = mean * 0.95 + dt * 0.05;
      pts.push(dt - mean);
      if (pts.length > 180) pts.shift();
      onSample(dt);
    }
    const { w, h } = size;
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(255,162,94,0.25)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();
    ctx.strokeStyle = '#ffa25e';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    pts.forEach((v, i) => {
      const x = (i / 179) * w;
      const y = h / 2 - Math.max(-1, Math.min(1, v / 4)) * (h / 2 - 3);
      if (i) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    });
    ctx.stroke();
  });
  return () => {
    stopLoop();
    stop();
  };
}

// ---------- freeze / thaw ----------
export function freezeFx(canvas: HTMLCanvasElement, opts: { image?: ImageBitmap | null; label: string; reverse?: boolean }) {
  let p = 0;
  let noise: HTMLCanvasElement | null = null;
  const { ctx, size, stop } = setup(canvas, () => draw());

  function drawSource() {
    const { w, h } = size;
    ctx.fillStyle = '#1b1714';
    ctx.fillRect(0, 0, w, h);
    if (opts.image) {
      const s = Math.min((w * 0.9) / opts.image.width, (h * 0.86) / opts.image.height);
      const iw = opts.image.width * s;
      const ih = opts.image.height * s;
      ctx.drawImage(opts.image, (w - iw) / 2, (h - ih) / 2, iw, ih);
      return;
    }
    const pw = Math.min(220, w * 0.42);
    const ph = Math.min(h * 0.78, pw * 1.3);
    const px = (w - pw) / 2;
    const py = (h - ph) / 2;
    ctx.fillStyle = '#f3eee7';
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(px + pw * 0.72, py);
    ctx.lineTo(px + pw, py + pw * 0.28);
    ctx.lineTo(px + pw, py + ph);
    ctx.lineTo(px, py + ph);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#ff6a1f';
    for (let i = 0; i < 9; i++) {
      const lw = (0.55 + rand(i) * 0.35) * (pw * 0.76);
      ctx.fillRect(px + pw * 0.12, py + ph * 0.26 + i * ph * 0.074, lw, Math.max(3, ph * 0.026));
    }
    ctx.fillStyle = '#1b1714';
    ctx.font = `600 ${Math.max(11, pw * 0.07)}px "Instrument Sans", sans-serif`;
    ctx.fillText(opts.label.length > 22 ? opts.label.slice(0, 21) + '…' : opts.label, px + pw * 0.12, py + ph * 0.16, pw * 0.7);
  }

  function drawNoise() {
    const { w, h } = size;
    if (!noise) {
      ctx.fillStyle = '#0b5670';
      ctx.fillRect(0, 0, w, h);
      return;
    }
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(noise, 0, 0, w, h);
    ctx.strokeStyle = 'rgba(226,241,246,0.18)';
    ctx.lineWidth = 1;
    for (let i = -4; i < 12; i++) {
      ctx.beginPath();
      ctx.moveTo((i / 8) * w, 0);
      ctx.lineTo((i / 8) * w + h * 0.6, h);
      ctx.stroke();
    }
  }

  function draw() {
    const { w, h } = size;
    const x = p * w;
    const left = opts.reverse ? drawSource : drawNoise;
    const right = opts.reverse ? drawNoise : drawSource;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, x, h);
    ctx.clip();
    left();
    ctx.restore();
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, 0, w - x, h);
    ctx.clip();
    right();
    ctx.restore();
    if (p > 0 && p < 1) {
      ctx.strokeStyle = '#e2f1f6';
      ctx.lineWidth = 2;
      ctx.shadowColor = '#7fd8f2';
      ctx.shadowBlur = 12;
      ctx.beginPath();
      for (let y = 0; y <= h; y += 10) {
        const jx = x + (rand(y) - 0.5) * 18;
        if (y) ctx.lineTo(jx, y);
        else ctx.moveTo(jx, y);
      }
      ctx.stroke();
      ctx.shadowBlur = 0;
    }
  }

  return {
    setProgress(v: number) {
      p = Math.max(0, Math.min(1, v));
      draw();
    },
    setNoise(bytes: Uint8Array) {
      const n = Math.max(1, Math.min(bytes.length, 6000));
      const cols = Math.max(4, Math.round(Math.sqrt((n * size.w) / Math.max(1, size.h))));
      const rows = Math.max(3, Math.ceil(n / cols));
      const c = document.createElement('canvas');
      c.width = cols;
      c.height = rows;
      const cx = c.getContext('2d')!;
      const img = cx.createImageData(cols, rows);
      for (let i = 0; i < cols * rows; i++) {
        const t = (bytes[i % n] ?? 0) / 255;
        img.data[i * 4] = 11 + t * 215;
        img.data[i * 4 + 1] = 86 + t * 155;
        img.data[i * 4 + 2] = 112 + t * 134;
        img.data[i * 4 + 3] = 255;
      }
      cx.putImageData(img, 0, 0);
      noise = c;
      draw();
    },
    destroy: stop,
  };
}

// ---------- burn ----------
export function burnFx(canvas: HTMLCanvasElement): Promise<void> {
  const { ctx, size, stop } = setup(canvas);
  const { w, h } = size;
  const bw = Math.min(w * 0.46, 340);
  const bh = Math.min(h * 0.5, 200);
  const bx = (w - bw) / 2;
  const by = (h - bh) / 2;
  if (RM) {
    ctx.fillStyle = '#3a3734';
    ctx.fillRect(bx, by + bh * 0.8, bw, bh * 0.2);
    stop();
    return Promise.resolve();
  }
  type A = { x: number; y: number; vx: number; vy: number; at: number; c: number };
  const parts: A[] = [];
  for (let y = by; y < by + bh; y += 5) {
    for (let x = bx; x < bx + bw; x += 5) {
      parts.push({ x, y, vx: (Math.random() - 0.5) * 0.8, vy: -Math.random() * 1.6 - 0.3, at: 900 + ((by + bh - y) / bh) * 900 + Math.random() * 500, c: Math.random() });
    }
  }
  const start = performance.now();
  return new Promise((resolve) => {
    loop((now) => {
      const t = now - start;
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = 'rgba(17,14,12,0.35)';
      ctx.fillRect(0, 0, w, h);
      for (const a of parts) {
        if (t < a.at) {
          const heatT = Math.min(1, t / 900);
          const r = Math.round(127 + (255 - 127) * heatT);
          const g = Math.round(216 - (216 - 210) * heatT);
          const b = Math.round(242 - (242 - 122) * heatT);
          ctx.fillStyle = `rgb(${r},${g},${b})`;
          ctx.fillRect(a.x, a.y, 4, 4);
          continue;
        }
        const life = (t - a.at) / 1400;
        if (life >= 1) continue;
        a.x += a.vx + Math.sin((t + a.c * 1000) / 200) * 0.3;
        a.y += a.vy;
        const ash = Math.min(1, life * 2);
        const r = Math.round(255 - (255 - 120) * ash);
        const g = Math.round(130 - (130 - 115) * ash);
        const b = Math.round(40 + (110 - 40) * ash);
        ctx.fillStyle = `rgba(${r},${g},${b},${1 - life})`;
        ctx.fillRect(a.x, a.y, 3, 3);
      }
      if (t > 3400) {
        stop();
        resolve();
        return false;
      }
    });
  });
}

// ---------- sigil: a six-fold snowflake grown from the padlock fingerprint ----------
export function drawSigil(canvas: HTMLCanvasElement, hash: Uint8Array, color: string): () => void {
  const { ctx, size, stop } = setup(canvas, () => draw());
  function draw() {
    const { w, h } = size;
    ctx.clearRect(0, 0, w, h);
    const R = Math.min(w, h) * 0.44;
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.strokeStyle = color;
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(1.6, R / 40);
    for (let k = 0; k < 6; k++) {
      ctx.save();
      ctx.rotate((k * Math.PI) / 3);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(0, -R);
      ctx.stroke();
      for (let j = 0; j < 4; j++) {
        const pos = R * (0.26 + j * 0.17 + (hash[6 + j] / 255) * 0.06);
        const len = R * (0.1 + (hash[10 + j] / 255) * 0.24) * (1 - j * 0.16);
        const ang = ((28 + (hash[14 + j] / 255) * 34) * Math.PI) / 180;
        for (const s of [-1, 1]) {
          ctx.beginPath();
          ctx.moveTo(0, -pos);
          ctx.lineTo(Math.sin(ang) * len * s, -pos - Math.cos(ang) * len);
          ctx.stroke();
        }
      }
      ctx.beginPath();
      const tip = R * (0.05 + (hash[18] / 255) * 0.05);
      ctx.moveTo(0, -R - tip);
      ctx.lineTo(tip, -R);
      ctx.lineTo(0, -R + tip);
      ctx.lineTo(-tip, -R);
      ctx.closePath();
      ctx.stroke();
      ctx.restore();
    }
    const hex = R * (0.12 + (hash[19] / 255) * 0.1);
    ctx.beginPath();
    for (let k = 0; k <= 6; k++) {
      const a = (k * Math.PI) / 3 + Math.PI / 6;
      if (k) ctx.lineTo(Math.cos(a) * hex, Math.sin(a) * hex);
      else ctx.moveTo(Math.cos(a) * hex, Math.sin(a) * hex);
    }
    ctx.stroke();
    ctx.restore();
  }
  draw();
  return stop;
}
