// Receiver: open the link → "Receive files" → "Save files". One device, one download.
import { ApiError, call, listen, onWaking, wake, type BurnInfo, type PublicRoom } from '../lib/api';
import { SealBrokenError, b64, b64url, makePadlock, openKeybox, unb64, type Manifest } from '../lib/crypto';
import { idbDel, idbGet, idbSet } from '../lib/idb';
import { canStream, collectSink, registerStreamWorker, saveBlob, streamSink } from '../lib/sinks';
import { downloadFile, fetchManifest } from '../lib/transfer';
import { $, copyText, esc, fmtBytes, h, local, shell, show } from '../lib/ui';
import { mountWormhole } from '../lib/wormhole';
import { ZipWriter } from '../lib/zip';
import { endScreen, errorScreen, isAlarm } from './shared';

const IN_APP = /FBAN|FBAV|Instagram|Line\/|LinkedInApp|WhatsApp|Snapchat|MicroMessenger|; wv\)/i;

export function receiverFlow(app: HTMLElement, roomId: string, linkSecret: string): () => void {
  const s = shell(app);
  const cleanups: (() => void)[] = [];
  onWaking((on) => s.waking(on));
  void registerStreamWorker();
  s.step(null);
  s.server('Scrambled data it cannot read. No file names, no key.');

  const view = h(`<section class="stage"><div class="zero"></div><div class="panel" data-panel></div></section>`);
  s.main.replaceChildren(view);
  const panel = $('[data-panel]', view);
  const wh = mountWormhole($('.zero', view), { interactive: false, title: 'Your files are in the 0', hint: 'Only this link can bring them out.' });
  cleanups.push(() => wh.destroy());
  const storeKey = `zs:r:${roomId}`;
  let ended = false;

  function end(b: BurnInfo, animate = true) {
    if (ended) return;
    ended = true;
    void idbDel(`zs:sk:${roomId}`);
    s.step(null, ['key', 'lock', 'send', 'delete']);
    s.alarm(isAlarm(b.reason));
    s.server(`Nothing. Deleted at ${new Date(b.at).toLocaleTimeString()}.`);
    show(s.main, endScreen(b, 'receiver', animate));
  }
  const fail = (title: string, msg: string) => show(s.main, errorScreen(title, msg));

  if (!/^[0-9a-f]{64}$/.test(roomId) || !/^[A-Za-z0-9_-]{43}$/.test(linkSecret)) {
    fail('This link is incomplete.', 'Ask the sender to copy the whole link and send it again.');
    return () => cleanups.forEach((f) => f());
  }

  void (async () => {
    await wake();
    let room: PublicRoom;
    try {
      room = await call<PublicRoom>('GET', `/rooms/${roomId}`);
    } catch (e) {
      return fail('This link does not work.', e instanceof ApiError && e.status === 404 ? 'No transfer matches this link. It may have been deleted.' : (e as Error).message);
    }
    if (room.burn) return end(room.burn, false);
    if (local(storeKey)) return resume();
    intro(room);
  })();

  // ---------------- 1. what is this + Receive ----------------
  function intro(room: PublicRoom) {
    const inApp = IN_APP.test(navigator.userAgent);
    const el = h(`<div>
      <h1>Someone sent you ${room.fileCount === 1 ? 'a file' : `${room.fileCount} files`}</h1>
      <p class="lead">${fmtBytes(room.totalBytes)}, locked so that only this link can open it.</p>
      ${
        inApp
          ? `<p class="warn">Open this link in Chrome or Safari, not inside this app. The link works only once, so open it where you want to save the files.</p>
             <button class="btn big" type="button" data-copylink>Copy link</button>`
          : `<button class="btn big" type="button" data-receive>Receive files</button>
             <p class="fine">This link works once, on one device. Use the device you want to save the files on.</p>`
      }
      <p class="error" role="alert" hidden></p>
    </div>`);
    panel.replaceChildren(el);
    if (inApp) copyText($('[data-copylink]', el), location.href);
    el.querySelector('[data-receive]')?.addEventListener('click', (e) => void receive(e.currentTarget as HTMLButtonElement, $('.error', el)));
  }

  async function receive(btn: HTMLButtonElement, err: HTMLElement) {
    btn.disabled = true;
    btn.textContent = 'Opening…';
    const join = async () => {
      if (local(storeKey)) return;
      let device = local('zs:device');
      if (!device) device = local('zs:device', b64url(crypto.getRandomValues(new Uint8Array(18))))!;
      const r = await call<{ receiverId: string; token: string }>('POST', `/rooms/${roomId}/join`, { human: true, body: { device } });
      local(storeKey, JSON.stringify(r));
    };
    try {
      // Two tabs of the same browser never count as two people.
      if (navigator.locks) await navigator.locks.request(`zs-join-${roomId}`, join);
      else await join();
    } catch (e) {
      if (e instanceof ApiError && (e.status === 423 || e.status === 410) && e.data.burn) return end(e.data.burn);
      if (e instanceof ApiError && e.code === 'same-device' && !local(storeKey)) return fail('Already open in this browser.', 'Use the tab where you first opened the link.');
      btn.disabled = false;
      btn.textContent = 'Receive files';
      err.hidden = false;
      err.textContent = (e as Error).message;
      return;
    }
    await resume();
  }

  // ---------------- 2. get the key ----------------
  async function resume() {
    const { token } = JSON.parse(local(storeKey)!) as { receiverId: string; token: string };
    let me: any;
    try {
      me = await call('GET', `/rooms/${roomId}/me`, { token });
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) {
        local(storeKey, null);
        return fail('This browser lost access.', 'Ask the sender for a new link.');
      }
      return fail('Could not reach ZeroSight.', (e as Error).message);
    }
    if (me.burn) return end(me.burn, false);

    s.step('key');
    let saved = await idbGet<{ padlock: Uint8Array; secretKey: Uint8Array }>(`zs:sk:${roomId}`);
    if (!saved) {
      if (me.keybox) return fail('The key on this device is gone.', 'Browser data was cleared after you opened the link, so the files cannot be opened here. Ask the sender to send again.');
      const pair = makePadlock();
      saved = pair;
      await idbSet(`zs:sk:${roomId}`, pair);
      await call('PUT', `/rooms/${roomId}/padlock`, { token, body: { padlock: b64(pair.padlock) } });
    } else if (!me.hasPadlock) {
      await call('PUT', `/rooms/${roomId}/padlock`, { token, body: { padlock: b64(saved.padlock) } });
    }
    s.step('lock', ['key']);
    const el = h(`<div>
      <h1>Getting your files</h1>
      <ol class="status">
        <li class="done">This device made a lock that only it can open</li>
        <li class="now" data-s="key">Waiting for the sender's device to hand over the key…</li>
        <li data-s="arrive">Files arriving</li>
        <li data-s="save">Save the files</li>
      </ol>
      <p class="fine" data-hint></p>
    </div>`);
    panel.replaceChildren(el);
    wh.setStatus('Waiting in the 0', 'The key comes next');

    let opening = false;
    const check = async () => {
      if (ended || opening) return;
      const m = await call<any>('GET', `/rooms/${roomId}/me`, { token }).catch(() => null);
      if (!m) return;
      if (m.burn) return end(m.burn);
      const hint = $('[data-hint]', el);
      const li = (k: string) => $(`[data-s="${k}"]`, el);
      if (!m.keybox) {
        hint.textContent = m.senderOnline ? '' : "The sender's page is closed or asleep. Ask them to open it again so it can hand over the key.";
      } else if (m.state !== 'ready') {
        li('key').className = 'done';
        li('key').textContent = 'Key received';
        li('arrive').className = 'now';
        hint.textContent = '';
      } else {
        opening = true;
        await openFiles(token, unb64(m.keybox), saved!);
      }
    };
    const stop = listen(
      roomId,
      token,
      (ev, data) => {
        if (ev === 'burned') end(data);
        else void check();
      },
      () => void check(),
    );
    cleanups.push(stop);
    // Polling backup: some networks and proxies buffer live events.
    const poll = setInterval(() => (ended || opening ? clearInterval(poll) : void check()), 3000);
    cleanups.push(() => clearInterval(poll));
  }

  // ---------------- 3. unlock and save ----------------
  async function openFiles(token: string, keybox: Uint8Array, saved: { padlock: Uint8Array; secretKey: Uint8Array }) {
    let fileKey: Uint8Array;
    let manifest: Manifest;
    try {
      fileKey = await openKeybox(keybox, saved.secretKey, saved.padlock, linkSecret, roomId);
      manifest = await fetchManifest(roomId, token, fileKey);
    } catch (e) {
      if (e instanceof SealBrokenError) return tampered(token);
      return fail('Could not open the files.', (e as Error).message);
    }
    const n = manifest.files.length;
    const total = manifest.files.reduce((t, f) => t + f.size, 0);
    const asZip = n > 1;
    const top = manifest.files[0].name.split('/');
    const zipName = `${n > 1 && top.length > 1 && manifest.files.every((f) => f.name.startsWith(top[0] + '/')) ? top[0] : 'ZeroSight files'}.zip`;
    s.step('send', ['key', 'lock']);
    wh.setStatus('Ready to come out of the 0', `${n === 1 ? '1 file' : `${n} files`} · ${fmtBytes(total)}`);
    const el = h(`<div>
      <h1>Your files are ready</h1>
      <ul class="files progress">${manifest.files.map((f, i) => `<li data-f="${i}"><span class="fname">${esc(f.name)}</span><span class="fsize">${fmtBytes(f.size)}</span><span class="bar"><i></i></span></li>`).join('')}</ul>
      <p class="total">${n === 1 ? '1 file' : `${n} files`} · <b>${fmtBytes(total)}</b></p>
      <button class="btn big" type="button" data-dl>${asZip ? 'Save all (one .zip)' : 'Save file'}</button>
      <p class="fine" data-how>This works once. After saving, the files are deleted from the server.</p>
      <p class="error" role="alert" hidden></p>
    </div>`);
    panel.replaceChildren(el);
    const btn = $<HTMLButtonElement>('[data-dl]', el);
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Unlocking…';
      const done = new Array(n).fill(0);
      wh.setProgress(0);
      const progress = (i: number, d: number, t: number) => {
        done[i] = d;
        const bar = el.querySelector<HTMLElement>(`[data-f="${i}"] .bar i`);
        if (bar) bar.style.width = `${t ? (d / t) * 100 : 100}%`;
        const p = total ? done.reduce((a, b) => a + b, 0) / total : 1;
        wh.setProgress(p);
        wh.setStatus('Coming out of the 0', `Unlocking on this device, ${Math.round(p * 100)}%`);
      };
      try {
        if (asZip) {
          const zip = new ZipWriter();
          for (const [i, f] of manifest.files.entries()) {
            const sink = collectSink();
            await downloadFile(roomId, token, fileKey, manifest, i, sink, progress);
            zip.add(f.name, sink.chunks);
          }
          saveBlob(zip.blob(), zipName);
        } else {
          const f = manifest.files[0];
          if (canStream()) {
            await downloadFile(roomId, token, fileKey, manifest, 0, streamSink(f.name, f.size), progress);
          } else {
            const sink = collectSink();
            await downloadFile(roomId, token, fileKey, manifest, 0, sink, progress);
            saveBlob(new Blob(sink.chunks as BlobPart[], { type: f.type || 'application/octet-stream' }), f.name);
          }
        }
      } catch (e) {
        if (e instanceof SealBrokenError) return tampered(token);
        btn.disabled = false;
        btn.textContent = 'Try again';
        const err = $('.error', el);
        err.hidden = false;
        err.textContent = (e as Error).message;
        return;
      }
      fileKey.fill(0);
      wh.complete('Out of the 0', 'Every byte checked. Saved on this device.');
      await call('POST', `/rooms/${roomId}/ack`, { token, body: { ok: true } }).catch(() => undefined);
      await idbDel(`zs:sk:${roomId}`);
      const after = await call<PublicRoom>('GET', `/rooms/${roomId}`).catch(() => null);
      if (after?.burn) return end(after.burn);
      btn.textContent = 'Saved';
    });
  }

  async function tampered(token: string) {
    await call('POST', `/rooms/${roomId}/ack`, { token, body: { ok: false } }).catch(() => undefined);
    const r = await call<PublicRoom>('GET', `/rooms/${roomId}`).catch(() => null);
    if (r?.burn) return end(r.burn);
    fail('The files were damaged on the way.', 'This device refused to open them. Nothing unsafe was saved.');
  }

  return () => {
    cleanups.splice(0).forEach((f) => f());
    s.alarm(false);
  };
}
