import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
// This import must stay here, eagerly, and must stay ABOVE the app's own
// stylesheets. maplibre ships `.maplibregl-map { position: relative }`, which
// collides with App.css's `.map-container { position: absolute; inset: 0 }` at
// equal specificity — so whichever stylesheet loads last wins. Deferring it into
// the lazy MapView chunk (which appends its <link> at runtime, i.e. last) makes
// maplibre win, the map collapses to zero height, and you get a blank map with
// no error anywhere. The ~10 kB gzip it costs the critical path is the price of
// that cascade order; the JS is where the real weight was.
import 'maplibre-gl/dist/maplibre-gl.css';
import './index.css';
import App from './App.tsx';
import { useAppStore } from './store/useAppStore';

const queryClient = new QueryClient();

// Restore any signed-in session (and merge saved pins/itineraries) on load.
void useAppStore.getState().hydrateAuth();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
