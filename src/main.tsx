import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
// maplibre's stylesheet is NOT imported here on purpose. Anything imported from
// the entry lands in the one render-blocking stylesheet, so importing it here
// made the panel's first paint wait on CSS that only styles the map's controls.
// It now travels with the lazily-loaded MapView chunk (see App.tsx).
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
