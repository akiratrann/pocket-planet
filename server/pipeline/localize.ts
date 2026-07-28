// Place-text localization — "as good as Google Maps".
//
// Google Maps shows place labels in the viewer's language using multilingual
// open data. We do the same: every destination we surface has (or can be linked
// to) a Wikidata item, and Wikidata carries human-curated labels in hundreds of
// languages. Given the user's language preference we swap each place's display
// name for its label in that language, falling back gracefully to the original
// when no translation exists.
//
// The same applies to DESCRIPTIONS. Discovery deliberately reads the local
// language Wikipedia (English is thin for most of the world), so a place's text
// arrives in whatever language its article was written in — an English guide to
// Kakunodate was showing Japanese paragraphs. We fix that by re-sourcing the
// text, never by translating it: every language has its own Wikipedia edition
// and its own Wikidata description, so we pick the copy already written in the
// reader's language. That keeps the pipeline free of per-place LLM calls (it
// runs on every cold guide build, and must work with no API key at all) and
// keeps every sentence attributable to a real article.
//
// Re-sourcing is always tried first and covers most places. What it cannot cover
// is a place no edition in the reader's language has ever written about — a
// rural Japanese temple with a Wikidata item but no English label, no English
// article and no English one-line description. There is nothing to re-source
// there, and the reader gets a card in a script they cannot read, so a last-
// resort machine translation runs over exactly that residue. It is batched once
// per guide, flagged `translated` on every place it touches so the reader knows
// which text is not an editor's own, and skipped entirely when no API key is
// configured.
//
// Nothing here is invented: translation only ever restates sourced text.

import type { Destination } from '../../src/types.ts';
import { sourceLangOf } from './discover.ts';
import { getLLM } from '../llm/adapter.ts';

const WIKIDATA = 'https://www.wikidata.org/w/api.php';
const UA = 'PocketPlanet/1.0 (https://github.com/akiratrann/pocket-planet)';

async function getJson<T>(url: string, tries = 3): Promise<T | null> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, 'Api-User-Agent': UA } });
      if (res.status === 429 || res.status >= 500) throw new Error(`status ${res.status}`);
      if (!res.ok) return null;
      return (await res.json()) as T;
    } catch {
      if (i === tries - 1) return null;
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  return null;
}

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

interface WdLabels {
  entities?: Record<
    string,
    {
      labels?: Record<string, { value?: string }>;
      descriptions?: Record<string, { value?: string }>;
      sitelinks?: Record<string, { title?: string }>;
    }
  >;
}

/** What Wikidata knows about one place in the reader's language. */
interface Localized {
  label?: string;
  /** Wikidata's one-line description, e.g. "art museum in Semboku, Japan". */
  description?: string;
  /** Title of the article in the reader's own Wikipedia edition, if it exists. */
  article?: string;
}

// ---------------------------------------------------------------------------
// "Is this text already in the reader's language?"
//
// Two cheap, offline signals, no language-detection dependency:
//
//  1. Script. A language is written in a known script, so Japanese prose in an
//     English guide is recognisable without understanding a word of it. This is
//     used only NEGATIVELY — to reject text that cannot be in the target
//     language — never to claim text IS in it.
//  2. Provenance. Script says nothing about Vietnamese text in an English guide
//     (both Latin), so discovered POIs carry the Wikipedia edition they were
//     read from in their id. A mismatch is decisive on its own.
// ---------------------------------------------------------------------------
const CYRILLIC = /\p{Script=Cyrillic}/u;
const ARABIC = /\p{Script=Arabic}/u;
const DEVANAGARI = /\p{Script=Devanagari}/u;
const HAN = /\p{Script=Han}/u;

const LANG_SCRIPT: Record<string, RegExp> = {
  ja: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u,
  zh: HAN,
  ko: /\p{Script=Hangul}/u,
  th: /\p{Script=Thai}/u,
  lo: /\p{Script=Lao}/u,
  km: /\p{Script=Khmer}/u,
  my: /\p{Script=Myanmar}/u,
  ka: /\p{Script=Georgian}/u,
  hy: /\p{Script=Armenian}/u,
  am: /\p{Script=Ethiopic}/u,
  he: /\p{Script=Hebrew}/u,
  el: /\p{Script=Greek}/u,
  si: /\p{Script=Sinhala}/u,
  ta: /\p{Script=Tamil}/u,
  bn: /\p{Script=Bengali}/u,
  ar: ARABIC, fa: ARABIC, ur: ARABIC,
  ru: CYRILLIC, uk: CYRILLIC, be: CYRILLIC, bg: CYRILLIC, sr: CYRILLIC, mk: CYRILLIC,
  kk: CYRILLIC, mn: CYRILLIC,
  hi: DEVANAGARI, ne: DEVANAGARI, mr: DEVANAGARI,
};
const LATIN = /\p{Script=Latin}/u;

