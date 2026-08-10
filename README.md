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

## Deploy to the web (Render, free)

1. Create an [Anthropic API key](https://console.anthropic.com/settings/keys)
   (add a few dollars of credit).
2. Sign in at [render.com](https://render.com) with GitHub → **New + → Blueprint**
   → pick this repository. Render reads `render.yaml` automatically.
3. When prompted, set:
   - `ANTHROPIC_API_KEY` — your key from step 1
   - `COMPASS_PASSWORD` — any password; the app asks for it once per browser
     so strangers can't spend your credits
4. Deploy. Your app is live at `https://<name>.onrender.com`.

The same setup works on Railway, Fly.io, or any Node host: `npm install`,
`node server.mjs`, and the three env vars above.

> Free-tier note: Render spins the service down after idle periods — the first
> question after a pause takes ~30s while it wakes. Conversations are safe
> either way (they're in your browser, not on the server).

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
