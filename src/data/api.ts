// Client for the backend "brain". Every call degrades gracefully: if the backend
// isn't running, the app falls back to fetching Wikivoyage directly so the PWA
// still works standalone (just without the learning/ingestion features).

import type { CategoryId, Guide } from '../types';
import { getGuide as getGuideDirect } from './wikivoyage';

const API = '/api';

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `API ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function fetchGuide(query: string): Promise<Guide> {
  try {
    return await apiFetch<Guide>(`/guide?q=${encodeURIComponent(query)}`);
  } catch {
    // Backend unavailable → direct Wikivoyage (no learning layer).
    return getGuideDirect(query);
  }
}

export interface FeedbackInput {
  location: string;
  name?: string;
  kind: 'promote' | 'demote' | 'recategorize' | 'note' | 'rate';
  weight?: number;
  category?: CategoryId;
  note?: string;
}

export async function sendFeedback(input: FeedbackInput): Promise<{ learnedVersion: number }> {
  return apiFetch<{ ok: boolean; learnedVersion: number }>(`/feedback`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function ingest(location: string, url?: string) {
  return apiFetch<{ ok: boolean; source: { title: string; url: string; poiCount: number; provider: string } }>(
    `/ingest`,
    { method: 'POST', body: JSON.stringify({ location, url }) },
  );
}

export async function selfTune() {
  return apiFetch<{ rationale: string; version: number }>(`/tune`, { method: 'POST' });
}

export async function backendAvailable(): Promise<boolean> {
  try {
    await apiFetch(`/health`);
    return true;
  } catch {
    return false;
  }
}
