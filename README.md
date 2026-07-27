# Pocket Planet

A travel guide and map for anywhere in the world. Search a place, get the best
things to do there — ranked by how strongly real travel sources recommend them,
grouped by category, in your language.

Sources are mined and cited rather than invented: Wikivoyage, OpenStreetMap,
Lonely Planet editorial, YouTube, Travel Stack Exchange and Reddit. The ranking
weights are learned from feedback and re-tuned on a schedule.

## Quick start

```bash
npm install
npm run dev:all
```

That runs the Vite dev server and the API together. The frontend proxies `/api`
to the backend on port 8787. **No API keys are required** — the default LLM
provider is a zero-dependency heuristic engine, so the whole app works from a
cold clone.

| Command | What it does |
|---|---|
| `npm run dev:all` | Frontend + API together (what you usually want) |
| `npm run dev` | Vite dev server only |
| `npm run server` | API only, with watch |
| `npm run build` | Typecheck, build the PWA into `dist/` |
| `npm run start` | Serve the built app + API from one process |
| `npm run prod` | `build` then `start` |
| `npm run lint` | oxlint |

## How it's put together

```
landing/index.html   standalone marketing page  ->  served at /
src/                 React PWA (map, search, itinerary)  ->  served at /app
server/              Fastify API + ingestion + cron  ->  /api
  pipeline/          per-source scrapers and the chat/answer pipeline
  llm/adapter.ts     pluggable LLM layer (see below)
  store.ts           JSON-file persistence in server/.data
```

In production a single process serves all three: the landing page at `/`, the
built PWA at `/app`, and the API under `/api`. One container, one origin.

## LLM providers

`server/llm/adapter.ts` is provider-agnostic. Set `LLM_PROVIDER` in `.env`:

| Value | Needs | Notes |
|---|---|---|
| `heuristic` | nothing | Default. Rule-based extraction and summarization. |
| `anthropic` | `ANTHROPIC_API_KEY` | Defaults to `claude-opus-5`. Best quality. |
| `openai` | `OPENAI_API_KEY` | |
| `ollama` | a local Ollama | Free, runs on your machine. |

Only `heuristic` runs with no key; the others fall back to it with a warning if
their key is missing, so a misconfigured deploy stays up.

Note for the Anthropic path: current Claude models think by default, and
`max_tokens` caps thinking *and* response text together — which is why the
adapter budgets generously and selects the response's text block by **type**
rather than by index. Reading `content[0].text` returns nothing on a
thinking-enabled model, silently falling back to the heuristic engine.

## Data and persistence

Everything persistent is JSON under `server/.data/` — learned ranking weights,
feedback, tracked locations, cached images, user accounts, and a generated
`auth-secret`. This directory is gitignored and dockerignored.

Two consequences worth knowing before deploying:

- **The app needs a persistent disk.** On an ephemeral filesystem every restart
  wipes accounts and learned state, and regenerating `auth-secret` logs everyone
  out.
- **It runs one instance.** State is local files, not a shared database, so it
  does not scale horizontally as written. Moving to Postgres, or SQLite on a
  volume, is the change to make if that becomes a constraint.

## Scheduled work

The server runs two in-process cron jobs (`node-cron`):

| Job | Default | Env |
|---|---|---|
| Re-ingest tracked locations | daily, 03:00 | `INGEST_CRON` |
| Self-tune ranking weights | every 6 hours | `TUNE_CRON` |

Set `DISABLE_CRON=1` to turn both off — useful in local dev and in tests.

Because these run *in the web process*, the host must keep a machine running.
A scale-to-zero platform will serve traffic fine and silently never run either
job, so the app quietly stops learning.

## Deploying

The `Dockerfile` builds the PWA and serves it plus the API on `$PORT`. It works
on anything that runs a container, but the host must offer **a persistent volume
and an always-on instance** (see above). That rules out scale-to-zero,
ephemeral-disk platforms like Cloud Run for this architecture.

`fly.toml` is set up accordingly:

```bash
fly launch --no-deploy
fly volumes create pocket_planet_data --size 1 --region sjc
fly secrets set ANTHROPIC_API_KEY=sk-ant-... LLM_PROVIDER=anthropic
fly deploy
```

## Configuration

See `.env.example` for the full list. The ones that matter most:

| Variable | Default | Purpose |
|---|---|---|
| `LLM_PROVIDER` | `heuristic` | Which model powers extraction and chat |
| `ANTHROPIC_API_KEY` | — | Required when `LLM_PROVIDER=anthropic` |
| `ANTHROPIC_MODEL` | `claude-opus-5` | Override for a cheaper model |
| `PORT` | `8787` | Server port (`8080` in the container) |
| `DISABLE_CRON` | — | Set to `1` to disable scheduled jobs |
| `STACKEXCHANGE_KEY` | — | Optional; raises the free 300 req/day quota |
| `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` | — | Optional; enables Reddit mining |

Community mining is optional: Travel Stack Exchange works with no key, and
Reddit is skipped unless credentials are set.
