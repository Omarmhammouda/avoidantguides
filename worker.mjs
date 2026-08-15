// Attachment Compass — Cloudflare Worker entry. Serves the UI from static
// assets and streams answers via the Claude API. Conversations live in the
// visitor's browser (localStorage); this Worker stores nothing personal.
//
// Secrets (set in the Cloudflare dashboard or `wrangler secret put`):
//   ANTHROPIC_API_KEY — required; powers answers
//   COMPASS_PASSWORD  — recommended; gates /api/ask behind an unlock screen
import Anthropic from "@anthropic-ai/sdk";
import { imageNote, sanitizeImages, userContent } from "./lib/images.mjs";
import SYSTEM_PROMPT from "./knowledge/system-prompt.md";
import KNOWLEDGE from "./knowledge/knowledge.md";
import CONTENT from "./content.json";

const FULL_SYSTEM = `${SYSTEM_PROMPT}\n\n## KNOWLEDGE BASE\n\n${KNOWLEDGE}`;
const CONTENT_JSON = JSON.stringify(CONTENT);

const clean = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

function buildMessages(situation, history, question, images) {
  const profile = [
    `Name they gave this situation: ${situation.name}`,
    situation.stage ? `Relationship stage: ${situation.stage}` : null,
    situation.partnerStyle ? `Partner's likely attachment style: ${situation.partnerStyle}` : null,
    situation.profile ? `Their description of the situation:\n${situation.profile}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const situationBlock = [
    "## THE USER'S SAVED SITUATION",
    profile ||
      "(No situation profile yet — gently invite them to add context when it would sharpen the answer.)",
  ].join("\n");

  const text = `${situationBlock}\n\n## NEW QUESTION\n${question}${imageNote(images.length)}`;
  return [
    ...history.slice(-24).map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: userContent(text, images) },
  ];
}

async function handleAsk(request, env, ctx) {
  const password = env.COMPASS_PASSWORD ?? "";
  if (password && request.headers.get("authorization") !== `Bearer ${password}`) {
    return json(401, { error: "This Compass is private. Enter the access password to continue." });
  }
  if (!env.ANTHROPIC_API_KEY) {
    return json(500, {
      error: "The server is missing its ANTHROPIC_API_KEY secret — set it in the Cloudflare dashboard.",
    });
  }

  let body = null;
  try {
    body = await request.json();
  } catch {}
  const images = sanitizeImages(body?.images);
  const question = clean(body?.question, 4000) || (images.length > 0 ? "What do you make of this?" : "");
  if (!question) return json(400, { error: "Write a question first." });

  const situation = {
    name: clean(body?.situation?.name, 80) || "My situation",
    profile: clean(body?.situation?.profile, 4000),
    partnerStyle: clean(body?.situation?.partnerStyle, 40),
    stage: clean(body?.situation?.stage, 60),
  };
  const history = Array.isArray(body?.history)
    ? body.history
        .slice(-40)
        .map((m) => ({
          role: m?.role === "assistant" ? "assistant" : "user",
          content: clean(m?.content, 8000),
        }))
        .filter((m) => m.content !== "")
    : [];

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const model = env.COMPASS_MODEL ?? "claude-opus-5";

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  ctx.waitUntil(
    (async () => {
      try {
        // Knowledge base is a stable prefix — cache it so repeat questions
        // bill the big system block at ~10% of input price. Server-side
        // refusal fallback re-runs a rare safety decline on the default
        // fallback model inside the same call.
        const stream = client.beta.messages.stream({
          model,
          max_tokens: 16000,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          system: [{ type: "text", text: FULL_SYSTEM, cache_control: { type: "ephemeral" } }],
          messages: buildMessages(situation, history, question, images),
        });

        for await (const event of stream) {
          if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
            await writer.write(encoder.encode(event.delta.text));
          }
        }
        const final = await stream.finalMessage();
        if (final.stop_reason === "refusal") {
          await writer.write(
            encoder.encode(
              "\n\n_I couldn't answer that one. If it touches on safety, please reach out to a professional or local support line — that matters more than any pattern analysis._",
            ),
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        let advice = "Something went wrong reaching Claude — try again in a moment.";
        if (/credit|billing|quota/i.test(message)) {
          advice = "The Anthropic API credits look exhausted — top up at console.anthropic.com.";
        } else if (/authenticat|invalid.*key|401/i.test(message)) {
          advice = "The ANTHROPIC_API_KEY secret looks invalid — update it in the Cloudflare dashboard.";
        } else if (/rate.?limit|429|overloaded|529/i.test(message)) {
          advice = "Rate limit hit or the API is briefly overloaded — wait a bit and try again.";
        }
        await writer
          .write(
            encoder.encode(
              `**I couldn't reach Claude just now.** ${advice}\n\n_(Technical detail: ${message.slice(0, 300)})_`,
            ),
          )
          .catch(() => {});
      } finally {
        await writer.close().catch(() => {});
      }
    })(),
  );

  return new Response(readable, {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/content" && request.method === "GET") {
      return new Response(CONTENT_JSON, {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
    if (url.pathname === "/api/config" && request.method === "GET") {
      return json(200, {
        locked: Boolean(env.COMPASS_PASSWORD),
        engine: "api",
        model: env.COMPASS_MODEL ?? "claude-opus-5",
      });
    }
    if (url.pathname === "/api/ask" && request.method === "POST") {
      return handleAsk(request, env, ctx);
    }
    if (url.pathname.startsWith("/api/")) {
      return json(404, { error: "Not found" });
    }

    return env.ASSETS.fetch(request);
  },
};
