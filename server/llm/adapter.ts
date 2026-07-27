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

export interface OpinionResult {
  positives: string[];
  negatives: string[];
}

export interface LLMClient {
  name: string;
  /** True when a real generative model is available (enables free-form chat). */
  generative: boolean;
  summarizeLocation(location: string, sourceText: string): Promise<string>;
  extractPOIs(location: string, sourceText: string): Promise<Destination[]>;
  proposeTuning(feedback: Feedback[], state: LearnedState): Promise<TuningProposal>;
  /** Pull key positive/negative points from REAL source text (no invention). */
  extractOpinions(location: string, sourceText: string): Promise<OpinionResult>;
  /** Free-form conversational answer (only when `generative`). system + user → text. */
  chat?(system: string, user: string): Promise<string>;
}

// Sentiment cue lexicons used by the heuristic miner (and as an LLM fallback).
const POSITIVE_CUES =
  /\b(beautiful|stunning|gorgeous|spectacular|breathtaking|charming|vibrant|lovely|worth (?:a )?(?:visit|it)|must[- ]?see|must[- ]?do|unmissable|highlight|iconic|famous|renowned|popular|delicious|friendly|relaxing|peaceful|tranquil|serene|impressive|magnificent|picturesque|scenic|atmospheric|well[- ]preserved|delightful|excellent|wonderful|amazing|fantastic|favou?rite|best|great|interesting|fascinating|authentic|lively|cozy|cosy|pleasant|quaint|memorable|worthwhile|enjoyable|hidden gem|a gem|spotless|friendly)\b/i;
const NEGATIVE_CUES =
  /\b(crowded|overcrowded|touristy|tourist trap|overrated|overpriced|expensive|pricey|dirty|grimy|run[- ]?down|rundown|disappointing|underwhelming|noisy|packed|cramped|smelly|tacky|scam|avoid|dangerous|unsafe|sketchy|confusing|difficult|long queue|long lines|long waits?|dated|pushy|hassle|mediocre|bland|boring|dull)\b/i;
const NEGATORS = /\b(not|no|never|without|hardly|rarely|n't|isn't|aren't|wasn't|doesn't|don't|didn't|won't)\s*$/i;

function splitSentences(text: string): string[] {
  return text
    .split(/\n+|(?<=[.!?])\s+/)
    .map((s) => s.replace(/^[\s*\-•\d.)]+/, '').replace(/\s+/g, ' ').trim())
    .filter((s) => s.length >= 20 && s.length <= 220);
}

/** Count cue hits, flipping polarity when a cue is directly negated. */
function polarity(s: string): { pos: number; neg: number } {
  const lower = ` ${s.toLowerCase()} `;
  let pos = 0;
  let neg = 0;
  const scan = (re: RegExp, isPos: boolean) => {
    const g = new RegExp(re.source, 'gi');
    let m: RegExpExecArray | null;
    while ((m = g.exec(lower))) {
      const before = lower.slice(Math.max(0, m.index - 16), m.index);
      const negated = NEGATORS.test(before);
      if (isPos ? !negated : negated) pos++;
      else neg++;
    }
  };
  scan(POSITIVE_CUES, true);
  scan(NEGATIVE_CUES, false);
  return { pos, neg };
}

/** Grounded, no-hallucination sentiment miner: returns REAL sentences from text. */
function mineSentiment(text: string): OpinionResult {
  const positives: string[] = [];
  const negatives: string[] = [];
  const seen = new Set<string>();
  for (const s of splitSentences(text)) {
    const key = s.toLowerCase().slice(0, 60);
    if (seen.has(key)) continue;
    const { pos, neg } = polarity(s);
    if (pos === 0 && neg === 0) continue;
    seen.add(key);
    const clean = /[.!?]$/.test(s) ? s : `${s}.`;
    if (neg > pos) negatives.push(clean);
    else positives.push(clean);
    if (positives.length + negatives.length >= 40) break;
  }
  return { positives, negatives };
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
  generative: false,

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

  async extractOpinions(_location, sourceText) {
    return mineSentiment(sourceText);
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
    generative: true,
    async chat(system, user) {
      return (await chat(system, user, false)).trim();
    },
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
    async extractOpinions(location, sourceText) {
      try {
        const raw = await chat(
          'You summarize what travellers say about a place. Using ONLY the provided source text, ' +
            'list the key POSITIVE and NEGATIVE points travellers mention. Do NOT invent anything ' +
            'that is not supported by the text. If there are no clear opinions, return empty arrays. ' +
            'Respond ONLY with JSON: {"positives":[string],"negatives":[string]}.',
          `Location: ${location}\n\nSource text:\n${sourceText.slice(0, 8000)}`,
          true,
        );
        const parsed = safeJson<OpinionResult>(raw, { positives: [], negatives: [] });
        const clean = (arr: unknown): string[] =>
          Array.isArray(arr)
            ? arr.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).slice(0, 8)
            : [];
        const result = { positives: clean(parsed.positives), negatives: clean(parsed.negatives) };
        // If the model found nothing, fall back to the grounded miner.
        if (!result.positives.length && !result.negatives.length) return mineSentiment(sourceText);
        return result;
      } catch {
        return mineSentiment(sourceText);
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
