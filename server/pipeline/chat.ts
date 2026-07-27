// Travel chat: a Lonely-Planet-style assistant grounded in the app's real data.
//
// Every answer is built from GROUNDING the app actually holds — the ranked
// destinations the user is viewing (Wikivoyage + discovery), the traveller
// opinions we mined, and any ingested web/discussion sources for the place. The
// heuristic path (no API key) returns a genuinely useful extractive answer from
// that grounding; when a real LLM is configured it writes a conversational reply
// using the SAME facts, so it stays accurate and never invents specifics.

import { CATEGORIES } from '../../src/data/categories.ts';
import type { CategoryId, LocationOpinions } from '../../src/types.ts';
import { getLLM } from '../llm/adapter.ts';
import { store, type KbSource } from '../store.ts';

const CAT_LABEL: Record<string, string> = Object.fromEntries(
  CATEGORIES.map((c) => [c.id, c.label]),
);

export interface ChatDest {
  name: string;
  category: CategoryId;
  score: number;
  rank: number;
  description?: string;
  reasons?: string[];
}

export interface ChatContext {
  location: string;
  destinations: ChatDest[];
  opinions?: LocationOpinions;
  advice?: Array<{ title: string; body: string }>;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  message: string;
  history?: ChatMessage[];
  context?: ChatContext;
  lang?: string;
}

export interface ChatReply {
  answer: string;
  /** Follow-up prompts the user can tap. */
  suggestions: string[];
  /** True when the answer is backed by the app's own data for this place. */
  grounded: boolean;
}

// --- Intent detection ----------------------------------------------------------
// Map question keywords to a category (or a special intent). Order matters:
// more specific cues first.
type IntentKind = 'opinions' | 'itinerary' | 'info';

const INTENT: Array<{ re: RegExp; cat?: CategoryId; kind?: IntentKind }> = [
  { re: /\b(know before|things to know|tips|etiquette|customs|safe|safety|scam|when to (go|visit)|best time|weather|season|climate|rainy|budget|cost|how much|money|currency|cash|tipping|tip|language|getting around|get around|transport|transportation|getting there|visa|how many days|how long)\b/i, kind: 'info' },
  { re: /\b(eat|food|restaurant|dish|cuisine|meal|breakfast|lunch|dinner|street food|cafe|coffee)\b/i, cat: 'food' },
  { re: /\b(stay|sleep|hotel|hostel|accommodation|where to stay|ryokan|guesthouse|lodging)\b/i, cat: 'sleep' },
  { re: /\b(nightlife|bar|pub|club|drink|drinks|party)\b/i, cat: 'nightlife' },
  { re: /\b(shop|shopping|market|souvenir|buy|mall)\b/i, cat: 'shopping' },
  { re: /\b(nature|hike|hiking|outdoor|park|beach|mountain|garden|waterfall|trail|scenery|scenic)\b/i, cat: 'nature' },
  { re: /\b(museum|culture|temple|shrine|history|historic|heritage|art|gallery|castle)\b/i, cat: 'culture' },
  { re: /\b(activity|activities|tour|experience|things to do|do in|adventure|excursion)\b/i, cat: 'activities' },
  { re: /\b(sight|sights|landmark|attraction|see in|must[- ]see|viewpoint|photo)\b/i, cat: 'sights' },
  { re: /\b(worth|review|reviews|opinion|opinions|pros|cons|overrated|good|bad|like it|dislike|crowded|safe)\b/i, kind: 'opinions' },
  { re: /\b(itinerary|plan|days?|day trip|weekend|schedule|route)\b/i, kind: 'itinerary' },
];

function detectIntent(message: string): { cat?: CategoryId; kind?: IntentKind } {
  for (const i of INTENT) if (i.re.test(message)) return { cat: i.cat, kind: i.kind };
  return {};
}

const STOP = new Set([
  'what', 'should', 'know', 'about', 'before', 'visiting', 'the', 'this', 'that', 'with',
  'when', 'best', 'time', 'good', 'travel', 'trip', 'there', 'here', 'have', 'they', 'from',
  'your', 'you', 'for', 'and', 'are', 'any', 'can', 'get', 'how', 'much', 'many', 'need',
  'want', 'like', 'some', 'tell', 'give', 'please', 'would', 'could',
]);

function keywords(message: string): string[] {
  return [...new Set(message.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/))].filter(
    (w) => w.length >= 4 && !STOP.has(w),
  );
}

