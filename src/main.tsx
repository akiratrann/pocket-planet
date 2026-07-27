import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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
