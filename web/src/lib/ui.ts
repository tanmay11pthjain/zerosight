// Shared page shell (identical for sender and receiver) and small DOM helpers.
export const RM = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export function h<T extends HTMLElement = HTMLElement>(html: string): T {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild as T;
}
export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
export { fmtSize as fmtBytes } from './wormhole';
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, RM ? Math.min(ms, 40) : ms));
export const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;

export function local(key: string, value?: string | null): string | null {
  try {
    if (value === undefined) return localStorage.getItem(key);
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage blocked */
  }
  return value ?? null;
}

export type StepId = 'key' | 'lock' | 'send' | 'delete';
const STEPS: [StepId, string][] = [
  ['key', '1 Key'],
  ['lock', '2 Lock'],
  ['send', '3 Deliver'],
  ['delete', '4 Delete'],
];

export interface Shell {
  main: HTMLElement;
  step(id: StepId | null, done?: StepId[]): void;
  server(text: string): void;
  waking(on: boolean): void;
  alarm(on: boolean): void;
}

export function shell(app: HTMLElement): Shell {
  const root = h(`
    <div class="page">
      <header class="top">
        <a class="brand" href="#/" aria-label="ZeroSight home"><img src="/logo.jpg" alt="" width="36" height="36"><span>ZeroSight</span></a>
        <ol class="steps" aria-label="Progress">${STEPS.map(([id, label]) => `<li data-step="${id}">${label}</li>`).join('')}</ol>
      </header>
      <div class="waking" role="status" hidden>Waking up the server… free servers sleep when idle, this takes up to a minute.</div>
      <main class="main"></main>
      <footer class="sees"><svg viewBox="0 0 28 16" aria-hidden="true"><path d="M2 4c3.5 5 8 7.5 12 7.5S22.5 9 26 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M6 8.6 4.2 11.6M11 10.9l-.7 3.2M17 10.9l.7 3.2M22 8.6l1.8 3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg><b>What our server can see:</b><span class="sees-text">Nothing yet.</span></footer>
    </div>`);
  app.replaceChildren(root);
  return {
    main: $('.main', root),
    step(id, done = []) {
      root.querySelectorAll<HTMLElement>('.steps li').forEach((li) => {
        const s = li.dataset.step as StepId;
        li.dataset.state = done.includes(s) ? 'done' : s === id ? 'active' : 'todo';
        if (s === id) li.setAttribute('aria-current', 'step');
        else li.removeAttribute('aria-current');
      });
    },
    server(text) {
      $('.sees-text', root).textContent = text;
    },
    waking(on) {
      $<HTMLElement>('.waking', root).hidden = !on;
    },
    alarm(on) {
      document.body.classList.toggle('alarm', on);
    },
  };
}

export function show(main: HTMLElement, el: HTMLElement) {
  main.replaceChildren(el);
  el.classList.add('enter');
  const t = el.querySelector('h1, h2');
  if (t instanceof HTMLElement) {
    t.tabIndex = -1;
    t.focus({ preventScroll: true });
  }
}

export function copyText(btn: HTMLButtonElement, text: string, input?: HTMLInputElement) {
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = 'Copied';
    } catch {
      input?.select();
      btn.textContent = 'Press Ctrl+C';
    }
    setTimeout(() => (btn.textContent = 'Copy'), 1800);
  });
}