function splitSentences(text: string): string[] {
  return text
    .split(/\n+|(?<=[.!?])\s+/)
    .map((s) => s.replace(/^[\s*\-•\d.)]+/, '').replace(/\s+/g, ' ').trim())
    .filter((s) => s.length >= 30 && s.length <= 240);
}

// Info cue words that signal a generic "planning knowledge" sentence.
const INFO_CUES =
  /\b(book|avoid|crowd|season|spring|summer|autumn|fall|winter|month|cherry blossom|hanami|festival|tip|tipping|cash|yen|budget|expensive|etiquette|shoes|temple|safe|solo|reservation|pack|weather|rain|peak|early|morning|closed|holiday|visa|train|pass|walk)\b/i;

// Sub-topics for info questions. `titleHint` prefers the LP article written for
// that topic; `lex` scores sentences that are actually about it.
const TOPICS: Array<{ re: RegExp; titleHint: RegExp; lex: RegExp }> = [
  {
    re: /\b(when|best time|season|weather|climate|month|rainy|hanami|blossom|foliage)\b/i,
    titleHint: /best time to visit/i,
    lex: /\b(spring|summer|autumn|fall|winter|month|march|april|may|june|july|august|september|october|november|december|cherry blossom|hanami|foliage|festival|matsuri|season|peak|weather|rain|humid|snow|crowd|book|advance)\b/i,
  },
  {
    re: /\b(etiquette|customs|manners|tips?|rude|polite|respect)\b/i,
    titleHint: /things to know/i,
    lex: /\b(tip|tipping|shoes|remove|bow|cash|tray|quiet|photo|geisha|temple|shrine|respect|queue|escalator|trash|smoking|slip-on|etiquette)\b/i,
  },
  {
    re: /\b(safe|safety|scam|dangerous|crime|solo)\b/i,
    titleHint: /things to know/i,
    lex: /\b(safe|safety|crime|scam|solo|women|lgbt|emergency|police|pickpocket|careful|welcoming)\b/i,
  },
  {
    re: /\b(budget|cost|money|currency|cash|expensive|cheap|price|how much|tipping)\b/i,
    titleHint: /things to know/i,
    lex: /\b(yen|cash|card|budget|expensive|cheap|price|cost|money|atm|currency|tax|tip)\b/i,
  },
  {
    re: /\b(transport|getting around|get around|getting there|train|bus|subway|metro|pass|airport|visa)\b/i,
    titleHint: /things to know/i,
    lex: /\b(train|bus|subway|metro|\bjr\b|pass|ic card|suica|icoca|bike|walk|taxi|airport|station|shinkansen|visa)\b/i,
  },
  {
    re: /\b(neighbou?rhood|area|district|where to base|stay area)\b/i,
    titleHint: /neighbou?rhood/i,
    lex: /\b(district|neighbou?rhood|area|downtown|central|base|quarter|quiet|lively|atmospheric)\b/i,
  },
];

/** Pull real, relevant sentences from studied sources, biased to the sub-topic. */
function mineInfoSentences(
  sources: KbSource[],
  message: string,
  limit = 5,
): Array<{ text: string; source: string; url?: string }> {
  const kw = keywords(message);
  const topic = TOPICS.find((t) => t.re.test(message));
  const lex = topic?.lex ?? INFO_CUES;

  // Rank sources: the LP article written for this topic first, then other LP
  // articles, then everything else.
  const ranked = [...sources].sort((a, b) => {
    const score = (s: KbSource) =>
      (topic && topic.titleHint.test(s.title) ? 4 : 0) + (s.provider === 'Lonely Planet' ? 1 : 0);
    return score(b) - score(a);
  });

  const out: Array<{ text: string; source: string; url?: string }> = [];
  const seen = new Set<string>();
  for (const s of ranked) {
    if (!s.summary) continue;
    const scored = splitSentences(s.summary)
      .map((sent) => {
        const low = sent.toLowerCase();
        const kwScore = kw.reduce((n, k) => n + (low.includes(k) ? 2 : 0), 0);
        const lexScore = lex.test(sent) ? 2 : 0;
        return { sent, score: kwScore + lexScore };
      })
      // Require a real topic/keyword match so we don't surface random prose.
      .filter((x) => x.score >= 2)
      .sort((a, b) => b.score - a.score);
    for (const { sent } of scored) {
      const key = sent.toLowerCase().slice(0, 60);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ text: sent, source: s.title, url: s.url });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

function topByCategory(dests: ChatDest[], cat: CategoryId, n: number): ChatDest[] {
  return dests
    .filter((d) => d.category === cat)
    .sort((a, b) => b.score - a.score || a.rank - b.rank)
    .slice(0, n);
}

function topOverall(dests: ChatDest[], n: number): ChatDest[] {
  return [...dests].sort((a, b) => b.score - a.score).slice(0, n);
}

function oneLine(text?: string, max = 160): string {
  if (!text) return '';
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf(', '), cut.lastIndexOf(' '));
  return `${cut.slice(0, stop > 60 ? stop : max)}…`;
}

