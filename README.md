# Attachment Compass

A personal Q&A app about your situation with an avoidant partner. Answers are
grounded in a knowledge base distilled from 34 videos by
[Guided Awareness](https://www.youtube.com/@GuidedAwareness) (a practicing
therapist's channel on avoidant attachment) and cite the source videos.

**Your conversations live in your browser** (localStorage) — the server stores
nothing personal. Two answer engines, picked automatically:

| Engine | When | Cost |
|---|---|---|
| **Claude API** (`claude-opus-5`) | `ANTHROPIC_API_KEY` is set — use this for hosted deployments | Billed to your Anthropic API account; the knowledge base is prompt-cached, so typical questions cost a few cents |
| **`claude` CLI** | No API key set — local use | Uses your Claude Code subscription |

## Deploy to the web (Cloudflare Workers, free)

The repo ships a Worker entry (`worker.mjs` + `wrangler.jsonc`). One-time setup:

```bash
npx wrangler login          # opens the browser to authorize Cloudflare
npm install && npm run deploy
npx wrangler secret put ANTHROPIC_API_KEY   # paste your key from console.anthropic.com
npx wrangler secret put COMPASS_PASSWORD    # pick any password for the unlock screen
```

Your app is live at `https://avoidantguides.<your-subdomain>.workers.dev`.
No cold starts, and the free plan (100k requests/day) is far more than
personal use needs.

**Auto-deploy** is set up two ways:
- A git `pre-push` hook deploys on every `git push` from your machine
  (one-time enable per clone: `git config core.hooksPath .githooks`).
- A GitHub Actions workflow deploys from GitHub's side once you add a
  `CLOUDFLARE_API_TOKEN` repo secret (it skips quietly until then).

Manual deploys remain `npm run deploy`.

Alternative: in the Cloudflare dashboard, **Workers & Pages → Create →
Import a repository** → pick this repo (it reads `wrangler.jsonc`), then add
the two secrets under Settings → Variables and Secrets.

Also works on Render/Railway/Fly via the Node server (`render.yaml` included):
`npm install`, `node server.mjs`, same env vars.

## Run locally

```bash
node server.mjs
```

Open http://localhost:4877. With no API key set, answers come from your local
`claude` CLI (sign in once via `claude` in a terminal). No install needed for
local CLI mode; `npm install` is only required for the API engine.

Environment variables: `PORT` (default `4877`), `ANTHROPIC_API_KEY`,
`COMPASS_PASSWORD`, `COMPASS_MODEL` (default `claude-opus-5` with an API key,
`sonnet` for the CLI), `CLAUDE_BIN`.

## What's inside

- `server.mjs` — zero-framework Node server: static UI + streaming `/api/ask`
- `knowledge/` — the distilled knowledge base and the answering persona
- `public/` — vanilla HTML/JS/CSS front-end with client-side storage
- `content.json` — starter scenarios, suggested questions, topics, source videos

This is educational pattern-matching from one therapist's public teachings —
not therapy, not a diagnosis, and not a verdict on your specific partner.
