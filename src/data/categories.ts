import type { Category, CategoryId, Destination } from '../types';

/**
 * App category taxonomy. Wikivoyage tags every listing with a coarse "type"
 * (see / do / buy / eat / drink / sleep). We expand those into the richer set a
 * traveller actually browses by, and refine ambiguous ones (See/Do) with keyword
 * heuristics below.
 */
export const CATEGORIES: Category[] = [
  {
    id: 'sights',
    label: 'Sights & Landmarks',
    icon: '📸',
    color: '#e4572e',
    wvTypes: ['see'],
    blurb: 'Iconic landmarks, viewpoints and unmissable places.',
  },
  {
    id: 'culture',
    label: 'Museums & Culture',
    icon: '🏛️',
    color: '#7b6d8d',
    wvTypes: ['see'],
    blurb: 'Museums, galleries, temples, historic and religious sites.',
  },
  {
    id: 'nature',
    label: 'Nature & Outdoors',
    icon: '🌲',
    color: '#2a9d8f',
    wvTypes: ['see', 'do'],
    blurb: 'Parks, gardens, beaches, mountains and natural wonders.',
  },
  {
    id: 'activities',
    label: 'Activities & Tours',
    icon: '🎡',
    color: '#f4a261',
    wvTypes: ['do'],
    blurb: 'Things to do — tours, experiences, shows and adventures.',
  },
  {
    id: 'food',
    label: 'Food',
    icon: '🍜',
    color: '#e9c46a',
    wvTypes: ['eat'],
    blurb: 'Where to eat, from street food to fine dining.',
  },
  {
    id: 'nightlife',
    label: 'Nightlife & Drinks',
    icon: '🍸',
    color: '#c1121f',
    wvTypes: ['drink'],
    blurb: 'Bars, cafes, clubs and after-dark spots.',
  },
  {
    id: 'shopping',
    label: 'Shopping',
    icon: '🛍️',
    color: '#4361ee',
    wvTypes: ['buy'],
    blurb: 'Markets, boutiques and where to find local goods.',
  },
  {
    id: 'sleep',
    label: 'Where to Stay',
    icon: '🛏️',
    color: '#3a5a40',
    wvTypes: ['sleep'],
    blurb: 'Hotels, hostels, ryokan and places to rest.',
  },
];

export const CATEGORY_MAP: Record<CategoryId, Category> = Object.fromEntries(
  CATEGORIES.map((c) => [c.id, c]),
) as Record<CategoryId, Category>;

/** Keyword cues used to split ambiguous "see"/"do" listings into finer categories. */
const CULTURE_KEYWORDS =
  /\b(museum|gallery|galleries|temple|shrine|church|cathedral|mosque|synagogue|monastery|palace|castle|fort|ruins?|archaeolog|heritage|historic|monument|memorial|theatre|theater|opera|cultural|library|shabad|pagoda|basilica|abbey|tomb|mausoleum)\b/i;

const NATURE_KEYWORDS =
  /\b(park|garden|beach|mountain|hill|lake|river|waterfall|falls?|forest|trail|hike|hiking|nature|reserve|national park|volcano|island|cave|canyon|valley|glacier|desert|bay|lagoon|cliff|viewpoint|scenic|wildlife|safari|zoo|aquarium|botanical)\b/i;

const NATURE_ACTIVITY_KEYWORDS =
  /\b(hike|hiking|trek|dive|diving|snorkel|surf|kayak|raft|ski|climb|cycl|bike|safari|boat|cruise|beach|swim|nature)\b/i;

/** Extra classification cues learned by the self-tuning loop. */
export interface ClassificationLearning {
  cultureKeywords?: string[];
  natureKeywords?: string[];
}

function matchesLearned(text: string, words?: string[]): boolean {
  if (!words || !words.length) return false;
  const lower = text.toLowerCase();
  return words.some((w) => lower.includes(w.toLowerCase()));
}

/**
 * Decide the final app category for a destination based on its Wikivoyage type
 * plus keyword cues in its name/description. This is deliberately simple + tunable,
 * and can be extended with keywords the system learns over time.
 */
export function classifyCategory(
  wvType: string,
  name: string,
  description = '',
  learned: ClassificationLearning = {},
): CategoryId {
  const t = wvType.toLowerCase();
  const text = `${name} ${description}`;
  const isCulture = () => CULTURE_KEYWORDS.test(text) || matchesLearned(text, learned.cultureKeywords);
  const isNature = () => NATURE_KEYWORDS.test(text) || matchesLearned(text, learned.natureKeywords);

  if (t === 'eat') return 'food';
  if (t === 'drink') return 'nightlife';
  if (t === 'buy') return 'shopping';
  if (t === 'sleep') return 'sleep';

  if (t === 'see') {
    // Culture takes priority: a temple with a famous garden is still culture.
    if (isCulture()) return 'culture';
    if (isNature()) return 'nature';
    return 'sights';
  }

  if (t === 'do') {
    if (NATURE_ACTIVITY_KEYWORDS.test(text) || matchesLearned(text, learned.natureKeywords))
      return 'nature';
    return 'activities';
  }

  // Fallback for listing/marker/vcard with no clear type.
  if (isCulture()) return 'culture';
  if (isNature()) return 'nature';
  return 'sights';
}

export function groupByCategory(
  destinations: Destination[],
): Record<CategoryId, Destination[]> {
  const grouped = Object.fromEntries(
    CATEGORIES.map((c) => [c.id, [] as Destination[]]),
  ) as Record<CategoryId, Destination[]>;
  for (const d of destinations) grouped[d.category].push(d);
  for (const id of Object.keys(grouped) as CategoryId[]) {
    grouped[id].sort((a, b) => a.rank - b.rank);
  }
  return grouped;
}
