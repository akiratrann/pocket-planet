// Per-user personalization.
//
// What this is allowed to know about a person is exactly what they told us by
// using the app: the places they pinned and the stops in their itineraries,
// which is the only per-user state the backend holds (see `UserData` in
// store.ts). There is no profile, no inferred demographic, no cross-site
// signal, and nothing is invented — every pick this module returns can name the
// saved places that produced it, and the UI says so out loud.
//
// It deliberately does NOT re-rank the guide. Scores and ranks are global and
// cached for everyone; making them differ per account would mean two people
// discussing "the #1 thing in Kyoto" were shown different places and told the
// same number. Personalization is a SHORTLIST drawn from the same guide, in the
// same order the guide already put it — a different way in, not a different set
// of facts.

import type { CategoryId, Destination, Guide } from '../src/types.ts';
import type { User } from './store.ts';

/** How many categories can contribute picks, and how many picks we return. */
const TASTE_CATEGORIES = 3;
const MAX_PICKS = 4;

export interface PersonalCategory {
  category: CategoryId;
  /** Places the user has saved in this category, account-wide. */
  saved: number;
}

export interface PersonalPick {
  id: string;
  name: string;
  category: CategoryId;
  score: number;
  rank: number;
  image?: string;
  description?: string;
  /** The saved-place evidence that produced this pick — never anything else. */
  because: PersonalCategory;
}

export interface Personalization {
  /** Display name of the signed-in account this was computed for. */
  name: string;
  /** The guide these picks come from. */
  location: string;
  /** Distinct places saved across the account (pins + itinerary stops). */
  savedTotal: number;
  /** How many of those are places in the guide being viewed. */
  savedHere: number;
  /** Categories the account saves from, most-saved first. Empty = no signal. */
  taste: PersonalCategory[];
  picks: PersonalPick[];
}

/** A saved place as it survives the round trip through `UserData` (`unknown[]`). */
interface SavedLike {
  id: string;
  name: string;
  category: CategoryId;
  location?: string;
}

function asSaved(raw: unknown): SavedLike | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' || typeof o.name !== 'string') return null;
  if (typeof o.category !== 'string') return null;
  return {
    id: o.id,
    name: o.name,
    category: o.category as CategoryId,
    ...(typeof o.location === 'string' ? { location: o.location } : {}),
  };
}

/**
 * Every place the account has saved, de-duplicated by id.
 *
 * Pins and itinerary stops are counted once each: a place you pinned AND put in
 * a trip is one place you like, and counting it twice would inflate the number
 * shown next to "you saved N".
 */
function savedPlaces(user: User): SavedLike[] {
  const out = new Map<string, SavedLike>();
  const take = (raw: unknown) => {
    const s = asSaved(raw);
    if (s && !out.has(s.id)) out.set(s.id, s);
  };
  for (const p of user.data?.pinned ?? []) take(p);
  for (const it of user.data?.itineraries ?? []) {
    const places = (it as { places?: unknown })?.places;
    if (Array.isArray(places)) for (const p of places) take(p);
  }
  return [...out.values()];
}

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * Build one user's view of one guide. Pure: give it the same account and the
 * same guide and it returns the same thing, which is what makes the "because"
 * lines checkable by the person reading them.
 */
export function personalizeGuide(user: User, guide: Guide): Personalization {
  const saved = savedPlaces(user);

  const counts = new Map<CategoryId, number>();
  for (const s of saved) counts.set(s.category, (counts.get(s.category) ?? 0) + 1);
  const taste: PersonalCategory[] = [...counts.entries()]
    .map(([category, n]) => ({ category, saved: n }))
    .sort((a, b) => b.saved - a.saved || a.category.localeCompare(b.category));

  const savedIds = new Set(saved.map((s) => s.id));
  const savedNames = new Set(saved.map((s) => normalize(s.name)));
  const savedHere = guide.destinations.filter(
    (d) => savedIds.has(d.id) || savedNames.has(normalize(d.name)),
  ).length;

  const top = taste.slice(0, TASTE_CATEGORIES);
  const picks: PersonalPick[] = [];
  for (const cat of top) {
    const inCat = guide.destinations
      .filter(
        (d: Destination) =>
          d.category === cat.category && !savedIds.has(d.id) && !savedNames.has(normalize(d.name)),
      )
      // The guide's own order, untouched: this is a filter over the shared
      // ranking, not a second opinion about it.
      .sort((a, b) => a.rank - b.rank);
    // One per category first, so a person who saves mostly temples still sees
    // the other things they save rather than four temples.
    const best = inCat[0];
    if (!best) continue;
    picks.push({
      id: best.id,
      name: best.name,
      category: best.category,
      score: best.score,
      rank: best.rank,
      ...(best.image ? { image: best.image } : {}),
      ...(best.description ? { description: best.description } : {}),
      because: cat,
    });
  }
  // Fill any remaining slots from the strongest category, in guide order.
  const chosen = new Set(picks.map((p) => p.id));
  const strongest = top[0];
  if (strongest) {
    for (const d of guide.destinations
      .filter(
        (d) =>
          d.category === strongest.category &&
          !savedIds.has(d.id) &&
          !savedNames.has(normalize(d.name)) &&
          !chosen.has(d.id),
      )
      .sort((a, b) => a.rank - b.rank)) {
      if (picks.length >= MAX_PICKS) break;
      picks.push({
        id: d.id,
        name: d.name,
        category: d.category,
        score: d.score,
        rank: d.rank,
        ...(d.image ? { image: d.image } : {}),
        ...(d.description ? { description: d.description } : {}),
        because: strongest,
      });
      chosen.add(d.id);
    }
  }

  return {
    name: user.name,
    location: guide.title,
    savedTotal: saved.length,
    savedHere,
    taste,
    picks: picks.slice(0, MAX_PICKS),
  };
}