/** Is most of `text` written in `script`? Short strings are never judged. */
function inScript(text: string, script: RegExp): boolean {
  const letters = text.match(/\p{L}/gu);
  if (!letters || letters.length < 8) return true;
  let hits = 0;
  for (const ch of letters) if (script.test(ch)) hits++;
  return hits / letters.length >= 0.5;
}

/** Could this text be in `lang`? Negative signal only — see the note above. */
function looksForeign(text: string, lang: string): boolean {
  return !inScript(text, LANG_SCRIPT[lang] ?? LATIN);
}

/**
 * Does this NAME contain script the reader cannot read?
 *
 * Deliberately not `looksForeign`, which asks whether MOST of a text is in the
 * wrong script and declines to judge anything under 8 letters. Both rules are
 * right for a paragraph and wrong for a name: "下野の女夫マツ" is 7 letters, so it
 * was never even considered, and "パノラマ展望台 (Panorama observatory)" is majority
 * Latin, so it counted as English while still showing kana. Names are short and
 * a single unreadable character is the whole problem, so any letter outside the
 * reader's script counts.
 */
function needsScriptWork(name: string, lang: string): boolean {
  const want = LANG_SCRIPT[lang] ?? LATIN;
  const letters = name.match(/\p{L}/gu);
  if (!letters) return false;
  return letters.some((ch) => !want.test(ch));
}

function isForeignText(d: Destination, lang: string): boolean {
  if (!d.description) return false;
  const from = sourceLangOf(d.id);
  if (from) return from !== lang;
  return looksForeign(d.description, lang);
}

interface WpExtracts {
  query?: {
    normalized?: Array<{ from: string; to: string }>;
    redirects?: Array<{ from: string; to: string }>;
    pages?: Array<{ title: string; extract?: string }>;
  };
}

/**
 * MediaWiki answers under the title it RESOLVED, not the one we asked for: a
 * title gets unicode/underscore-normalised, and a redirect is followed. Wikidata
 * sitelinks do point at redirects (an article gets renamed, the sitelink lags),
 * so looking the answer up under the requested title would silently come back
 * empty — indistinguishable from "this language has no article", which drops us
 * to the local-language last resort while a perfectly good translation exists.
 * Walking the alias chain back keeps every requested title able to find its text.
 */
function keyByRequested<T>(requested: string[], resolved: Map<string, T>, alias: Map<string, string>): Map<string, T> {
  const out = new Map<string, T>();
  for (const title of requested) {
    let cur = title;
    // Bounded: normalisation then redirect is two hops; the cap stops a cycle.
    for (let i = 0; i < 4 && !resolved.has(cur) && alias.has(cur); i++) cur = alias.get(cur)!;
    const value = resolved.get(cur);
    if (value !== undefined) out.set(title, value);
  }
  return out;
}

/** Lead sentences of each article from the reader's own Wikipedia edition. */
async function extracts(lang: string, titles: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  // prop=extracts is capped at 20 pages per request for anonymous callers.
  for (const part of chunk(titles, 20)) {
    const data = await getJson<WpExtracts>(
      `https://${lang}.wikipedia.org/w/api.php?` +
        new URLSearchParams({
          action: 'query',
          prop: 'extracts',
          exintro: '1',
          explaintext: '1',
          exsentences: '3',
          exlimit: '20',
          redirects: '1',
          titles: part.join('|'),
          format: 'json',
          formatversion: '2',
          origin: '*',
        }).toString(),
    );
    const byResolved = new Map<string, string>();
    for (const p of data?.query?.pages ?? []) {
      const text = (p.extract ?? '').trim();
      if (text) byResolved.set(p.title, text);
    }
    const alias = new Map<string, string>();
    for (const r of [...(data?.query?.normalized ?? []), ...(data?.query?.redirects ?? [])]) alias.set(r.from, r.to);
    for (const [title, text] of keyByRequested(part, byResolved, alias)) out.set(title, text);
  }
  return out;
}

function sentenceCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Rewrite destination names AND descriptions into `lang`, using Wikidata as the
 * multilingual index: its label for the name, its sitelink to find the article
 * in the reader's own Wikipedia for the description, and its one-line
 * description as a short fallback when that edition has no article.
 *
 * Only places with a Wikidata id can be localized; others keep their source
 * text. Text we cannot re-source is LEFT ALONE rather than blanked — a
 * description in the wrong language still tells the reader something, and an
 * empty card tells them nothing.
 */
