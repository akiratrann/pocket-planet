// Community discussion mining — real traveller opinions from discussion platforms.
//
// The goal: make recommendations reflect what actual people say, not just what a
// guidebook lists. We pull threads from discussion platforms and feed them into
// the grounded opinion miner (pros/cons WITH links) and a ranking "buzz" signal
// (places people actually recommend get boosted). Everything is attributed to a
// real thread; nothing is invented.
//
// Sources:
//   • Stack Exchange (travel.stackexchange.com) — open API, always on.
//   • Reddit — via app-only OAuth; auto-enabled when REDDIT_CLIENT_ID/SECRET are
//     set (Reddit blocks unauthenticated access). Skipped silently otherwise.
//
// The module is pluggable: add a fetcher, return DiscussionThread[], done.

const UA = 'PocketPlanet/1.0 (https://github.com/akiratrann/pocket-planet)';

export interface DiscussionThread {
  platform: string; // 'Travel Stack Exchange' | 'Reddit'
  title: string;
  url: string;
  text: string; // question/post + top answers/comments, plain text
  score: number;
}

async function getJson<T>(url: string, init?: RequestInit, tries = 2): Promise<T | null> {
  for (let i = 0; i < tries; i++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(url, {
        ...init,
        headers: { 'User-Agent': UA, ...(init?.headers ?? {}) },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (res.status === 429 || res.status >= 500) throw new Error(`status ${res.status}`);
      if (!res.ok) return null;
      return (await res.json()) as T;
    } catch {
      if (i === tries - 1) return null;
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  return null;
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Stack Exchange — travel.stackexchange.com (open API).
// ---------------------------------------------------------------------------
interface SeItem {
  question_id: number;
  title: string;
  link: string;
  score: number;
  body?: string;
}
interface SeAnswer {
  question_id: number;
  score: number;
  body?: string;
}

async function fetchStackExchange(location: string, maxThreads: number): Promise<DiscussionThread[]> {
  const SE = 'https://api.stackexchange.com/2.3';
  const key = process.env.STACKEXCHANGE_KEY ? `&key=${process.env.STACKEXCHANGE_KEY}` : '';
  const q = (term: string) =>
    getJson<{ items?: SeItem[] }>(
      `${SE}/search/advanced?order=desc&sort=votes&q=${encodeURIComponent(term)}` +
        `&site=travel&pagesize=8&filter=withbody${key}`,
    );
  // Bias toward recommendation threads ("things to do"), falling back to a plain
  // search if that yields nothing — SE Travel is otherwise very logistics-heavy.
  let search = await q(`${location} things to do`);
  if (!(search?.items ?? []).length) search = await q(location);
  const questions = (search?.items ?? []).filter((it) => it.title).slice(0, maxThreads);
  if (!questions.length) return [];

  const ids = questions.map((q) => q.question_id).join(';');
  const ansData = await getJson<{ items?: SeAnswer[] }>(
    `${SE}/questions/${ids}/answers?order=desc&sort=votes&site=travel&pagesize=40&filter=withbody${key}`,
  );
  const answersByQ = new Map<number, string[]>();
  for (const a of ansData?.items ?? []) {
    if (!a.body) continue;
    const arr = answersByQ.get(a.question_id) ?? [];
    if (arr.length < 3) arr.push(stripHtml(a.body));
    answersByQ.set(a.question_id, arr);
  }

  return questions.map((q) => {
    const parts = [stripHtml(q.body ?? ''), ...(answersByQ.get(q.question_id) ?? [])].filter(Boolean);
    return {
      platform: 'Travel Stack Exchange',
      title: q.title,
      url: q.link,
      text: parts.join('\n').slice(0, 4000),
      score: q.score,
    };
  });
}

// ---------------------------------------------------------------------------
// Reddit — app-only OAuth (client_credentials). Needs a free "script" app:
//   https://www.reddit.com/prefs/apps  →  set REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET
// ---------------------------------------------------------------------------
let redditToken: { value: string; exp: number } | null = null;

async function getRedditToken(): Promise<string | null> {
  const id = process.env.REDDIT_CLIENT_ID;
  const secret = process.env.REDDIT_CLIENT_SECRET;
  if (!id || !secret) return null;
  if (redditToken && Date.now() < redditToken.exp) return redditToken.value;
  try {
    const res = await fetch('https://www.reddit.com/api/v1/access_token', {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': UA,
      },
      body: 'grant_type=client_credentials',
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!j.access_token) return null;
    redditToken = { value: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 - 60000 };
    return redditToken.value;
  } catch {
    return null;
  }
}

interface RedditChild {
  kind: string;
  data: {
    id?: string;
    title?: string;
    permalink?: string;
    selftext?: string;
    score?: number;
    body?: string;
  };
}

async function fetchReddit(location: string, maxThreads: number): Promise<DiscussionThread[]> {
  const token = await getRedditToken();
  if (!token) return [];
  const auth = { Authorization: `Bearer ${token}` };
  const search = await getJson<{ data?: { children?: RedditChild[] } }>(
    `https://oauth.reddit.com/search?q=${encodeURIComponent(location + ' things to do')}` +
      `&sort=top&t=all&limit=12&type=link&raw_json=1`,
    { headers: auth },
  );
  const posts = (search?.data?.children ?? [])
    .map((c) => c.data)
    .filter((p) => p.id && p.title)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, maxThreads);

  const threads: DiscussionThread[] = [];
  for (const p of posts) {
    const comments = await getJson<Array<{ data?: { children?: RedditChild[] } }>>(
      `https://oauth.reddit.com/comments/${p.id}?sort=top&limit=15&depth=1&raw_json=1`,
      { headers: auth },
    );
    const bodies = (comments?.[1]?.data?.children ?? [])
      .filter((c) => c.kind === 't1' && c.data.body && !['[deleted]', '[removed]'].includes(c.data.body))
      .map((c) => c.data.body as string)
      .slice(0, 8);
    const text = [p.selftext ?? '', ...bodies].filter((t) => t && t.length > 30).join('\n').slice(0, 4000);
    if (!text) continue;
    threads.push({
      platform: 'Reddit',
      title: p.title as string,
      url: `https://www.reddit.com${p.permalink}`,
      text,
      score: p.score ?? 0,
    });
  }
  return threads;
}

/** Fetch discussion threads about a location from all available platforms. */
export async function fetchDiscussions(location: string, maxPerPlatform = 6): Promise<DiscussionThread[]> {
  const [se, reddit] = await Promise.all([
    fetchStackExchange(location, maxPerPlatform).catch(() => []),
    fetchReddit(location, maxPerPlatform).catch(() => []),
  ]);
  return [...reddit, ...se].filter((t) => t.text.trim().length > 40);
}
