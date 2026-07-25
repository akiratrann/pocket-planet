// Language detection for a location, so we can "scrape the web in any language".
// A place's local-language Wikipedia usually has far more (and more obscure)
// content — articles, photos, POIs — than English. We map the location's country
// to its Wikipedia language code(s) and use those alongside English.

import { reverseCountryCode } from '../../src/data/geocode.ts';

/** ISO 3166-1 alpha-2 (lowercase) → Wikipedia language code(s), most-local first. */
const COUNTRY_LANGS: Record<string, string[]> = {
  // East / Southeast Asia
  jp: ['ja'], cn: ['zh'], tw: ['zh'], hk: ['zh'], mo: ['zh'], kr: ['ko'], kp: ['ko'],
  th: ['th'], vn: ['vi'], id: ['id'], my: ['ms'], la: ['lo'], kh: ['km'], mm: ['my'],
  ph: ['tl'], mn: ['mn'],
  // South / Central Asia
  in: ['hi'], pk: ['ur'], bd: ['bn'], lk: ['si'], np: ['ne'], ir: ['fa'], af: ['fa'],
  kz: ['kk'], uz: ['uz'], ge: ['ka'], am: ['hy'], az: ['az'],
  // Middle East / North Africa (Arabic + others)
  sa: ['ar'], ae: ['ar'], eg: ['ar'], ma: ['ar'], tn: ['ar'], dz: ['ar'], jo: ['ar'],
  qa: ['ar'], kw: ['ar'], om: ['ar'], bh: ['ar'], lb: ['ar'], iq: ['ar'], sy: ['ar'],
  il: ['he'], tr: ['tr'],
  // Europe
  fr: ['fr'], de: ['de'], at: ['de'], ch: ['de', 'fr', 'it'], it: ['it'], es: ['es'],
  pt: ['pt'], nl: ['nl'], be: ['nl', 'fr'], lu: ['fr', 'de'], se: ['sv'], no: ['no'],
  dk: ['da'], fi: ['fi'], is: ['is'], pl: ['pl'], cz: ['cs'], sk: ['sk'], hu: ['hu'],
  ro: ['ro'], bg: ['bg'], gr: ['el'], hr: ['hr'], rs: ['sr'], si: ['sl'], ua: ['uk'],
  ru: ['ru'], by: ['be'], lt: ['lt'], lv: ['lv'], ee: ['et'], ie: ['en'], gb: ['en'],
  // Americas (Spanish/Portuguese/French)
  mx: ['es'], ar: ['es'], cl: ['es'], co: ['es'], pe: ['es'], ec: ['es'], bo: ['es'],
   py: ['es'], uy: ['es'], ve: ['es'], cr: ['es'], gt: ['es'], cu: ['es'], do: ['es'],
  br: ['pt'], ht: ['fr'], us: ['en'], ca: ['en', 'fr'],
  // Africa (varied; common lingua francas)
  za: ['af', 'zu'], ke: ['sw'], tz: ['sw'], et: ['am'], ng: ['en'], gh: ['en'],
  sn: ['fr'], ci: ['fr'], cm: ['fr'], cd: ['fr'], mg: ['mg'],
  // Oceania
  au: ['en'], nz: ['en'], fj: ['en'],
};

const cache = new Map<string, string[]>();

/**
 * Determine the local Wikipedia language code(s) for a guide, from its map
 * center. Returns [] when unknown (callers then just use English). English is
 * handled separately as the base language, so it isn't repeated here.
 */
export async function guideLanguages(center: [number, number]): Promise<string[]> {
  const [lon, lat] = center;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const cc = await reverseCountryCode(lat, lon);
  const langs = (cc && COUNTRY_LANGS[cc]) ? COUNTRY_LANGS[cc].filter((l) => l !== 'en') : [];
  cache.set(key, langs);
  return langs;
}

/** Wikipedia languages to try for a country code (local first, English last). */
export function languagesForCountry(cc: string | null): string[] {
  const local = cc && COUNTRY_LANGS[cc] ? COUNTRY_LANGS[cc] : [];
  return [...new Set([...local, 'en'])];
}