function listPicks(picks: ChatDest[]): string {
  return picks
    .map((d, i) => {
      const desc = oneLine(d.description);
      return `${i + 1}. **${d.name}** (${CAT_LABEL[d.category] ?? d.category})${desc ? ` — ${desc}` : ''}`;
    })
    .join('\n');
}

// --- Extractive (grounded, no-LLM) answer -------------------------------------
function extractiveAnswer(req: ChatRequest, sources: KbSource[]): ChatReply {
  const ctx = req.context;
  const loc = ctx?.location?.trim();
  const suggestions = buildSuggestions(loc);

  if (!ctx || !ctx.destinations.length) {
    return {
      answer:
        "I don't have a place loaded yet. Search for a city, region or country (top-left) and " +
        "I'll recommend the best things to see, do and eat there — or just tell me where you're headed.",
      suggestions,
      grounded: false,
    };
  }

  const { cat, kind } = detectIntent(req.message);

  if (kind === 'info') {
    const facts = mineInfoSentences(sources, req.message, 5);
    if (facts.length) {
      const lp = facts.some((f) => /Lonely Planet/.test(f.source));
      const bullets = facts.map((f) => `• ${f.text} _(${f.source.replace(/ — .*/, '')})_`).join('\n');
      return {
        answer: `Here's what to know about **${loc}**${lp ? ', drawing on Lonely Planet' : ''}:\n\n${bullets}`,
        suggestions,
        grounded: true,
      };
    }
    // fall through to generic if we found nothing relevant
  }

  if (kind === 'opinions' && ctx.opinions) {
    const pos = ctx.opinions.positives.slice(0, 3).map((o) => `• 👍 ${o.text}`);
    const neg = ctx.opinions.negatives.slice(0, 3).map((o) => `• 👎 ${o.text}`);
    if (pos.length || neg.length) {
      return {
        answer:
          `Here's what travellers actually say about **${loc}**:\n\n` +
          (pos.length ? `**Praised for**\n${pos.join('\n')}\n\n` : '') +
          (neg.length ? `**Common gripes**\n${neg.join('\n')}` : '') +
          `\n\n_${ctx.opinions.basis}_`,
        suggestions,
        grounded: true,
      };
    }
  }

  if (kind === 'itinerary') {
    const picks = topOverall(ctx.destinations, 6);
    return {
      answer:
        `A solid short plan for **${loc}**, built from the highest-ranked spots:\n\n${listPicks(picks)}\n\n` +
        'Want this split by day, or focused on food / nature / culture? Just ask.',
      suggestions,
      grounded: true,
    };
  }

  if (cat) {
    const picks = topByCategory(ctx.destinations, cat, 6);
    if (picks.length) {
      return {
        answer: `Top **${CAT_LABEL[cat]}** picks in **${loc}**, ranked by how strongly they're recommended:\n\n${listPicks(picks)}`,
        suggestions,
        grounded: true,
      };
    }
    return {
      answer: `I don't have standout **${CAT_LABEL[cat]}** spots recorded for ${loc} yet. Here are the top overall picks instead:\n\n${listPicks(topOverall(ctx.destinations, 5))}`,
      suggestions,
      grounded: true,
    };
  }

  // Generic recommendation.
  const picks = topOverall(ctx.destinations, 6);
  const extra = sources.length ? `\n\n_Also drawing on ${sources.length} studied source(s) for ${loc}._` : '';
  return {
    answer: `Here are the best things to experience in **${loc}**, most recommended first:\n\n${listPicks(picks)}${extra}\n\nAsk me about food, nature, culture, nightlife, where to stay, or whether it's worth visiting.`,
    suggestions,
    grounded: true,
  };
}

