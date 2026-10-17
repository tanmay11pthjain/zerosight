import '@fontsource/playfair-display/500.css';
import '@fontsource/playfair-display/600.css';
import '@fontsource/instrument-sans/400.css';
import '@fontsource/instrument-sans/600.css';
import './styles.css';
import { receiverFlow } from './flows/receiver';
import { senderFlow } from './flows/sender';
import { h } from './lib/ui';

const app = document.getElementById('app')!;
let cleanup: (() => void) | null = null;

const supported = () => window.isSecureContext && Boolean(crypto?.subtle) && 'ResizeObserver' in window && 'TextDecoderStream' in window;

function route() {
  cleanup?.();
  cleanup = null;
  if (!supported()) {
    app.replaceChildren(
      h(`<main class="solo"><img src="/logo.jpg" alt="" width="64" height="64"><h1>This browser can't run ZeroSight safely.</h1><p>Open the link over https in a current Chrome, Edge, Firefox or Safari.</p></main>`),
    );
    return;
  }
  // Receiver links: #/r/<64-char room id>.<link secret>. The part after # never reaches any server.
  const m = /^#\/r\/([0-9a-fA-F]+)\.([A-Za-z0-9_-]+)$/.exec(location.hash);
  if (m) cleanup = receiverFlow(app, m[1].toLowerCase(), m[2]);
  else if (location.hash.startsWith('#/r/')) cleanup = receiverFlow(app, '', '');
  else cleanup = senderFlow(app);
}

// A file dropped outside the 0 must never navigate the tab away.
for (const t of ['dragover', 'drop'] as const) window.addEventListener(t, (e) => e.preventDefault());
window.addEventListener('hashchange', route);
route();
