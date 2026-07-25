// Pluggable LLM layer. The default is a zero-dependency "heuristic" provider so
// the whole system runs with no API key. Set LLM_PROVIDER (+ the relevant key) to
// upgrade extraction / summarization / self-tuning to a real model. OpenAI and
// Ollama share one OpenAI-compatible client; Anthropic has its own.

import type { CategoryId, Destination } from '../../src/types.ts';
import type { Feedback, LearnedState } from '../../src/core/learning.ts';
import type { RankingWeights } from '../../src/data/ranking.ts';
import { CATEGORIES } from '../../src/data/categories.ts';

const CATEGORY_IDS = new Set(CATEGORIES.map((c) => c.id));
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'city', 'town', 'park',
  'museum', 'national', 'old', 'new', 'grand', 'great', 'house', 'centre', 'center',
]);

export interface TuningProposal {
  cultureKeywords?: string[];
  natureKeywords?: string[];
  prominenceKeywords?: string[];
  weightDeltas?: Partial<RankingWeights>;
  rationale: string;
}

export interface LLMClient {
  name: string;
  summarizeLocation(location: string, sourceText: string): Promise<string>;
  extractPOIs(location: string, sourceText: string): Promise<Destination[]>;
  proposeTuning(feedback: Feedback[], state: LearnedState): Promise<TuningProposal>;
}

function makeDestination(
  name: string,
  category: CategoryId,
  description: string,
  source: string,
): Destination {
  return {
    id: `kb-${source}-${name}`.replace(/\s+/g, '_').slice(0, 80),
    name,
    category,
    wvType: category === 'food' ? 'eat' : category === 'sleep' ? 'sleep' : 'see',
    description: description || undefined,
    score: 0,
    rank: 0,
    order: 9999,
    reasons: ['From an ingested web source'],
  };
}

function tokenize(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
}

// ---------------------------------------------------------------------------
// Heuristic provider (no API key required)
// ---------------------------------------------------------------------------

const heuristic: LLMClient = {
  name: 'heuristic',

  async summarizeLocation(_location, sourceText) {
    const clean = sourceText.replace(/\s+/g, ' ').trim();
    if (!clean) return '';
    const cut = clean.slice(0, 600);
    const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '));
    return (lastStop > 200 ? cut.slice(0, lastStop + 1) : cut).trim();
  },

  async extractPOIs(location, sourceText) {
    // Best-effort parse of common "listicle" structures (numbered / heading /
    // bolded names followed by a description). Real extraction needs an LLM;
    // this keeps the pipeline useful without one.
    const pois: Destination[] = [];
    const lines = sourceText.split(/\n+/).map((l) => l.trim()).filter(Boolean);
    const patterns = [
      /^\d+[.)]\s+(.+?)\s*[—:-]\s*(.+)$/, // "1. Name — desc"
      /^#{1,4}\s+(.+)$/, // "## Name"
      /^\*\*(.+?)\*\*\s*[—:-]?\s*(.*)$/, // "**Name** desc"
    ];
    for (const line of lines) {
      for (const re of patterns) {
        const m = line.match(re);
        if (m) {
          const name = m[1].replace(/[*#]/g, '').trim();
          if (name.length >= 3 && name.length <= 80) {
            pois.push(makeDestination(name, 'sights', (m[2] ?? '').trim(), 'web'));
          }
          break;
        }
      }
      if (pois.length >= 30) break;
    }
    void location;
    return pois;
  },

  async proposeTuning(feedback) {
    // Generalize recategorizations into keywords so a correction in one place
    // improves classification everywhere.
    const counts: Record<'culture' | 'nature', Record<string, number>> = {
      culture: {},
      nature: {},
    };
    for (const fb of feedback) {
      if (fb.kind !== 'recategorize') continue;
      if (fb.category !== 'culture' && fb.category !== 'nature') continue;
      for (const tok of tokenize(fb.name)) {
        counts[fb.category][tok] = (counts[fb.category][tok] ?? 0) + 1;
      }
    }
    const pick = (m: Record<string, number>) =>
      Object.entries(m)
        .filter(([, c]) => c >= 2)
        .map(([k]) => k);
    const cultureKeywords = pick(counts.culture);
    const natureKeywords = pick(counts.nature);
    const added = cultureKeywords.length + natureKeywords.length;
    return {
      cultureKeywords,
      natureKeywords,
      rationale:
        added > 0
          ? `Learned ${added} classification cue(s) from repeated recategorizations.`
          : 'No confident global changes from current feedback.',
    };
  },
};

// ---------------------------------------------------------------------------
// OpenAI-compatible provider (OpenAI + Ollama)
// ---------------------------------------------------------------------------

interface OpenAICompatConfig {
  name: string;
  baseUrl: string;
  apiKey?: string;
  model: string;
}

function openAICompatClient(cfg: OpenAICompatConfig): LLMClient {
  async function chat(system: string, user: string, json: boolean): Promise<string> {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.2,
        ...(json ? { response_format: { type: 'json_object' } } : {}),
      }),
    });
    if (!res.ok) throw new Error(`${cfg.name} error ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content ?? '';
  }
  return makeChatClient(cfg.name, chat);
}

// ---------------------------------------------------------------------------
// Anthropic provider
// ---------------------------------------------------------------------------

function anthropicClient(model: string, apiKey: string): LLMClient {
  async function chat(system: string, user: string): Promise<string> {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 1500,
        system,
        messages: [{ role: 'user', content: user }],
      }),
    });
    if (!res.ok) throw new Error(`anthropic error ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { content?: Array<{ text?: string }> };
    return data.content?.[0]?.text ?? '';
  }
  return makeChatClient('anthropic', (s, u) => chat(s, u));
}