function buildSuggestions(loc?: string): string[] {
  const at = loc ? ` in ${loc}` : '';
  return [
    `Best things to do${at}`,
    `Where to eat${at}`,
    `Is ${loc ?? 'it'} worth visiting?`,
    `Plan a 3-day itinerary${at}`,
  ];
}

// --- Grounding text for the generative path -----------------------------------
function buildGroundingText(req: ChatRequest, sources: KbSource[]): string {
  const ctx = req.context;
  if (!ctx) return '';
  const sourceLines = sources
    .filter((s) => s.summary)
    .slice(0, 5)
    .map((s) => `${s.title}: ${oneLine(s.summary, 300)}`);
  const lines: string[] = [`PLACE: ${ctx.location}`];
  const top = topOverall(ctx.destinations, 25);
  lines.push('\nTOP RANKED PLACES (most recommended first):');
  for (const d of top) {
    lines.push(`- ${d.name} [${CAT_LABEL[d.category] ?? d.category}, score ${d.score}]${d.description ? `: ${oneLine(d.description, 200)}` : ''}`);
  }
  if (ctx.opinions && (ctx.opinions.positives.length || ctx.opinions.negatives.length)) {
    lines.push('\nWHAT TRAVELLERS SAY:');
    for (const o of ctx.opinions.positives.slice(0, 5)) lines.push(`+ ${o.text}`);
    for (const o of ctx.opinions.negatives.slice(0, 5)) lines.push(`- ${o.text}`);
  }
  if (ctx.advice?.length) {
    lines.push('\nPRACTICAL ADVICE:');
    for (const a of ctx.advice.slice(0, 4)) lines.push(`• ${a.title}: ${oneLine(a.body, 200)}`);
  }
  if (sourceLines.length) {
    lines.push('\nSTUDIED SOURCES (excerpts):');
    for (const s of sourceLines.slice(0, 4)) lines.push(`• ${s}`);
  }
  return lines.join('\n');
}

const LANG_NAMES: Record<string, string> = {
  en: 'English', es: 'Spanish', fr: 'French', de: 'German', it: 'Italian',
  pt: 'Portuguese', vi: 'Vietnamese', ja: 'Japanese', ko: 'Korean', zh: 'Chinese',
  ru: 'Russian', ar: 'Arabic',
};

export async function answerTravelQuestion(req: ChatRequest): Promise<ChatReply> {
  const llm = getLLM();
  const loc = req.context?.location?.trim();

  // Pull everything we've studied for this place (Lonely Planet, Wikipedia,
  // discussions) to ground the answer.
  let sources: KbSource[] = [];
  if (loc) {
    try {
      sources = (await store.getSources(loc)).filter((s) => s.summary);
    } catch {
      /* best effort */
    }
  }

  // Always compute the grounded extractive answer — it's the reliable baseline.
  const extractive = extractiveAnswer(req, sources);

  // If a real generative model is configured, let it write a nicer reply using
  // the SAME grounded facts (prefer accuracy over fluency; never invent).
  if (llm.generative && llm.chat) {
    const grounding = buildGroundingText(req, sources);
    const langName = LANG_NAMES[req.lang ?? 'en'] ?? 'English';
    const system =
      'You are Pocket Planet, a warm, expert travel assistant in the spirit of a Lonely Planet guidebook. ' +
      'Answer travel questions — destinations, recommendations, itineraries, food, culture, logistics and safety. ' +
      'PREFER the provided CONTEXT (real, ranked data about the place the user is viewing). ' +
      'You may add well-known general travel knowledge, but NEVER invent specific facts such as prices, ' +
      'opening hours, phone numbers or addresses that are not in the context. Be concise, practical and friendly. ' +
      'Use short paragraphs or bullet points. ' +
      `Respond in ${langName}.`;
    const historyText = (req.history ?? [])
      .slice(-6)
      .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
      .join('\n');
    const user =
      (grounding ? `CONTEXT\n${grounding}\n\n` : '') +
      (historyText ? `CONVERSATION SO FAR\n${historyText}\n\n` : '') +
      `USER QUESTION\n${req.message}`;
    try {
      const out = (await llm.chat(system, user)).trim();
      if (out) return { answer: out, suggestions: extractive.suggestions, grounded: !!grounding };
    } catch {
      /* fall through to extractive */
    }
  }

  return extractive;
}
