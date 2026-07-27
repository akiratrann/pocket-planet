// Client for the backend "brain". Every call degrades gracefully: if the backend
// isn't running, the app falls back to fetching Wikivoyage directly so the PWA
// still works standalone (just without the learning/ingestion features).

import type { CategoryId, Guide, LocationOpinions } from '../types';
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

export async function fetchGuide(query: string, lang = 'en'): Promise<Guide> {
  try {
    return await apiFetch<Guide>(`/guide?q=${encodeURIComponent(query)}&lang=${encodeURIComponent(lang)}`);
  } catch {
    // Backend unavailable → direct Wikivoyage (no learning/localization layer).
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

export interface TrainingSummary {
  at: number;
  examples: number;
  positives: number;
  accuracy: number | null;
  weightChanges: string[];
  keywordsAdded: number;
  rationale: string;
  version: number;
}

/** Kick off a training pass: fit the ranking model to recorded usage signal. */
export async function trainModel(): Promise<TrainingSummary> {
  return apiFetch<TrainingSummary>(`/train`, { method: 'POST' });
}

export interface TrainStatus {
  examples: number;
  last: TrainingSummary | null;
  learnedVersion: number;
}

export async function trainStatus(): Promise<TrainStatus> {
  return apiFetch<TrainStatus>(`/train/status`);
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatContextDest {
  name: string;
  category: CategoryId;
  score: number;
  rank: number;
  description?: string;
  reasons?: string[];
}

export interface ChatContext {
  location: string;
  destinations: ChatContextDest[];
  opinions?: LocationOpinions;
  advice?: Array<{ title: string; body: string }>;
}

export interface ChatReply {
  answer: string;
  suggestions: string[];
  grounded: boolean;
}

export async function askChat(input: {
  message: string;
  history?: ChatMessage[];
  context?: ChatContext;
  lang?: string;
}): Promise<ChatReply> {
  return apiFetch<ChatReply>(`/chat`, { method: 'POST', body: JSON.stringify(input) });
}

export async function backendAvailable(): Promise<boolean> {
  try {
    await apiFetch(`/health`);
    return true;
  } catch {
    return false;
  }
}
