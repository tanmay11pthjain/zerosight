// Sender: pick files or a folder → Send securely → share the link (QR / copy).
// One recipient, one download, then everything is deleted. No settings beyond the timer.
import QRCode from 'qrcode';
import { ApiError, call, listen, onWaking, wake, type BurnInfo, type PublicRoom } from '../lib/api';
import { EntropyPool, MOUSE_POINTS, b64, forgeKey, makeLinkSecret, sealKeybox, unb64 } from '../lib/crypto';
import { forgeFx, loop } from '../lib/fx';
import { uploadAll, type RoomFile } from '../lib/transfer';
import { $, copyText, esc, fmtBytes, h, shell, show } from '../lib/ui';
import { mountWormhole } from '../lib/wormhole';
import { endScreen, isAlarm } from './shared';

const TIMERS: [string, string][] = [
  ['15m', '15 min'],
  ['1h', '1 hour'],
  ['24h', '24 hours'],
];
const TOUCH = matchMedia('(pointer: coarse)').matches;

export function senderFlow(app: HTMLElement): () => void {
  const s = shell(app);
  const cleanups: (() => void)[] = [];
  onWaking((on) => s.waking(on));
  void wake();
  s.step(null);
  s.server('Nothing. Your files are still only on this device.');

  const view = h(`<section class="stage hero">
    <header class="hero-head"><h1>Send files privately</h1><p class="lead">Locked on your device. One person, one download, then gone.</p></header>
    <div class="zero"></div>
    <div class="panel" data-panel></div>
  </section>`);
  s.main.replaceChildren(view);
  const panel = $('[data-panel]', view);
  let files: File[] = [];
  let maxBytes = 1024 ** 3;
  call<{ maxRoomBytes: number }>('GET', '/config')
    .then((c) => (maxBytes = c.maxRoomBytes))
    .catch(() => undefined);

  const wh = mountWormhole($('.zero', view), {
    title: 'Drop files or a folder into the 0',
    hint: TOUCH ? 'Or tap to choose files.' : 'Or click to choose. They are locked on this device first.',
    onFiles(add) {
      const key = (f: File) => `${f.name}:${f.size}`;
      const have = new Set(files.map(key));
      files = [...files, ...add.filter((f) => !have.has(key(f)))];
      renderHome();
    },
  });
  cleanups.push(() => wh.destroy());

  // ---------------- home ----------------
  let timer = '1h';
  function renderHome() {
    const total = files.reduce((t, f) => t + f.size, 0);
    const tooBig = total > maxBytes;
    const el = h(`<div class="home">
      ${
        files.length
          ? `<ul class="files">${files
               .map((f, i) => `<li><span class="fname">${esc(f.name)}</span><span class="fsize">${fmtBytes(f.size)}</span><button class="x" type="button" data-rm="${i}" aria-label="Remove ${esc(f.name)}">×</button></li>`)
               .join('')}</ul>
             <p class="total">${files.length} ${files.length === 1 ? 'file' : 'files'} · <b>${fmtBytes(total)}</b></p>
             <div class="opt"><span id="del">Delete if not opened within</span>
               <span class="seg" role="radiogroup" aria-labelledby="del">${TIMERS.map(
                 ([v, l]) => `<label><input type="radio" name="timer" value="${v}" ${v === timer ? 'checked' : ''}><span>${l}</span></label>`,
               ).join('')}</span></div>
             ${tooBig ? `<p class="error" role="alert">That's ${fmtBytes(total)}. The limit is ${fmtBytes(maxBytes)}.</p>` : ''}
             <button class="btn big" type="button" data-send ${tooBig ? 'disabled' : ''}>Send securely</button>
             <p class="fine">One person can open the link, one time. Then everything is deleted.</p>
             <div class="pick"><button class="link" type="button" data-files>Add files</button>${TOUCH ? '' : '<button class="link" type="button" data-folder>Add a folder</button>'}</div>`
          : `<div class="pick"><button class="btn big" type="button" data-files>Choose files</button>${TOUCH ? '' : '<button class="btn big ghost" type="button" data-folder>Choose a folder</button>'}</div>`
      }
      <p class="error" role="alert" data-err hidden></p>
    </div>`);
    panel.replaceChildren(el);
    el.querySelectorAll<HTMLButtonElement>('[data-rm]').forEach((b) =>
      b.addEventListener('click', () => {
        files.splice(Number(b.dataset.rm), 1);
        if (!files.length) wh.reset();
        renderHome();
      }),
    );
    el.querySelectorAll<HTMLInputElement>('input[name=timer]').forEach((r) => r.addEventListener('change', () => (timer = r.value)));
    el.querySelector('[data-files]')?.addEventListener('click', () => wh.chooseFiles());
    el.querySelector('[data-folder]')?.addEventListener('click', () => wh.chooseFolder());
    el.querySelector('[data-send]')?.addEventListener('click', (e) => void send(e.currentTarget as HTMLButtonElement, $('[data-err]', el)));
  }
  renderHome();

  async function send(btn: HTMLButtonElement, err: HTMLElement) {
    btn.disabled = true;
    btn.textContent = 'Preparing…';
    let room: { roomId: string; ownerToken: string; files: RoomFile[] };
    try {
      room = await call('POST', '/rooms', { human: true, body: { fuse: timer, files: files.map((f) => ({ size: f.size })) } });
    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Send securely';
      err.hidden = false;
      err.textContent = (e as Error).message;
      return;
    }
    wh.lock(true);
    const fileKey = await forge();
    linkStage(room, fileKey);
  }

  // ---------------- key: 120 pointer points + CPU timing ----------------
  function forge(): Promise<Uint8Array> {
    s.step('key');
    s.server('Nothing. Your key is being made on this device.');
    return new Promise((resolve) => {
      const pool = new EntropyPool();
      const cpu = pool.sampleCpu(64);
      const layer = h(`<div class="forge" role="dialog" aria-modal="true" aria-labelledby="forge-t">
        <canvas aria-hidden="true"></canvas>
        <div class="forge-ui">
          <h2 id="forge-t">${TOUCH ? 'Draw on the screen' : 'Move your mouse around'}</h2>
          <p class="lead">Your movement and this device's processor make a secret key that only exists here.</p>
          <div class="meter" role="progressbar" aria-valuemin="0" aria-valuemax="${MOUSE_POINTS}" aria-valuenow="0"><i></i></div>
          <p class="count"><b>0</b> / ${MOUSE_POINTS}</p>
          <button class="link" type="button" data-skip>Skip</button>
        </div></div>`);
      document.body.append(layer);
      const fx = forgeFx(layer.querySelector('canvas')!);
      const bar = layer.querySelector<HTMLElement>('.meter i')!;
      const meter = layer.querySelector<HTMLElement>('.meter')!;
      const count = layer.querySelector('.count b')!;
      let last = performance.now();
      const stopCpu = loop((t) => {
        pool.addCpu(t - last);
        last = t;
      });
      let finished = false;
      const update = (n: number) => {
        bar.style.width = `${(n / MOUSE_POINTS) * 100}%`;
        meter.setAttribute('aria-valuenow', String(n));
        count.textContent = String(n);
        fx.setHeat(n / MOUSE_POINTS);
        if (n >= MOUSE_POINTS) void finish();
      };
      const onMove = (e: PointerEvent) => {
        fx.spawn(e.clientX, e.clientY, 3);
        update(pool.addPoint(e.clientX, e.clientY, e.timeStamp));
      };
      const onKey = (e: KeyboardEvent) => {
        if (e.repeat || e.target instanceof HTMLButtonElement) return;
        let n = 0;
        for (let i = 0; i < 4; i++) n = pool.addPoint((e.timeStamp * 7.3 + i * 97) % innerWidth, (e.key.charCodeAt(0) * 13 + i * 61 + e.timeStamp) % innerHeight, e.timeStamp + i);
        fx.spawn(Math.random() * innerWidth, innerHeight * 0.7, 12, 1.4);
        update(n);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerdown', onMove);
      window.addEventListener('keydown', onKey);
      layer.querySelector('[data-skip]')!.addEventListener('click', () => void finish());
      async function finish() {
        if (finished) return;
        finished = true;
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerdown', onMove);
        window.removeEventListener('keydown', onKey);
        await cpu;
        stopCpu();
        const key = await forgeKey(pool);
        layer.classList.add('flash');
        setTimeout(() => {
          fx.destroy();
          layer.remove();
          resolve(key);
        }, 450);
      }
    });
  }

  // ---------------- share link, upload, hand over the key ----------------
  function linkStage(room: { roomId: string; ownerToken: string; files: RoomFile[] }, key: Uint8Array) {
    let fileKey: Uint8Array | null = key;
    const linkSecret = makeLinkSecret();
    const link = `${location.origin}/#/r/${room.roomId}.${linkSecret}`;
    const T = room.ownerToken;
    const totalBytes = files.reduce((t, f) => t + f.size, 0);
    let uploaded = false;
    let keyed = false;
    let ended = false;
    let sealing = false;

    s.step('lock', ['key']);
    s.server('Encrypted pieces only. No file names, no key.');
    view.classList.remove('hero');
    const el = h(`<div class="link-stage">
      <h1>Share this link</h1>
      <div class="share">
        <div class="qr" aria-label="QR code of the link"></div>
        <div class="share-side">
          <p class="fine">Scan with the other phone, or copy the link and send it.</p>
          <div class="linkbox"><input readonly value="${esc(link)}" aria-label="Secure link"><button class="btn" type="button" data-copy>Copy</button></div>
          ${'share' in navigator ? '<button class="btn ghost small" type="button" data-share>Share…</button>' : ''}
        </div>
      </div>
      <ol class="status" data-status>
        <li data-s="upload" class="now">Locking and uploading your files… <b data-pct>0%</b></li>
        <li data-s="open">Waiting for the other person to open the link</li>
        <li data-s="key">Handing over the key</li>
        <li data-s="download">They download, then everything is deleted</li>
      </ol>
      <p class="keep" data-keep>Keep this page open until the other person opens the link.</p>
      <ul class="files progress">${files.map((f, i) => `<li data-f="${i}"><span class="fname">${esc(f.name)}</span><span class="fsize">${fmtBytes(f.size)}</span><span class="bar"><i></i></span></li>`).join('')}</ul>
      <p class="banner" data-late hidden>Someone tried your link after it was deleted.</p>
      <button class="btn ghost danger small" type="button" data-destroy>Cancel and delete</button>
    </div>`);
    panel.replaceChildren(el);
    QRCode.toString(link, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#070504', light: '#f6ede3' } }).then((svg) => ($('.qr', el).innerHTML = svg));
    copyText($('[data-copy]', el), link, $('input', el));
    $<HTMLInputElement>('input', el).addEventListener('focus', (e) => (e.target as HTMLInputElement).select());
    el.querySelector('[data-share]')?.addEventListener('click', () => void navigator.share({ title: 'ZeroSight', text: 'I sent you files with ZeroSight. Open this link on the device you want to save them on:', url: link }).catch(() => undefined));

    const mark = (step: string, state: 'now' | 'done') => {
      const steps = ['upload', 'open', 'key', 'download'];
      const at = steps.indexOf(step);
      el.querySelectorAll<HTMLElement>('[data-s]').forEach((li, i) => {
        li.classList.toggle('done', i < at || (i === at && state === 'done'));
        li.classList.toggle('now', i === at && state === 'now');
      });
    };

    // Keep the screen awake and warn before closing while this tab holds the only key.
    let lock: any = null;
    const grabLock = async () => {
      try {
        if (document.visibilityState === 'visible' && fileKey) lock = await (navigator as any).wakeLock?.request('screen');
      } catch {
        /* not supported */
      }
    };
    void grabLock();
    document.addEventListener('visibilitychange', grabLock);
    const guard = (e: BeforeUnloadEvent) => {
      if (fileKey && !ended) e.preventDefault();
    };
    window.addEventListener('beforeunload', guard);
    const beat = setInterval(() => void call('POST', `/rooms/${room.roomId}/heartbeat`, { token: T, body: {} }).catch(() => undefined), 20_000);
    cleanups.push(() => {
      clearInterval(beat);
      window.removeEventListener('beforeunload', guard);
      document.removeEventListener('visibilitychange', grabLock);
      void lock?.release?.();
    });

    const done = new Array(files.length).fill(0);
    wh.setProgress(0);
    wh.setStatus('Falling into the 0', 'Locking your files on this device');
    uploadAll(
      room.roomId,
      T,
      key,
      files,
      room.files,
      (i, d, t) => {
        done[i] = d;
        const bar = el.querySelector<HTMLElement>(`[data-f="${i}"] .bar i`);
        if (bar) bar.style.width = `${t ? (d / t) * 100 : 100}%`;
        const p = totalBytes ? done.reduce((a, b) => a + b, 0) / totalBytes : 1;
        wh.setProgress(p);
        wh.setStatus('Travelling through the 0', `Locked and uploading, ${Math.round(p * 100)}%`);
        $('[data-pct]', el).textContent = `${Math.round(p * 100)}%`;
      },
      () => ended,
    )
      .then(() => {
        uploaded = true;
        wh.complete('Locked in the 0', 'Nothing readable left this device.');
        s.server(`${fmtBytes(totalBytes)} of scrambled data. It cannot read it.`);
        $('[data-pct]', el).textContent = 'done';
        if (!keyed) mark('open', 'now');
        checkDone();
      })
      .catch((e) => {
        if (ended) return;
        const box = $('[data-keep]', el);
        box.classList.add('bad');
        box.textContent = `Upload stopped: ${(e as Error).message} Press "Cancel and delete", then send again.`;
      });

    async function handOver(receiverId: string, padlockB64: string) {
      if (!fileKey || keyed || sealing) return;
      sealing = true;
      mark('key', 'now');
      try {
        const box = await sealKeybox(fileKey, unb64(padlockB64), linkSecret, room.roomId);
        await call('POST', `/rooms/${room.roomId}/keybox`, { token: T, body: { receiverId, keybox: b64(box) } });
        keyed = true;
        checkDone();
      } finally {
        sealing = false;
      }
    }
    function checkDone() {
      if (keyed) mark(uploaded ? 'download' : 'upload', 'now');
      if (!uploaded || !keyed || !fileKey) return;
      fileKey.fill(0);
      fileKey = null;
      void lock?.release?.();
      s.step('send', ['key', 'lock']);
      const keep = $('[data-keep]', el);
      keep.classList.add('ok');
      keep.textContent = 'Key delivered. You can close this page. The files are deleted as soon as they download them.';
    }
    async function refresh() {
      try {
        const me = await call<PublicRoom & { receivers: { id: string; padlock: string | null; keyed: boolean; done: boolean }[] }>('GET', `/rooms/${room.roomId}/me`, { token: T });
        if (me.burn) return end(me.burn);
        const r = me.receivers[0];
        if (!r) return;
        if (!keyed && !r.keyed && !uploaded) mark('upload', 'now');
        if (r.keyed) {
          keyed = true;
          checkDone();
        } else if (r.padlock) await handOver(r.id, r.padlock);
        else mark('key', 'now');
      } catch {
        /* retried on the next event */
      }
    }
    function end(b: BurnInfo) {
      if (ended) return;
      ended = true;
      fileKey?.fill(0);
      fileKey = null;
      stopEvents();
      s.step(null, ['key', 'lock', 'send', 'delete']);
      s.alarm(isAlarm(b.reason));
      s.server(`Nothing. Deleted at ${new Date(b.at).toLocaleTimeString()}.`);
      show(s.main, endScreen(b, 'sender'));
    }

    const stopEvents = listen(
      room.roomId,
      T,
      (ev, data) => {
        if (ev === 'joined') void refresh();
        else if (ev === 'padlock') void handOver(data.receiverId, data.padlock);
        else if (ev === 'burned') end(data);
        else if (ev === 'late-open') $('[data-late]', el).hidden = false;
      },
      () => void refresh(),
    );
    cleanups.push(stopEvents);
    // Polling backup: some networks and proxies buffer live events. Progress never depends on them.
    const poll = setInterval(() => !ended && void refresh(), 3000);
    cleanups.push(() => clearInterval(poll));
    $('[data-destroy]', el).addEventListener('click', async (e) => {
      (e.currentTarget as HTMLButtonElement).disabled = true;
      try {
        await call('POST', `/rooms/${room.roomId}/burn`, { token: T, body: {} });
      } catch (err) {
        if (!(err instanceof ApiError)) throw err;
      }
      await refresh();
    });
  }

  return () => {
    cleanups.splice(0).forEach((f) => f());
    s.alarm(false);
  };
}
