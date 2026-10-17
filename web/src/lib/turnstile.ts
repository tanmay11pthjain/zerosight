// Cloudflare Turnstile (invisible). Only loads when VITE_TURNSTILE_SITE_KEY is set.
const SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined;

declare global {
  interface Window {
    turnstile?: {
      render(el: HTMLElement, opts: Record<string, unknown>): string;
      execute(id: string): void;
      reset(id: string): void;
    };
  }
}

let ready: Promise<void> | null = null;
function load(): Promise<void> {
  ready ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Human check could not load.'));
    document.head.append(s);
  });
  return ready;
}

/** Returns a fresh token, or undefined when Turnstile is not configured. */
export async function humanToken(): Promise<string | undefined> {
  if (!SITE_KEY || typeof document === 'undefined') return undefined;
  await load();
  return new Promise((resolve, reject) => {
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;bottom:0;left:0;z-index:100';
    document.body.append(el);
    const done = (fn: () => void) => {
      el.remove();
      fn();
    };
    window.turnstile!.render(el, {
      sitekey: SITE_KEY,
      appearance: 'interaction-only',
      callback: (t: string) => done(() => resolve(t)),
      'error-callback': () => done(() => reject(new Error('Human check failed. Reload and try again.'))),
    });
  });
}
