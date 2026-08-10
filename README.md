# Attachment Compass (local)

A personal Q&A app about your situation with an avoidant partner. Answers are
grounded in a knowledge base distilled from 34 videos by
[Guided Awareness](https://www.youtube.com/@GuidedAwareness) (a practicing
therapist's channel on avoidant attachment) and cite the source videos.

Everything runs on your machine:

- **UI + data**: this folder. Your situations and conversations live in
  `data/compass.json` — plain JSON, delete it to start fresh.
- **Answers**: streamed from your local `claude` CLI (your existing Claude
  Code subscription). No API keys, no third-party backend.
- **Knowledge**: `knowledge/knowledge.md` (the distilled channel material) +
  `knowledge/system-prompt.md` (the answering persona and safety rules).

## Run

```bash
node server.mjs
```

Then open http://localhost:4877.

Options via environment variables:

- `PORT` — port to listen on (default `4877`)
- `COMPASS_MODEL` — Claude model alias passed to the CLI (default `sonnet`)
- `CLAUDE_BIN` — path to the claude binary if it's not on PATH

This is educational pattern-matching from one therapist's public teachings —
not therapy, not a diagnosis, and not a verdict on your specific partner.