export async function localizeNames(destinations: Destination[], lang: string): Promise<void> {
  const qids = [...new Set(destinations.map((d) => d.wikidata).filter((x): x is string => Boolean(x)))];
  if (!qids.length) return;
  // Guard the sitefilter/host interpolation: every Wikipedia edition we can
  // reach is a plain code like "en" or "vi".
  const wiki = /^[a-z]{2,3}$/.test(lang) ? `${lang}wiki` : null;

  const info = new Map<string, Localized>();
  for (const part of chunk(qids, 45)) {
    const params: Record<string, string> = {
      action: 'wbgetentities',
      ids: part.join('|'),
      props: wiki ? 'labels|descriptions|sitelinks' : 'labels|descriptions',
      languages: lang,
      format: 'json',
      formatversion: '2',
      origin: '*',
    };
    if (wiki) params.sitefilter = wiki;
    const data = await getJson<WdLabels>(`${WIKIDATA}?` + new URLSearchParams(params).toString());
    for (const [qid, ent] of Object.entries(data?.entities ?? {})) {
      info.set(qid, {
        label: ent.labels?.[lang]?.value,
        description: ent.descriptions?.[lang]?.value,
        article: wiki ? ent.sitelinks?.[wiki]?.title : undefined,
      });
    }
  }

  // Only places whose text is in the wrong language need an article fetched, so
  // an already-English guide costs nothing extra.
  const needsText = destinations.filter(
    (d) => d.wikidata && isForeignText(d, lang) && info.get(d.wikidata)?.article,
  );
  const articles = new Set(needsText.map((d) => info.get(d.wikidata!)!.article!));
  const lead = articles.size && wiki ? await extracts(lang, [...articles]) : new Map<string, string>();

  for (const d of destinations) {
    // Free and key-less, so it runs for every place, Wikidata item or not:
    // a name that already carries its own translation just needs splitting.
    if (needsScriptWork(d.name, lang)) {
      const split = scriptSplitName(d.name, lang);
      if (split) d.name = split;
    }
    if (!d.wikidata) continue;
    const local = info.get(d.wikidata);
    if (!local) continue;
    // A place with no label in this language may still have an article in it;
    // its title is that language's name for the place.
    const name = local.label ?? local.article;
    if (name) d.name = name;
    if (!isForeignText(d, lang)) continue;

    // Descriptions, best source FIRST — the reader's own language is preferred
    // at every rung, and the local-language text is only ever kept because both
    // rungs came up empty, never because we stopped looking early:
    //
    //  1. the lead of the article in the reader's own Wikipedia edition, found
    //     through this item's sitelink. Full, real prose, written by that
    //     edition's editors — not a translation of the local one.
    //  2. Wikidata's one-line description in the reader's language. Short, but
    //     it exists for plenty of places no edition has an article for.
    //  3. (implicit) keep the local-language text. A true sentence the reader
    //     must paste into a translator still beats an empty card.
    const article = local.article ? lead.get(local.article) : undefined;
    const text = article ?? (local.description ? sentenceCase(local.description) : undefined);
    // Guard the swap: an edition occasionally holds a stub written in another
    // language, and replacing foreign text with equally foreign text would cost
    // us the one thing the original had going for it — being the article the
    // rest of this place's data (name, image, coordinates) came from.
    if (text && !looksForeign(text, lang)) d.description = text;
  }

  // 4. Whatever is STILL unreadable had no counterpart to re-source anywhere in
  //    Wikidata or Wikipedia. Translate it rather than hand the reader a card in
  //    a script they did not ask for.
  const jobs: TranslationJob[] = [];
  for (const d of destinations) {
    const job: TranslationJob = { d };
    if (needsScriptWork(d.name, lang)) job.name = d.name;
    if (d.description && looksForeign(d.description, lang)) job.description = d.description;
    if (job.name || job.description) jobs.push(job);
  }
  if (jobs.length) await translateRemaining(jobs, lang);
}

// ---------------------------------------------------------------------------
// Last resorts, for places the multilingual index simply does not cover.
//
// Re-sourcing is always preferred and is tried first: it yields real prose by
// real editors, and it needs no API key. But a rural Japanese temple with a
// Wikidata item, no English label, no English article and no English one-line
// description leaves nothing to re-source, and the reader gets a card they
// cannot read. Two fallbacks, cheapest first.
// ---------------------------------------------------------------------------

/**
 * Some names already carry their own translation — OSM contributors write
 * "パノラマ展望台 (Panorama observatory)" or "Tsumago Castle (妻籠城跡)". When a
 * name mixes the reader's script with a foreign one, the part already in their
 * script IS the translation, and it costs nothing to prefer it.
 */
