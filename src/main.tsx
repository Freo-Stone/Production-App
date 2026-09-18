import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Workbox } from 'workbox-window';
import App from './App';
import { watchSystemTheme } from './app/theme';
import { toast } from './ui/primitives';
import './styles/theme.css';

const el = document.getElementById('root');
if (!el) throw new Error('root element missing');

// Applied before first paint so the palette never flashes the wrong way.
watchSystemTheme();

createRoot(el).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

/**
 * The service worker only exists in a production build; dev serves without it so
 * hot reload is never fighting the precache. Updates are offered, never forced —
 * someone mid-entry on the floor should not lose their keystrokes to a reload.
 */
if (import.meta.env.PROD) {
  window.addEventListener('load', () => {
    const wb = new Workbox(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL });

    // generateSW parks the new service worker in "waiting" until we say so.
    wb.addEventListener('waiting', () => {
      toast('info', 'New version available', 'Reload when you are ready to get the latest changes.', {
        label: 'Reload',
        run: () => void wb.messageSkipWaiting(),
      });
    });

    wb.addEventListener('controlling', () => window.location.reload());

    void wb.register().catch(() => {
      /* offline caching is an enhancement; the app works without it */
    });
  });
}
