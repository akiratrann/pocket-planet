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
// Nothing here is machine-translated or invented.

import type { Destination } from '../../src/types.ts';
import { sourceLangOf } from './discover.ts';

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

function isForeignText(d: Destination, lang: string): boolean {
  if (!d.description) return false;
  const from = sourceLangOf(d.id);
  if (from) return from !== lang;
  return !inScript(d.description, LANG_SCRIPT[lang] ?? LATIN);
}

interface WpExtracts {
  query?: { pages?: Array<{ title: string; extract?: string }> };
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
          titles: part.join('|'),
          format: 'json',
          formatversion: '2',
          origin: '*',
        }).toString(),
    );
    for (const p of data?.query?.pages ?? []) {
      const text = (p.extract ?? '').trim();
      if (text) out.set(p.title, text);
    }
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
    if (!d.wikidata) continue;
    const local = info.get(d.wikidata);
    if (!local) continue;
    // A place with no label in this language may still have an article in it;
    // its title is that language's name for the place.
    const name = local.label ?? local.article;
    if (name) d.name = name;
    if (!isForeignText(d, lang)) continue;
    const article = local.article ? lead.get(local.article) : undefined;
    const text = article ?? (local.description ? sentenceCase(local.description) : undefined);
    if (text) d.description = text;
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
