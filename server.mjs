// Attachment Compass — server. Serves the UI and streams answers grounded in
// the Guided Awareness knowledge base. Two answer engines:
//   1. Claude API  — when ANTHROPIC_API_KEY is set (hosted deployments).
//   2. claude CLI  — otherwise (local use with your Claude Code subscription).
// Conversations are stored in the BROWSER (localStorage) — this server keeps
// no personal data. Set COMPASS_PASSWORD to gate /api/ask on public hosts.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { imageNote, sanitizeImages, userContent } from "./lib/images.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 4877);
const API_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const PASSWORD = process.env.COMPASS_PASSWORD ?? "";
const MODEL = process.env.COMPASS_MODEL ?? (API_KEY ? "claude-opus-5" : "sonnet");

const SYSTEM_PROMPT = readFileSync(join(ROOT, "knowledge", "system-prompt.md"), "utf8");
const KNOWLEDGE = readFileSync(join(ROOT, "knowledge", "knowledge.md"), "utf8");
const CONTENT = readFileSync(join(ROOT, "content.json"), "utf8");
const FULL_SYSTEM = `${SYSTEM_PROMPT}\n\n## KNOWLEDGE BASE\n\n${KNOWLEDGE}`;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

// ── request helpers ──────────────────────────────────────────────────────────
function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

const TOO_LARGE = Symbol("too-large");

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    // Generous: base64 screenshots ride along in this body.
    if (size > 24_000_000) return TOO_LARGE;
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

const clean = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

function authorized(req) {
  if (!PASSWORD) return true;
  const header = req.headers.authorization ?? "";
  return header === `Bearer ${PASSWORD}`;
}

// ── prompt assembly ──────────────────────────────────────────────────────────
function buildConversation(situation, history, question, images) {
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

  return { situationBlock, history: history.slice(-24), question, images };
}

// ── engine 1: Claude API (hosted) ────────────────────────────────────────────
let anthropicClient = null;
async function getAnthropic() {
  if (anthropicClient) return anthropicClient;
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  anthropicClient = new Anthropic({ apiKey: API_KEY });
  return anthropicClient;
}

async function askViaApi(conversation, onDelta) {
  const client = await getAnthropic();
  const { situationBlock, history, question, images } = conversation;

  const text = `${situationBlock}\n\n## NEW QUESTION\n${question}${imageNote(images.length)}`;
  const messages = [
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: userContent(text, images) },
  ];

  // Knowledge base is a stable prefix — cache it so repeat questions bill the
  // big system block at ~10% of input price. Server-side refusal fallback is
  // enabled so a rare safety-classifier decline re-runs on the default
  // fallback model inside the same call instead of failing.
  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: [{ type: "text", text: FULL_SYSTEM, cache_control: { type: "ephemeral" } }],
    messages,
  });

  stream.on("text", (delta) => onDelta(delta));
  const final = await stream.finalMessage();

  if (final.stop_reason === "refusal") {
    const note =
      "\n\n_I couldn't answer that one. If it touches on safety, please reach out to a professional or local support line — that matters more than any pattern analysis._";
    onDelta(note);
    return { extra: note };
  }
  return { extra: "" };
}

// ── engine 2: local claude CLI ───────────────────────────────────────────────
function askViaCli(conversation, onDelta) {
  const { situationBlock, history, question, images } = conversation;
  if (images.length > 0) {
    // The CLI engine is a text pipe — screenshots need the API path.
    throw new Error(
      "Screenshots need the API engine. Set ANTHROPIC_API_KEY before starting the server, or ask without the image.",
    );
  }
  const past = history
    .map((m) => `${m.role === "user" ? "User" : "You (Compass)"}: ${m.content}`)
    .join("\n\n");
  const prompt = [
    situationBlock,
    past ? "\n## CONVERSATION SO FAR\n" + past : "",
    "\n## NEW QUESTION\n" + question,
    "\nAnswer the new question now, following your system instructions.",
  ].join("\n");

  return new Promise((resolve, reject) => {
    const child = spawn(
      process.env.CLAUDE_BIN ?? "claude",
      [
        "-p",
        "--model", MODEL,
        "--system-prompt", FULL_SYSTEM,
        "--output-format", "stream-json",
        "--include-partial-messages",
        "--verbose",
        "--no-session-persistence",
        "--disallowedTools", "Bash", "Edit", "Write", "Read", "Glob", "Grep", "WebSearch", "WebFetch", "Task", "NotebookEdit",
      ],
      { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] },
    );

    let streamed = "";
    let finalResult = null;
    let errorDetail = "";
    let stderr = "";
    let buffer = "";

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
        if (line === "") continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event.type === "stream_event") {
          const delta = event.event?.delta;
          if (delta?.type === "text_delta" && typeof delta.text === "string") {
            streamed += delta.text;
            onDelta(delta.text);
          }
        } else if (event.type === "result") {
          if (event.is_error) {
            if (typeof event.result === "string") errorDetail = event.result;
          } else if (typeof event.result === "string") {
            finalResult = event.result;
          }
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      const answer = streamed.trim() !== "" ? streamed : (finalResult ?? "");
      if (answer.trim() !== "") {
        if (streamed.trim() === "") onDelta(answer);
        return resolve({ extra: "" });
      }
      const detail = (errorDetail || stderr || "").trim().slice(0, 400);
      reject(new Error(detail || `claude exited with code ${code} and no output`));
    });

    child.stdin.end(prompt);
  });
}