// ---------------------------------------------------------------------------
// Shared chat-based client wiring (prompts + JSON parsing) with a safe fallback.
// ---------------------------------------------------------------------------

function safeJson<T>(raw: string, fallback: T): T {
  try {
    const match = raw.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    return match ? (JSON.parse(match[0]) as T) : fallback;
  } catch {
    return fallback;
  }
}

function makeChatClient(
  name: string,
  chat: (system: string, user: string, json: boolean) => Promise<string>,
): LLMClient {
  return {
    name,
    async summarizeLocation(location, sourceText) {
      try {
        return await chat(
          'You are a concise travel editor. Write a vivid 2-3 sentence overview.',
          `Location: ${location}\n\nSource material:\n${sourceText.slice(0, 6000)}`,
          false,
        );
      } catch {
        return heuristic.summarizeLocation(location, sourceText);
      }
    },
    async extractPOIs(location, sourceText) {
      try {
        const raw = await chat(
          'Extract notable travel points of interest from the text. Respond ONLY with JSON: ' +
            '{"pois":[{"name":string,"category":"sights|culture|nature|activities|food|nightlife|shopping|sleep","description":string}]}',
          `Location: ${location}\n\nText:\n${sourceText.slice(0, 8000)}`,
          true,
        );
        const parsed = safeJson<{ pois?: Array<{ name: string; category: string; description?: string }> }>(
          raw,
          { pois: [] },
        );
        return (parsed.pois ?? [])
          .filter((p) => p.name && CATEGORY_IDS.has(p.category as CategoryId))
          .slice(0, 40)
          .map((p) => makeDestination(p.name, p.category as CategoryId, p.description ?? '', 'web'));
      } catch {
        return heuristic.extractPOIs(location, sourceText);
      }
    },
    async proposeTuning(feedback, state) {
      try {
        const summary = feedback
          .slice(-100)
          .map((f) => `${f.kind}: ${f.name}${f.category ? ` -> ${f.category}` : ''}${f.note ? ` (${f.note})` : ''}`)
          .join('\n');
        const raw = await chat(
          'You tune a travel recommender. Given traveller feedback, propose GLOBAL improvements. ' +
            'Respond ONLY with JSON: {"cultureKeywords":[],"natureKeywords":[],"prominenceKeywords":[],"rationale":string}. ' +
            'Only include keywords you are confident generalize.',
          `Current cues: culture=${state.cultureKeywords.join(',')} nature=${state.natureKeywords.join(',')}\n\nFeedback:\n${summary}`,
          true,
        );
        return safeJson<TuningProposal>(raw, { rationale: 'No changes.' });
      } catch {
        return heuristic.proposeTuning(feedback, state);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

let singleton: LLMClient | null = null;

export function getLLM(): LLMClient {
  if (singleton) return singleton;
  const provider = (process.env.LLM_PROVIDER ?? 'heuristic').toLowerCase();
  switch (provider) {
    case 'openai':
      if (process.env.OPENAI_API_KEY) {
        singleton = openAICompatClient({
          name: 'openai',
          baseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
          apiKey: process.env.OPENAI_API_KEY,
          model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
        });
        break;
      }
      console.warn('[llm] LLM_PROVIDER=openai but OPENAI_API_KEY missing; using heuristic.');
      singleton = heuristic;
      break;
    case 'ollama':
      singleton = openAICompatClient({
        name: 'ollama',
        baseUrl: process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434/v1',
        model: process.env.OLLAMA_MODEL ?? 'llama3.1',
      });
      break;
    case 'anthropic':
      if (process.env.ANTHROPIC_API_KEY) {
        singleton = anthropicClient(
          process.env.ANTHROPIC_MODEL ?? 'claude-3-5-sonnet-latest',
          process.env.ANTHROPIC_API_KEY,
        );
        break;
      }
      console.warn('[llm] LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY missing; using heuristic.');
      singleton = heuristic;
      break;
    default:
      singleton = heuristic;
  }
  console.log(`[llm] provider = ${singleton.name}`);
  return singleton;
}
