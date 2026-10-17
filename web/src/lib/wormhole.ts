/* "Drop a folder into the 0" (ported from the design file `Drop a folder into the 0.html`).
   Calm and still at rest; all motion (zoom, embers, light) only while files travel.
   Additions for the product: real folder traversal on drop, a working progress ring,
   a separate folder picker, and lock() once a transfer starts. */

export interface Wormhole {
  setStatus(title: string, sub?: string): void;
  setProgress(p: number | null): void;
  complete(title?: string, sub?: string): void;
  reset(): void;
  lock(locked: boolean): void;
  chooseFiles(): void;
  chooseFolder(): void;
  destroy(): void;
}

export interface WormholeOptions {
  title?: string;
  hint?: string;
  interactive?: boolean;
  onFiles?(files: File[]): void;
}

const TAU = Math.PI * 2;
const clamp = (v: number, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const sstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const ease = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
const RATIO = 1.46,
  ROUND = 2.5,
  PTS = 120,
  SHRINK = 0.74,
  RINGS = 26,
  FRONT = 3;
const UX: number[] = [],
  UY: number[] = [];
for (let i = 0; i <= PTS; i++) {
  const th = -Math.PI / 2 + (TAU * i) / PTS,
    c = Math.cos(th),
    s = Math.sin(th);
  UX.push(Math.sign(c) * Math.pow(Math.abs(c), 2 / ROUND));
  UY.push(Math.sign(s) * Math.pow(Math.abs(s), 2 / ROUND) * RATIO);
}

export const fmtSize = (b: number) =>
  b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(0) + ' KB' : b < 1073741824 ? (b / 1048576).toFixed(1) + ' MB' : (b / 1073741824).toFixed(2) + ' GB';

/** Read every file from a drop, walking into folders. Paths become "Folder/sub/file.ext". */
async function filesFromDrop(dt: DataTransfer): Promise<File[]> {
  const entries = Array.from(dt.items || [])
    .map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null))
    .filter(Boolean) as any[];
  if (!entries.length) return Array.from(dt.files);
  const out: File[] = [];
  const walk = async (e: any, path: string): Promise<void> => {
    if (e.isFile) {
      const f: File = await new Promise((res, rej) => e.file(res, rej));
      out.push(path ? new File([f], path + f.name, { type: f.type, lastModified: f.lastModified }) : f);
    } else if (e.isDirectory) {
      const reader = e.createReader();
      for (;;) {
        const batch: any[] = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const child of batch) await walk(child, path + e.name + '/');
      }
    }
  };
  for (const e of entries) await walk(e, '');
  return out;
}

const withPaths = (files: File[]) =>
  files.map((f) => ((f as any).webkitRelativePath ? new File([f], (f as any).webkitRelativePath, { type: f.type, lastModified: f.lastModified }) : f));

/** One card per top-level folder or loose file, like the design file. */
function groups(files: File[]) {
  const m = new Map<string, { name: string; count: number; bytes: number; folder: boolean }>();
  for (const f of files) {
    const parts = f.name.split('/');
    const top = parts.length > 1 ? parts[0] : f.name;
    const g = m.get(top) || { name: top, count: 0, bytes: 0, folder: parts.length > 1 };
    g.count++;
    g.bytes += f.size;
    m.set(top, g);
  }
  return [...m.values()].map((g) => ({ name: g.name, meta: g.folder ? `${g.count} ${g.count === 1 ? 'file' : 'files'} · ${fmtSize(g.bytes)}` : fmtSize(g.bytes) }));
}

