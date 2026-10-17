import type { BurnInfo } from '../lib/api';
import { verifyReceipt } from '../lib/crypto';
import { burnFx } from '../lib/fx';
import { esc, fmtBytes, h } from '../lib/ui';

type Role = 'sender' | 'receiver';
const COPY: Record<string, { title: string; sender: string; receiver: string; alarm?: boolean }> = {
  delivered: { title: 'Delivered, then deleted.', sender: 'They saved your files. Nothing is left on our server.', receiver: 'Your files are saved on this device. Nothing is left on our server.' },
  'red-alert': {
    title: 'Red Alert: a second device opened this link.',
    sender: 'Only one person may open your link, and a second device tried. We destroyed the files to protect you. Send again, and share the new link a different way.',
    receiver: 'This link had already been opened on another device, so the files were destroyed to protect the sender. Ask them for a new link.',
    alarm: true,
  },
  blocked: { title: 'You blocked that device.', sender: 'The files were destroyed. Nobody got them.', receiver: 'The sender refused this device and destroyed the files.', alarm: true },
  tampered: {
    title: 'The files were damaged on the way.',
    sender: 'The receiver’s device found the files altered and refused to open them. They were destroyed.',
    receiver: 'Your device found the files altered and refused to open them. Nothing unsafe was saved.',
    alarm: true,
  },
  expired: { title: 'The timer ran out.', sender: 'Nobody downloaded in time, so the files were deleted.', receiver: 'The files were deleted before anyone downloaded them.' },
  sender: { title: 'Destroyed by the sender.', sender: 'You destroyed the transfer. Nobody can open it now.', receiver: 'The sender destroyed this transfer.' },
  'sender-left': {
    title: 'The sender left too early.',
    sender: 'Your tab closed before anyone received the key, so the files were deleted. Send them again.',
    receiver: 'The sender closed their tab before handing over your key. Ask them to send it again.',
  },
  'upload-timeout': { title: 'The upload never finished.', sender: 'The upload stopped, so the partial files were deleted. Send them again.', receiver: 'The sender’s upload never finished. Ask them to send it again.' },
  admin: { title: 'Removed by ZeroSight.', sender: 'This transfer was removed after an abuse report.', receiver: 'This transfer was removed after an abuse report.' },
};

export const isAlarm = (reason: string) => Boolean(COPY[reason]?.alarm);

export function receiptView(b: BurnInfo): HTMLElement {
  const r = b.receipt;
  const el = h(`
    <section class="receipt" aria-label="Deletion receipt">
      <div class="receipt-head"><h3>Deletion receipt</h3><span class="badge" data-state="checking">Checking signature…</span></div>
      <dl>
        <dt>Deleted at</dt><dd>${esc(new Date(r.body.burnedAt).toLocaleString())}</dd>
        <dt>What</dt><dd>${r.body.fileCount} ${r.body.fileCount === 1 ? 'file' : 'files'}, ${fmtBytes(r.body.ciphertextBytes)} encrypted</dd>
        <dt>Why</dt><dd>${esc(r.body.reason)}</dd>
      </dl>
      <p class="fine">Signed by the ZeroSight server. It proves our copy is gone, not copies a receiver saved.</p>
      <button class="btn ghost small" type="button">Save receipt</button>
    </section>`);
  const badge = el.querySelector<HTMLElement>('.badge')!;
  verifyReceipt(r).then((ok) => {
    badge.dataset.state = ok ? 'ok' : ok === false ? 'bad' : 'na';
    badge.textContent = ok ? 'Signature verified' : ok === false ? 'Signature does not verify' : 'Signature not checkable in this browser';
  });
  el.querySelector('button')!.addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `zerosight-receipt-${r.body.roomId.slice(0, 12)}.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  });
  return el;
}

/** The ending screen for any burn reason. */
export function endScreen(b: BurnInfo, role: Role, animate = true): HTMLElement {
  const c = COPY[b.reason] ?? COPY.sender;
  const el = h(`<section class="panel end ${c.alarm ? 'is-alarm' : ''}"><h1>${esc(c.title)}</h1><p class="lead">${esc(c[role])}</p></section>`);
  if (animate && !c.alarm) {
    const canvas = h<HTMLCanvasElement>('<canvas class="burn" aria-hidden="true"></canvas>');
    el.append(canvas);
    requestAnimationFrame(() => void burnFx(canvas));
  }
  el.append(receiptView(b), h('<a class="btn" href="#/">Send files</a>'));
  return el;
}

export function errorScreen(title: string, message: string): HTMLElement {
  return h(`<section class="panel end"><h1>${esc(title)}</h1><p class="lead">${esc(message)}</p><a class="btn" href="#/">Start over</a></section>`);
}