function scriptSplitName(name: string, lang: string): string | null {
  const want = LANG_SCRIPT[lang] ?? LATIN;
  // Split on bracketed groups, keeping the pieces.
  const parts = name.split(/[（(]([^）)]*)[）)]/).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const good = parts.filter((p) => (p.match(/\p{L}/gu)?.length ?? 0) >= 2 && inScript(p, want));
  if (good.length !== 1) return null;
  const picked = good[0];
  return picked !== name.trim() ? picked : null;
}

interface TranslationJob {
  d: Destination;
  name?: string;
  description?: string;
}

/**
 * Translate what could not be re-sourced, in ONE batched call per guide.
 *
 * This is the only machine translation in the pipeline and it is deliberately
 * last: it runs solely on text that has no counterpart in the reader's language
 * anywhere in Wikidata or Wikipedia. Translating a sourced sentence is not the
 * same as inventing one, but it is not an editor's sentence either, so anything
 * that comes back is flagged `translated` and the UI says so.
 *
 * Degrades silently: with no API key, or on any error or malformed reply, the
 * original text is kept exactly as before.
 */
const translationCache = new Map<string, string>();

async function translateRemaining(jobs: TranslationJob[], lang: string): Promise<void> {
  const llm = getLLM();
  if (!llm.generative || !llm.chat) return;

  // Serve what we can from previous guide builds before paying for a call.
  const pending: Array<{ job: TranslationJob; field: 'name' | 'description'; text: string }> = [];
  for (const job of jobs) {
    for (const field of ['name', 'description'] as const) {
      const text = job[field];
      if (!text) continue;
      const hit = translationCache.get(`${lang} ${text}`);
      if (hit) {
        job.d[field] = hit;
        job.d.translated = true;
      } else {
        pending.push({ job, field, text });
      }
    }
  }
  if (!pending.length) return;

  const payload = pending.map((p, i) => ({ i, kind: p.field, text: p.text }));
  const system =
    'You translate place names and encyclopedia descriptions for a travel guide. ' +
    'Translate faithfully and completely into the target language. Do not summarise, ' +
    'embellish, or add facts that are not in the source. For place names, use the ' +
    'established English form if one exists, otherwise a standard romanization; keep ' +
    'any parenthetical disambiguation. Reply with JSON only: ' +
    '{"out":[{"i":<number>,"text":"<translation>"}]} covering every input id.';
  const user = `Target language code: ${lang}\n\n${JSON.stringify(payload)}`;

  let reply: string;
  try {
    reply = await llm.chat(system, user);
  } catch {
    return; // keep the originals
  }
  const match = reply.match(/\{[\s\S]*\}/);
  if (!match) return;
  let parsed: { out?: Array<{ i?: number; text?: string }> };
  try {
    parsed = JSON.parse(match[0]) as typeof parsed;
  } catch {
    return;
  }

  for (const item of parsed.out ?? []) {
    if (typeof item?.i !== 'number' || typeof item.text !== 'string') continue;
    const slot = pending[item.i];
    const text = item.text.trim();
    // A "translation" still in the source script is the model echoing its input;
    // keeping the original is no worse and avoids mislabelling it as translated.
    const stillUnreadable =
      slot?.field === 'name' ? needsScriptWork(text, lang) : looksForeign(text, lang);
    if (!slot || !text || stillUnreadable) continue;
    translationCache.set(`${lang} ${slot.text}`, text);
    slot.job.d[slot.field] = text;
    slot.job.d.translated = true;
  }
}

interface WdSearch {
  search?: Array<{ id: string; label?: string }>;
}

/**
 * Localize the guide's headline place name (e.g. "Kyoto" → "京都"). Conservative:
 * we only translate when a Wikidata item's English label exactly matches the
 * title, so we never mislabel an ambiguous query.
 */
export async function localizeTitle(title: string, lang: string): Promise<string | null> {
  if (lang === 'en') return null;
  const search = await getJson<WdSearch>(
    `${WIKIDATA}?` +
      new URLSearchParams({
        action: 'wbsearchentities',
        search: title,
        language: 'en',
        uselang: 'en',
        type: 'item',
        limit: '5',
        format: 'json',
        origin: '*',
      }).toString(),
  );
  const hit = (search?.search ?? []).find((h) => h.label?.toLowerCase() === title.trim().toLowerCase());
  if (!hit) return null;
  const data = await getJson<WdLabels>(
    `${WIKIDATA}?` +
      new URLSearchParams({
        action: 'wbgetentities',
        ids: hit.id,
        props: 'labels',
        languages: lang,
        format: 'json',
        formatversion: '2',
        origin: '*',
      }).toString(),
  );
  return data?.entities?.[hit.id]?.labels?.[lang]?.value ?? null;
}