export function mountWormhole(root: HTMLElement, opts: WormholeOptions = {}): Wormhole {
  const o = { title: 'Drop a folder into the 0', hint: 'Or click to choose files. They are encrypted on your device first.', interactive: true, onFiles() {}, ...opts };
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const K = reduced ? 0.25 : 1;
  let locked = !o.interactive;

  root.classList.add('zw');
  if (o.interactive) {
    root.tabIndex = 0;
    root.setAttribute('role', 'button');
    root.setAttribute('aria-label', o.title);
  }
  root.innerHTML =
    '<canvas aria-hidden="true"></canvas><div class="zw-label"><div class="zw-title"></div><div class="zw-sub" aria-live="polite"></div></div><input type="file" multiple hidden><input type="file" multiple hidden webkitdirectory>';
  const cv = root.querySelector('canvas')!,
    ctx = cv.getContext('2d')!;
  const titleEl = root.querySelector<HTMLElement>('.zw-title')!,
    subEl = root.querySelector<HTMLElement>('.zw-sub')!;
  const [input, folderInput] = Array.from(root.querySelectorAll('input'));

  let W = 0,
    H = 0,
    dpr = 1,
    cx = 0,
    cy = 0,
    R0 = 100;
  let z = 0,
    speed = 0,
    px = 0,
    py = 0,
    tx = 0,
    ty = 0,
    tm = 0;
  let inside = false,
    dragging = false,
    progress: number | null = null,
    prog = 0,
    pv = 0,
    closing = 0;
  let flash = 0,
    burst = 1,
    raf = 0,
    last = 0;
  type Chip = { name: string; meta: string; label: string; mode: number; t: number; sc: number; x0: number; y0: number; u: number; delay: number; dur: number };
  let chips: Chip[] = [];
  let sparks: { x: number; y: number; l: number }[] = [];
  let embers: { a: number; q: number; v: number; dead: boolean }[] = [];

  let tt = 0,
    pend: [string, string] | null = null;
  function setStatus(t: string, s = '') {
    const lab = titleEl.parentNode as HTMLElement;
    if (!titleEl.textContent || titleEl.textContent === t) {
      if (!pend) {
        titleEl.textContent = t;
        subEl.textContent = s;
      } else pend = [t, s];
      return;
    }
    pend = [t, s];
    lab.style.opacity = '0';
    clearTimeout(tt);
    tt = window.setTimeout(() => {
      titleEl.textContent = pend![0];
      subEl.textContent = pend![1];
      pend = null;
      lab.style.opacity = '1';
    }, 240);
  }
  setStatus(o.title, o.hint);

  function resize() {
    dpr = Math.min(devicePixelRatio || 1, 2);
    W = root.clientWidth;
    H = root.clientHeight;
    cv.width = W * dpr;
    cv.height = H * dpr;
    cx = W / 2;
    cy = H * 0.42;
    R0 = Math.min(W * 0.27, H * 0.22);
  }
  const ro = new ResizeObserver(resize);
  ro.observe(root);
  resize();

  function chipPos(c: Chip, e: number): [number, number] {
    const dx = cx - c.x0,
      dy = cy - c.y0,
      len = Math.hypot(dx, dy) || 1,
      bow = Math.sin(Math.PI * e) * len * 0.18;
    return [c.x0 + dx * e + (-dy / len) * bow, c.y0 + dy * e + (dx / len) * bow];
  }

  function update(dt: number) {
    tm += dt;
    let target = 0;
    if (dragging) target = 0.35;
    if (inside) target = 3.2;
    if (chips.some((c) => !c.mode)) target = 3.2;
    if (progress !== null && progress < 1) target = Math.max(target, 1.1);
    speed += (target * K - speed) * Math.min(1, dt * (target * K > speed ? 2.4 : 1.2));
    if (target === 0 && speed < 0.01) speed = 0;
    z += speed * dt;
    if (target === 0 && speed === 0) {
      const c = Math.ceil(z);
      if (c - z > 0) {
        z += (c - z) * Math.min(1, dt * 3);
        if (c - z < 0.002) z = c;
      }
    }
    px += (tx - px) * Math.min(1, dt * 5);
    py += (ty - py) * Math.min(1, dt * 5);
    flash = Math.max(0, flash - dt * 1.3);
    if (burst < 1) burst = Math.min(1, burst + dt / 1.2);
    if (progress !== null) {
      pv += ((progress - prog) * 38 - pv * 11) * dt;
      prog = clamp(prog + pv * dt);
    }
    if (closing > 0) {
      closing -= dt;
      if (closing <= 0) progress = null;
    }
    for (let i = chips.length - 1; i >= 0; i--) {
      const c = chips[i];
      if (c.delay > 0) {
        c.delay -= dt;
        continue;
      }
      if (c.mode === 2) {
        c.t += dt / 1.4;
        if (c.t >= 1) chips.splice(i, 1);
        continue;
      }
      if (c.mode === 1) continue;
      c.u += dt / c.dur;
      const p = chipPos(c, ease(clamp(c.u)));
      if (c.u < 0.95 && Math.random() < 0.6) sparks.push({ x: p[0] + (Math.random() - 0.5) * 16, y: p[1] + (Math.random() - 0.5) * 12, l: 1 });
      if (c.u >= 1) {
        c.u = 1;
        c.mode = 1;
        flash = Math.min(1, flash + 0.5);
      }
    }
    for (let i = sparks.length - 1; i >= 0; i--) {
      const s = sparks[i];
      s.x += (cx - s.x) * dt * 3;
      s.y += (cy - s.y) * dt * 3;
      s.l -= dt * 1.5;
      if (s.l <= 0) sparks.splice(i, 1);
    }
    const open = clamp(speed / (K * 1.2)),
      want = Math.round(44 * open);
    while (embers.length < want) embers.push({ a: Math.random() * TAU, q: 0.05 + Math.random() * 0.25, v: 0.6 + Math.random() * 0.8, dead: false });
    for (const e of embers) {
      e.q *= 1 + dt * speed * e.v * 0.9;
      if (e.q > 2.6) {
        if (embers.length > want) e.dead = true;
        else {
          e.q = 0.04 + Math.random() * 0.06;
          e.a = Math.random() * TAU;
        }
      }
    }
    if (embers.some((e) => e.dead)) embers = embers.filter((e) => !e.dead);
  }

  function trace(x: number, y: number, a: number, rot = 0) {
    const c = Math.cos(rot),
      s = Math.sin(rot);
    ctx.beginPath();
    for (let i = 0; i <= PTS; i++) {
      const u = UX[i] * a,
        v = UY[i] * a,
        X = x + u * c - v * s,
        Y = y + u * s + v * c;
      i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y);
    }
  }
  function pointAt(t: number, a: number): [number, number] {
    const i = Math.min(PTS - 1, Math.floor(t)),
      f = t - i;
    return [cx + (UX[i] + (UX[i + 1] - UX[i]) * f) * a, cy + (UY[i] + (UY[i + 1] - UY[i]) * f) * a];
  }
  function arc(t0: number, t1: number, a: number) {
    ctx.beginPath();
    let p = pointAt(t0, a);
    ctx.moveTo(p[0], p[1]);
    for (let i = Math.ceil(t0); i < t1; i++) {
      p = pointAt(i, a);
      ctx.lineTo(p[0], p[1]);
    }
    p = pointAt(t1, a);
    ctx.lineTo(p[0], p[1]);
  }
  function rr(x: number, y: number, w: number, h: number, r: number) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    const open = clamp(speed / (K * 1.2)),
      zf = z - Math.floor(z);

    const fl = clamp(0.05 + open * 0.7 + flash * 0.9),
      fr = R0 * (0.14 + 0.55 * open + 0.35 * flash);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(1, RATIO);
    ctx.globalCompositeOperation = 'lighter';
    const cg = ctx.createRadialGradient(0, 0, 0, 0, 0, fr);
    cg.addColorStop(0, 'rgba(255,238,205,' + fl + ')');
    cg.addColorStop(0.3, 'rgba(255,140,40,' + fl * 0.5 + ')');
    cg.addColorStop(1, 'rgba(255,106,19,0)');
    ctx.fillStyle = cg;
    ctx.beginPath();
    ctx.arc(0, 0, fr, 0, TAU);
    ctx.fill();
    ctx.restore();
    ctx.globalCompositeOperation = 'source-over';

    const span = Math.max(0.001, 2.4 * open),
      blur = Math.min(1, speed / (K * 2));
    for (let j = RINGS - 1; j >= 0; j--) {
      const k = j - FRONT - zf,
        s = Math.pow(SHRINK, k);
      let A = Math.pow(clamp(s), 0.35) * clamp(s / 0.02) * (1 - sstep(1.0005, 1.0005 + span, s));
      A *= open + (1 - open) * clamp(1 - k * 0.18);
      if (A < 0.01) continue;
      const deep = 1 - clamp(s),
        a = R0 * s,
        lw = 0.12 * a,
        rot = deep * 0.3 * open;
      const ph = k * 0.6 + tm * 0.4;
      const rx = cx - px * R0 * 0.12 * deep + Math.cos(ph) * R0 * 0.05 * open * deep;
      const ry = cy - py * R0 * 0.12 * deep + Math.sin(ph) * R0 * 0.05 * open * deep;
      if (blur > 0.12)
        for (let g = 2; g >= 1; g--) {
          const gs = s * Math.pow(SHRINK, 0.18 * g * blur);
          trace(rx, ry, R0 * gs, rot);
          ctx.strokeStyle = 'rgba(255,110,25,' + (0.18 / g) * A * blur + ')';
          ctx.lineWidth = 0.17 * R0 * gs;
          ctx.stroke();
        }
      trace(rx, ry, a, rot);
      ctx.strokeStyle = 'rgba(255,106,19,' + 0.06 * A + ')';
      ctx.lineWidth = lw * 2.4;
      ctx.stroke();
      const mg = (106 - 62 * deep) | 0;
      const g = ctx.createLinearGradient(rx - a, ry - a * RATIO, rx + a, ry + a * RATIO);
      g.addColorStop(0, 'rgba(255,196,120,' + A + ')');
      g.addColorStop(0.42, 'rgba(255,' + mg + ',' + ((19 + 8 * deep) | 0) + ',' + A + ')');
      g.addColorStop(1, 'rgba(92,28,5,' + A + ')');
      ctx.strokeStyle = g;
      ctx.lineWidth = lw;
      ctx.stroke();
      if (open > 0.05 && (ctx as any).createConicGradient) {
        const sw = (ctx as any).createConicGradient(tm * (1.1 + open * 2.5) + k * 0.55, rx, ry),
          Ao = A * open;
        sw.addColorStop(0, 'rgba(255,244,205,' + Ao + ')');
        sw.addColorStop(0.12, 'rgba(255,230,170,0)');
        sw.addColorStop(0.88, 'rgba(255,230,170,0)');
        sw.addColorStop(1, 'rgba(255,244,205,' + Ao + ')');
        trace(rx, ry, a * 1.08, rot);
        ctx.strokeStyle = sw;
        ctx.lineWidth = lw * 0.18;
        ctx.stroke();
      }
    }

    ctx.globalCompositeOperation = 'lighter';
    for (const e of embers) {
      const c = Math.cos(e.a),
        s = Math.sin(e.a);
      const ux = Math.sign(c) * Math.pow(Math.abs(c), 2 / ROUND),
        uy = Math.sign(s) * Math.pow(Math.abs(s), 2 / ROUND) * RATIO;
      const q0 = e.q / (1 + speed * 0.05),
        al = sstep(0.05, 0.3, e.q) * (1 - sstep(1.6, 2.6, e.q));
      ctx.strokeStyle = 'rgba(255,176,88,' + al * 0.8 + ')';
      ctx.lineWidth = 0.6 + 1.4 * e.q;
      ctx.beginPath();
      ctx.moveTo(cx + ux * R0 * q0, cy + uy * R0 * q0);
      ctx.lineTo(cx + ux * R0 * e.q, cy + uy * R0 * e.q);
      ctx.stroke();
    }
    for (const s of sparks) {
      ctx.fillStyle = 'rgba(255,150,50,' + s.l * 0.9 + ')';
      ctx.beginPath();
      ctx.arc(s.x, s.y, 1 + 2 * s.l, 0, TAU);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';

    if (burst < 1) {
      trace(cx, cy, R0 * (1 + burst * 1.7));
      ctx.strokeStyle = 'rgba(255,140,40,' + (1 - burst) * 0.9 + ')';
      ctx.lineWidth = 3 * (1 - burst) + 0.5;
      ctx.stroke();
    }

    if (progress !== null) {
      const t = prog * PTS,
        ra = R0 * 1.22;
      trace(cx, cy, ra);
      ctx.strokeStyle = 'rgba(255,106,19,.14)';
      ctx.lineWidth = 2;
      ctx.stroke();
      if (t > 0.5) {
        arc(0, t, ra);
        ctx.strokeStyle = '#ff7a1c';
        ctx.lineWidth = 3;
        ctx.stroke();
        const hp = pointAt(t, ra),
          hg = ctx.createRadialGradient(hp[0], hp[1], 0, hp[0], hp[1], 14);
        hg.addColorStop(0, 'rgba(255,250,235,1)');
        hg.addColorStop(0.3, 'rgba(255,190,100,.7)');
        hg.addColorStop(1, 'rgba(255,106,19,0)');
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = hg;
        ctx.beginPath();
        ctx.arc(hp[0], hp[1], 14, 0, TAU);
        ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
      }
    }

    for (const c of chips) {
      if (c.delay > 0) continue;
      const e = ease(clamp(c.u)),
        p = chipPos(c, e);
      const st = c.mode ? 1 : sstep(0.3, 0.9, e),
        sc = c.mode === 2 ? c.sc * (1 - sstep(0, 1, c.t)) : c.mode === 1 ? 0.28 + 0.06 * Math.sin(tm * 1.6) : 1 - 0.66 * e;
      c.sc = sc;
      ctx.save();
      ctx.translate(p[0], p[1]);
      ctx.scale(sc, sc);
      ctx.globalAlpha = c.mode === 2 ? 1 - sstep(0.35, 1, c.t) : 1;
      const bg = ctx.createLinearGradient(0, -60, 0, 60);
      bg.addColorStop(0, '#ff9a4a');
      bg.addColorStop(1, '#7a2a0a');
      ctx.fillStyle = bg;
      rr(-84, -62, 62, 22, 8);
      ctx.fill();
      rr(-84, -50, 168, 110, 14);
      ctx.fill();
      rr(-84, -30, 168, 90, 14);
      const fg = ctx.createLinearGradient(0, -30, 0, 60);
      fg.addColorStop(0, 'rgba(255,244,232,.34)');
      fg.addColorStop(1, 'rgba(255,236,220,.14)');
      ctx.fillStyle = fg;
      ctx.fill();
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = 'rgba(255,255,255,.6)';
      ctx.shadowColor = '#ff6a13';
      ctx.shadowBlur = 14 * dpr;
      ctx.stroke();
      ctx.shadowBlur = 0;
      if (st < 0.8) {
        ctx.globalAlpha *= 1 - st * 1.3;
        ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = '#fff';
        ctx.font = '500 14px "Instrument Sans",system-ui,sans-serif';
        ctx.fillText(c.name, -70, 32);
        ctx.fillStyle = 'rgba(255,255,255,.72)';
        ctx.font = '10.5px ui-monospace,Menlo,monospace';
        ctx.fillText(c.meta, -70, 48);
      }
      ctx.restore();
    }
    for (const c of chips) {
      if (c.delay > 0) continue;
      const e = ease(clamp(c.u)),
        a = c.mode === 2 ? 1 - sstep(0, 0.5, c.t) : c.mode === 1 ? 1 : sstep(0.55, 1, e);
      if (a < 0.02) continue;
      const p = chipPos(c, e),
        y = p[1] + 60 * c.sc + 22;
      ctx.font = '500 14px "Instrument Sans",system-ui,sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const w = ctx.measureText(c.label).width + 26;
      ctx.globalAlpha = a * 0.8;
      ctx.fillStyle = 'rgba(10,6,4,.75)';
      rr(p[0] - w / 2, y - 14, w, 28, 14);
      ctx.fill();
      ctx.globalAlpha = a;
      ctx.fillStyle = '#f6ede3';
      ctx.fillText(c.label, p[0], y);
      ctx.textAlign = 'left';
    }
    ctx.globalAlpha = 1;
  }

  function frame(ts: number) {
    const dt = Math.min(0.05, (ts - last) / 1000 || 0);
    last = ts;
    update(dt);
    draw();
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);

  const short = (n: string) => (n.length > 16 ? n.slice(0, 9) + '…' + n.slice(-5) : n);
  function swallow(items: { name: string; meta: string }[], pt?: { x: number; y: number }) {
    const r = root.getBoundingClientRect();
    const x0 = pt ? clamp(pt.x - r.left, 0, W) : W / 2,
      y0 = pt ? clamp(pt.y - r.top, 0, H) : H * 0.84;
    inside = true;
    dragging = false;
    tx = 0;
    ty = 0;
    root.classList.remove('zw-drag');
    chips = [];
    items.slice(0, 6).forEach((it, i) =>
      chips.push({
        name: short(it.name),
        meta: it.meta,
        label: it.name.length > 28 ? it.name.slice(0, 25) + '…' : it.name,
        mode: 0,
        t: 0,
        sc: 1,
        x0,
        y0,
        u: 0,
        delay: i * 0.22,
        dur: reduced ? 0.3 : 1.6,
      }),
    );
    setTimeout(() => (inside = false), 2400);
  }
  function handle(files: File[], pt?: { x: number; y: number }) {
    if (!files.length || locked) return;
    swallow(groups(files), pt);
    o.onFiles(files);
  }

  const on = <K extends keyof HTMLElementEventMap>(el: HTMLElement, ev: K, fn: (e: HTMLElementEventMap[K]) => void) => el.addEventListener(ev, fn as EventListener);
  on(root, 'dragenter', (e) => {
    e.preventDefault();
    if (locked) return;
    dragging = true;
    root.classList.add('zw-drag');
  });
  on(root, 'dragover', (e) => {
    e.preventDefault();
    if (locked) return;
    dragging = true;
    const r = root.getBoundingClientRect();
    tx = clamp(((e.clientX - r.left) / r.width - 0.5) * 2, -1, 1);
    ty = clamp(((e.clientY - r.top) / r.height - 0.5) * 2, -1, 1);
  });
  on(root, 'dragleave', (e) => {
    if (!root.contains(e.relatedTarget as Node)) {
      dragging = false;
      root.classList.remove('zw-drag');
    }
  });
  on(root, 'drop', (e) => {
    e.preventDefault();
    if (locked || !e.dataTransfer) return;
    const pt = { x: e.clientX, y: e.clientY };
    filesFromDrop(e.dataTransfer).then((files) => handle(files, pt));
  });
  on(root, 'pointermove', (e) => {
    const r = root.getBoundingClientRect();
    tx = clamp(((e.clientX - r.left) / r.width - 0.5) * 2, -1, 1);
    ty = clamp(((e.clientY - r.top) / r.height - 0.5) * 2, -1, 1);
  });
  on(root, 'pointerleave', () => {
    tx = 0;
    ty = 0;
  });
  on(root, 'click', () => !locked && input.click());
  on(root, 'keydown', (e) => {
    if (!locked && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      input.click();
    }
  });
  for (const el of [input, folderInput]) {
    on(el, 'click', (e) => e.stopPropagation());
    on(el, 'change', () => {
      handle(withPaths(Array.from(el.files || [])));
      el.value = '';
    });
  }

  return {
    setStatus,
    setProgress(p) {
      progress = p === null ? null : clamp(p);
      if (p === 0) prog = 0;
    },
    complete(t, s) {
      inside = false;
      chips.forEach((c) => {
        c.mode = 2;
        c.t = 0;
      });
      burst = 0;
      closing = 1.4;
      setStatus(t || 'Sent into the 0', s || '');
    },
    reset() {
      inside = false;
      progress = null;
      closing = 0;
      chips = [];
      sparks = [];
      setStatus(o.title, o.hint);
    },
    lock(v) {
      locked = v;
      root.classList.toggle('zw-locked', v);
      if (v) root.removeAttribute('tabindex');
      else if (o.interactive) root.tabIndex = 0;
    },
    chooseFiles() {
      if (!locked) input.click();
    },
    chooseFolder() {
      if (!locked) folderInput.click();
    },
    destroy() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      root.innerHTML = '';
    },
  };
}
