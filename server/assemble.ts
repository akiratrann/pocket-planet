// RAG-style guide assembly: base guidebook data (Wikivoyage) + learned knowledge
// (ingested web sources) + learned adjustments (feedback + self-tuning).

import { getGuide } from '../src/data/wikivoyage.ts';
import { applyLearning } from '../src/core/learning.ts';
import type { Guide, GuideMeta } from '../src/types.ts';
import { getLLM } from './llm/adapter.ts';
import { store } from './store.ts';
import { resolveImages } from './pipeline/images.ts';
import { buildOpinions } from './pipeline/opinions.ts';

export type GuideResponse = Guide & { meta: GuideMeta };

export async function assembleGuide(query: string): Promise<GuideResponse> {
  const base = await getGuide(query);

  // Pull ingested knowledge for this location (match on both the query and the
  // resolved article title so sources line up regardless of which was used).
  const sourcesByTitle = await store.getSources(base.title);
  const sourcesByQuery = query.toLowerCase() === base.title.toLowerCase() ? [] : await store.getSources(query);
  const sources = [...sourcesByTitle, ...sourcesByQuery];
  const extras = sources.flatMap((s) => s.pois);

  const learned = await store.getLearned();
  const enriched = applyLearning(base, learned, extras);

  // Fetch real photos for places that don't already have one.
  await resolveImages(enriched.destinations);

  // Summarize what travellers say (grounded in real sources; never invented).
  const opinions = await buildOpinions(enriched, sources);

  const feedback = await store.getFeedback();
  const feedbackApplied = feedback.filter(
    (f) => f.location.toLowerCase() === base.title.toLowerCase(),
  ).length;

  const meta: GuideMeta = {
    provider: getLLM().name,
    learnedVersion: learned.version,
    feedbackApplied,
    ingestedPois: extras.length,
    sources: sources.map((s) => ({
      title: s.title,
      url: s.url,
      fetchedAt: s.fetchedAt,
      poiCount: s.pois.length,
    })),
    opinions,
  };

  return { ...enriched, meta };
}
