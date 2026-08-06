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

// ---------------------------------------------------------------------------
// Where to go next: destination suggestions for an empty search box.
//
// Same rule as the rest of this file, and it is the whole point of the feature:
// a suggestion is only offered when the ACCOUNT ITSELF is the reason for it.
// The two things that qualify are the places the reader saved (each one records
// the guide it came from) and the destination they pointed a trip at. Both are
// facts the reader can check against their own pins and trips.
//
// What is deliberately NOT here: anything popular, trending, sponsored, or
// inferred. If this returns nothing, the UI shows its plain starter chips and
// says nothing about the reader — a popular city dressed up as "recommended for
// you" would be a lie, and one the reader has no way to catch.
// ---------------------------------------------------------------------------

/** Why one destination is being offered. Always a fact about the reader. */
export type DestinationBasis =
  /** They saved `places` places whose guide was this destination. */
  | { kind: 'saved'; places: number }
  /** They pointed the trip `trip` at it, and it holds `places` stops. */
  | { kind: 'trip'; trip: string; places: number };

export interface DestinationSuggestion {
  /** Exactly the guide name to search for. */
  name: string;
  because: DestinationBasis;
}

export interface PersonalDestinations {
  /** Display name of the signed-in account this was computed for. */
  name: string;
  /** Distinct places saved across the account (pins + itinerary stops). */
  savedTotal: number;
  /** Empty when the account has saved nothing yet — the honest "no signal". */
  suggestions: DestinationSuggestion[];
}

/** How many destinations the search box will offer. */
const MAX_DESTINATIONS = 6;

/**
 * Destinations to offer this account when the search box is focused and empty.
 *
 * A trip beats a pin count as the reason, because it is the stronger statement
 * of intent: someone who named a trip "Kyoto" is planning Kyoto, whatever their
 * pin count says. Otherwise the count of saved places is the reason, and the
 * number shown is the real one.
 */
export function suggestDestinations(user: User): PersonalDestinations {
  const saved = savedPlaces(user);

  // Count saved places per destination. `location` is the guide the place was
  // saved from; a place saved before that field existed simply has no vote.
  const savedPer = new Map<string, { name: string; places: number }>();
  for (const s of saved) {
    const loc = s.location?.trim();
    if (!loc) continue;
    const key = normalize(loc);
    const cur = savedPer.get(key);
    if (cur) cur.places++;
    else savedPer.set(key, { name: loc, places: 1 });
  }

  // Destinations the reader pointed a trip at, with that trip's stop count.
  const trips = new Map<string, { name: string; trip: string; places: number }>();
  for (const raw of user.data?.itineraries ?? []) {
    const it = raw as { destination?: unknown; name?: unknown; places?: unknown };
    const dest = typeof it.destination === 'string' ? it.destination.trim() : '';
    if (!dest) continue;
    const key = normalize(dest);
    const places = Array.isArray(it.places) ? it.places.length : 0;
    const trip = typeof it.name === 'string' && it.name.trim() ? it.name.trim() : dest;
    const cur = trips.get(key);
    // One destination, several trips: name the fullest one, so the reason the
    // reader is shown is the trip they have actually been working on.
    if (!cur || places > cur.places) trips.set(key, { name: dest, trip, places });
  }

  const out: DestinationSuggestion[] = [];
  const taken = new Set<string>();

  // Trips first — a named trip is the clearest statement of where they're going.
  for (const [key, t] of [...trips.entries()].sort((a, b) => b[1].places - a[1].places)) {
    taken.add(key);
    out.push({ name: t.name, because: { kind: 'trip', trip: t.trip, places: t.places } });
  }
  for (const [key, s] of [...savedPer.entries()].sort(
    (a, b) => b[1].places - a[1].places || a[1].name.localeCompare(b[1].name),
  )) {
    if (taken.has(key)) continue;
    out.push({ name: s.name, because: { kind: 'saved', places: s.places } });
  }

  return {
    name: user.name,
    savedTotal: saved.length,
    suggestions: out.slice(0, MAX_DESTINATIONS),
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