// ── routes ───────────────────────────────────────────────────────────────────
async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/content") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    return res.end(CONTENT);
  }

  if (req.method === "GET" && url.pathname === "/api/config") {
    return sendJson(res, 200, {
      locked: PASSWORD !== "",
      engine: API_KEY ? "api" : "cli",
      model: MODEL,
    });
  }

  if (req.method === "POST" && url.pathname === "/api/ask") {
    if (!authorized(req)) {
      return sendJson(res, 401, {
        error: PASSWORD
          ? "This Compass is private. Enter the access password to continue."
          : "Unauthorized.",
      });
    }
    const body = await readBody(req);
    if (body === TOO_LARGE) {
      return sendJson(res, 413, { error: "Those images are too large — try fewer, or smaller ones." });
    }
    const images = sanitizeImages(body?.images);
    const question = clean(body?.question, 4000) || (images.length > 0 ? "What do you make of this?" : "");
    if (!question) return sendJson(res, 400, { error: "Write a question first." });

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

    const conversation = buildConversation(situation, history, question, images);

    res.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    });

    try {
      const engine = API_KEY ? askViaApi : askViaCli;
      await engine(conversation, (delta) => res.write(delta));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      let advice = "Something went wrong reaching Claude — try again in a moment.";
      if (/Screenshots need the API engine/.test(message)) {
        advice = "This local server is running on the Claude CLI, which can't read images.";
      } else if (!API_KEY && /authenticat|oauth|expired|401/i.test(message)) {
        advice =
          "Your Claude CLI login has expired — open a terminal, run `claude`, and sign in again. Then ask again here.";
      } else if (/credit|billing|quota/i.test(message)) {
        advice = "Your Anthropic API credits look exhausted — top up at console.anthropic.com.";
      } else if (/rate.?limit|limit/i.test(message)) {
        advice = "Rate limit or usage limit hit — wait a bit and try again.";
      }
      res.write(`**I couldn't reach Claude just now.** ${advice}\n\n_(Technical detail: ${message.slice(0, 300)})_`);
    }
    return res.end();
  }

  return sendJson(res, 404, { error: "Not found" });
}

function serveStatic(res, pathname) {
  const rel = pathname === "/" ? "/index.html" : pathname;
  const filePath = normalize(join(ROOT, "public", rel));
  if (!filePath.startsWith(join(ROOT, "public")) || !existsSync(filePath)) {
    res.writeHead(404, { "content-type": "text/plain" });
    return res.end("Not found");
  }
  res.writeHead(200, { "content-type": MIME[extname(filePath)] ?? "application/octet-stream" });
  res.end(readFileSync(filePath));
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  if (url.pathname.startsWith("/api/")) {
    handleApi(req, res, url).catch((error) => {
      console.error("[api]", error);
      if (!res.headersSent) sendJson(res, 500, { error: "Something went wrong." });
      else res.end();
    });
    return;
  }
  serveStatic(res, url.pathname);
});

server.listen(PORT, () => {
  console.log(
    `Attachment Compass on http://localhost:${PORT} — engine: ${API_KEY ? "Claude API" : "claude CLI"}, model: ${MODEL}${PASSWORD ? ", password-protected" : ""}`,
  );
});
