// Attachment Compass — local server. Zero dependencies: static UI + JSON-file
// persistence + answers streamed from the local `claude` CLI (your existing
// Claude Code subscription; nothing leaves your machine except the Claude call).
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 4877);
const MODEL = process.env.COMPASS_MODEL ?? "sonnet";
const DATA_PATH = join(ROOT, "data", "compass.json");

const SYSTEM_PROMPT = readFileSync(join(ROOT, "knowledge", "system-prompt.md"), "utf8");
const KNOWLEDGE = readFileSync(join(ROOT, "knowledge", "knowledge.md"), "utf8");
const CONTENT = readFileSync(join(ROOT, "content.json"), "utf8");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

// ── persistence ──────────────────────────────────────────────────────────────
function loadData() {
  try {
    return JSON.parse(readFileSync(DATA_PATH, "utf8"));
  } catch {
    return { situations: [], messages: [] };
  }
}

function saveData(data) {
  mkdirSync(dirname(DATA_PATH), { recursive: true });
  const tmp = `${DATA_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 1));
  renameSync(tmp, DATA_PATH);
}

let db = loadData();

function situationSummaries() {
  return db.situations
    .map((s) => ({
      ...s,
      messageCount: db.messages.filter((m) => m.situationId === s.id).length,
    }))
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}

function touchSituation(id) {
  const s = db.situations.find((s) => s.id === id);
  if (s) s.updatedAt = new Date().toISOString();
}

// ── request helpers ──────────────────────────────────────────────────────────
function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

const clean = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

// ── the ask pipeline ─────────────────────────────────────────────────────────
function buildPrompt(situation, history, question) {
  const profile = [
    `Name they gave this situation: ${situation.name}`,
    situation.stage ? `Relationship stage: ${situation.stage}` : null,
    situation.partnerStyle ? `Partner's likely attachment style: ${situation.partnerStyle}` : null,
    situation.profile ? `Their description of the situation:\n${situation.profile}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const past = history
    .slice(-24)
    .map((m) => `${m.role === "user" ? "User" : "You (Compass)"}: ${m.content}`)
    .join("\n\n");

  return [
    "## THE USER'S SAVED SITUATION",
    profile || "(No situation profile yet — gently invite them to add context when it would sharpen the answer.)",
    past ? "\n## CONVERSATION SO FAR\n" + past : "",
    "\n## NEW QUESTION\n" + question,
    "\nAnswer the new question now, following your system instructions.",
  ].join("\n");
}

function askClaude(prompt, onDelta) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.env.CLAUDE_BIN ?? "claude",
      [
        "-p",
        "--model", MODEL,
        "--system-prompt", `${SYSTEM_PROMPT}\n\n## KNOWLEDGE BASE\n\n${KNOWLEDGE}`,
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
      if (answer.trim() !== "") return resolve(answer);
      const detail = (errorDetail || stderr || "").trim().slice(0, 400);
      reject(new Error(detail || `claude exited with code ${code} and no output`));
    });

    child.stdin.end(prompt);
  });
}

// ── routes ───────────────────────────────────────────────────────────────────
async function handleApi(req, res, url) {
  const parts = url.pathname.split("/").filter(Boolean); // ["api", ...]

  if (req.method === "GET" && url.pathname === "/api/state") {
    return sendJson(res, 200, { situations: situationSummaries(), model: MODEL });
  }

  if (req.method === "GET" && url.pathname === "/api/content") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    return res.end(CONTENT);
  }

  if (req.method === "POST" && url.pathname === "/api/situations") {
    const body = await readBody(req);
    const name = clean(body?.name, 80);
    if (!name) return sendJson(res, 400, { error: "Give the situation a name." });
    const now = new Date().toISOString();
    const situation = {
      id: randomUUID(),
      name,
      profile: clean(body?.profile, 4000),
      partnerStyle: clean(body?.partnerStyle, 40),
      stage: clean(body?.stage, 60),
      createdAt: now,
      updatedAt: now,
    };
    db.situations.push(situation);
    saveData(db);
    return sendJson(res, 200, situation);
  }

  if (parts[1] === "situations" && parts[2] != null) {
    const situation = db.situations.find((s) => s.id === parts[2]);
    if (!situation) return sendJson(res, 404, { error: "That situation no longer exists." });
    if (req.method === "PATCH") {
      const body = await readBody(req);
      if (body?.name != null) situation.name = clean(body.name, 80) || situation.name;
      if (body?.profile != null) situation.profile = clean(body.profile, 4000);
      if (body?.partnerStyle != null) situation.partnerStyle = clean(body.partnerStyle, 40);
      if (body?.stage != null) situation.stage = clean(body.stage, 60);
      situation.updatedAt = new Date().toISOString();
      saveData(db);
      return sendJson(res, 200, situation);
    }
    if (req.method === "DELETE") {
      db.situations = db.situations.filter((s) => s.id !== situation.id);
      db.messages = db.messages.filter((m) => m.situationId !== situation.id);
      saveData(db);
      return sendJson(res, 200, { id: situation.id });
    }
  }

  if (req.method === "GET" && parts[1] === "messages" && parts[2] != null) {
    const messages = db.messages
      .filter((m) => m.situationId === parts[2])
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return sendJson(res, 200, messages);
  }

  if (req.method === "POST" && url.pathname === "/api/ask") {
    const body = await readBody(req);
    const question = clean(body?.question, 4000);
    const situation = db.situations.find((s) => s.id === body?.situationId);
    if (!situation) return sendJson(res, 404, { error: "That situation no longer exists." });
    if (!question) return sendJson(res, 400, { error: "Write a question first." });

    const history = db.messages
      .filter((m) => m.situationId === situation.id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    // Persist the question up front so it survives interruptions.
    db.messages.push({
      id: randomUUID(),
      situationId: situation.id,
      role: "user",
      content: question,
      createdAt: new Date().toISOString(),
    });
    touchSituation(situation.id);
    saveData(db);

    res.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    });

    let answer = "";
    try {
      answer = await askClaude(buildPrompt(situation, history, question), (delta) => {
        res.write(delta);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      let advice = "Make sure the `claude` CLI works in your terminal, then ask again.";
      if (/authenticat|oauth|expired|401/i.test(message)) {
        advice = "Your Claude CLI login has expired — open a terminal, run `claude`, and sign in again (or `claude /login`). Then ask again here.";
      } else if (/limit/i.test(message)) {
        advice = "It looks like your Claude session limit is used up — try again after it resets.";
      }
      answer = `**I couldn't reach Claude just now.** ${advice}\n\n_(Technical detail: ${message})_`;
      res.write(answer);
    }

    db.messages.push({
      id: randomUUID(),
      situationId: situation.id,
      role: "assistant",
      content: answer,
      createdAt: new Date().toISOString(),
    });
    touchSituation(situation.id);
    saveData(db);
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
  console.log(`Attachment Compass running at http://localhost:${PORT} (model: ${MODEL})`);
});
