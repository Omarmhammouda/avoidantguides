/* Attachment Compass — front-end. Conversations live entirely in THIS browser
   (localStorage); the server only answers questions. Model text is always
   rendered through the safe DOM-building markdown renderer below. */
"use strict";

const $ = (id) => document.getElementById(id);

const state = {
  view: "home",              // "home" | "library" | situationId
  situations: [],            // summaries (computed from store)
  content: null,
  messages: [],              // for the open thread
  asking: null,              // { situationId, question, answer }
  editingId: null,
  pendingAsk: null,
  locked: false,
};

/* ── local store ──────────────────────────────────────────── */
const STORE_KEY = "attachment-compass-v1";
const AUTH_KEY = "attachment-compass-auth";

function loadStore() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) ?? "");
    if (raw && Array.isArray(raw.situations) && typeof raw.messages === "object") return raw;
  } catch {}
  return { situations: [], messages: {} };
}

function saveStore(store) {
  localStorage.setItem(STORE_KEY, JSON.stringify(store));
}

function refreshState() {
  const store = loadStore();
  state.situations = store.situations
    .map((s) => ({ ...s, messageCount: (store.messages[s.id] ?? []).length }))
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  renderSidebar();
  renderTargetPicker();
}

function situationById(id) {
  return state.situations.find((s) => s.id === id);
}

const newId = () =>
  (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));

/* ── markdown (safe DOM building) ─────────────────────────── */
function resolveHref(href) {
  const yt = /^yt:([\w-]{6,})$/.exec(href);
  if (yt) return `https://www.youtube.com/watch?v=${yt[1]}`;
  if (/^https?:\/\//i.test(href)) return href;
  return null;
}

function inlineNodes(text) {
  const nodes = [];
  const parts = text.split(/(\[[^\]]+\]\([^\s)]+\))/g);
  for (const part of parts) {
    const link = /^\[([^\]]+)\]\(([^\s)]+)\)$/.exec(part);
    if (link) {
      const href = resolveHref(link[2]);
      if (href) {
        const a = document.createElement("a");
        a.href = href;
        a.target = "_blank";
        a.rel = "noreferrer noopener";
        emphasisNodes(link[1]).forEach((n) => a.appendChild(n));
        nodes.push(a);
        continue;
      }
      emphasisNodes(link[1]).forEach((n) => nodes.push(n));
      continue;
    }
    emphasisNodes(part).forEach((n) => nodes.push(n));
  }
  return nodes;
}

function emphasisNodes(text) {
  const nodes = [];
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g);
  for (const part of parts) {
    if (part === "") continue;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      const el = document.createElement("strong");
      el.textContent = part.slice(2, -2);
      nodes.push(el);
    } else if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      const el = document.createElement("code");
      el.textContent = part.slice(1, -1);
      nodes.push(el);
    } else if (part.startsWith("*") && part.endsWith("*") && part.length > 2) {
      const el = document.createElement("em");
      el.textContent = part.slice(1, -1);
      nodes.push(el);
    } else {
      nodes.push(document.createTextNode(part));
    }
  }
  return nodes;
}

function renderMarkdown(text) {
  const root = document.createDocumentFragment();
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  let paragraph = [];
  let list = null;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const p = document.createElement("p");
    inlineNodes(paragraph.join(" ")).forEach((n) => p.appendChild(n));
    root.appendChild(p);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    const el = document.createElement(list.ordered ? "ol" : "ul");
    for (const item of list.items) {
      const li = document.createElement("li");
      inlineNodes(item).forEach((n) => li.appendChild(n));
      el.appendChild(li);
    }
    root.appendChild(el);
    list = null;
  };

  let listGap = false; // blank line seen while a list is open — the list may continue
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === "") {
      flushParagraph();
      if (list) listGap = true; // keep the list open until we see what follows
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph(); flushList(); listGap = false;
      const h = document.createElement("p");
      h.className = "md-h";
      inlineNodes(heading[2]).forEach((n) => h.appendChild(n));
      root.appendChild(h);
      continue;
    }
    const ordered = /^\d+[.)]\s+(.*)$/.exec(line);
    const unordered = /^[-*•]\s+(.*)$/.exec(line);
    if (ordered || unordered) {
      flushParagraph();
      const isOrdered = ordered != null;
      // Continue a same-type list across blank lines so numbering doesn't reset.
      if (!list || list.ordered !== isOrdered) { flushList(); list = { ordered: isOrdered, items: [] }; }
      listGap = false;
      list.items.push((ordered ? ordered[1] : unordered[1]) ?? "");
      continue;
    }
    if (list && !listGap && list.items.length > 0) {
      list.items[list.items.length - 1] += " " + line;
      continue;
    }
    if (listGap) { flushList(); listGap = false; }
    paragraph.push(line);
  }
  flushParagraph(); flushList();
  return root;
}

function extractSources(text) {
  const out = new Map();
  const pattern = /\[([^\]]+)\]\(yt:([\w-]{6,})\)/g;
  let m;
  while ((m = pattern.exec(text)) != null) if (!out.has(m[2])) out.set(m[2], m[1]);
  return [...out.entries()].map(([id, title]) => ({ id, title }));
}

/* ── api ──────────────────────────────────────────────────── */
async function api(path) {
  const res = await fetch(path);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error ?? "Something went wrong.");
  return body;
}

function authHeaders() {
  const token = localStorage.getItem(AUTH_KEY);
  return token ? { authorization: `Bearer ${token}` } : {};
}

/* ── ask flow ─────────────────────────────────────────────── */
async function ask(situationId, question) {
  const q = question.trim();
  const situation = situationById(situationId);
  if (!q || !situation || state.asking) return;
  state.asking = { situationId, question: q, answer: "" };
  $("home-question").value = "";
  $("thread-question").value = "";
  const store = loadStore();
  const history = (store.messages[situationId] ?? []).map((m) => ({
    role: m.role,
    content: m.content,
  }));
  if (state.view !== situationId) openThread(situationId);
  else render();
  scrollThread(true);

  try {
    const res = await fetch("/api/ask", {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        question: q,
        situation: {
          name: situation.name,
          profile: situation.profile,
          partnerStyle: situation.partnerStyle,
          stage: situation.stage,
        },
        history,
      }),
    });
    if (res.status === 401) {
      state.asking = null;
      $("home-question").value = q;
      $("thread-question").value = q;
      showLock();
      render();
      return;
    }
    if (!res.ok || (res.headers.get("content-type") ?? "").includes("application/json")) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.error ?? "The question could not be answered.");
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (state.asking) {
        state.asking.answer += decoder.decode(value, { stream: true });
        renderLiveAnswer();
        scrollThread(true);
      }
    }
    persistExchange(situationId, q, state.asking?.answer ?? "");
  } catch (error) {
    persistExchange(
      situationId,
      q,
      (state.asking?.answer ? state.asking.answer + "\n\n" : "") +
        `**Something went wrong:** ${error.message}`,
    );
  } finally {
    state.asking = null;
    refreshState();
    if (state.view === situationId) {
      state.messages = loadStore().messages[situationId] ?? [];
      render();
    }
    scrollThread(false);
  }
}

function persistExchange(situationId, question, answer) {
  const store = loadStore();
  if (!store.situations.some((s) => s.id === situationId)) return;
  const now = new Date().toISOString();
  const thread = store.messages[situationId] ?? (store.messages[situationId] = []);
  thread.push({ id: newId(), role: "user", content: question, createdAt: now });
  thread.push({
    id: newId(),
    role: "assistant",
    content: answer.trim() || "_No answer arrived — please try again._",
    createdAt: now,
  });
  const situation = store.situations.find((s) => s.id === situationId);
  if (situation) situation.updatedAt = now;
  saveStore(store);
}

/* ── lock screen ──────────────────────────────────────────── */
function showLock() {
  state.locked = true;
  $("lock").classList.remove("hidden");
  $("lock-input").focus();
}

function hideLock() {
  state.locked = false;
  $("lock").classList.add("hidden");
}

/* ── rendering ────────────────────────────────────────────── */
function setActiveNav() {
  $("nav-home").classList.toggle("active", state.view === "home");
  $("nav-library").classList.toggle("active", state.view === "library");
  document.querySelectorAll(".situation-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.id === state.view);
  });
}

function renderSidebar() {
  const list = $("situation-list");
  list.textContent = "";
  if (state.situations.length === 0) {
    const btn = document.createElement("button");
    btn.className = "situation-empty";
    btn.textContent = "+ Add your situation";
    btn.onclick = () => openModal(null);
    list.appendChild(btn);
  } else {
    for (const s of state.situations) {
      const item = document.createElement("button");
      item.className = "situation-item";
      item.dataset.id = s.id;
      const avatar = document.createElement("span");
      avatar.className = "situation-avatar";
      avatar.textContent = (s.name[0] ?? "?").toUpperCase();
      const name = document.createElement("span");
      name.className = "s-name";
      name.textContent = s.name;
      const count = document.createElement("span");
      count.className = "s-count";
      count.textContent = String(Math.floor(s.messageCount / 2));
      item.append(avatar, name, count);
      item.onclick = () => openThread(s.id);
      list.appendChild(item);
    }
  }
  setActiveNav();
}

function renderTargetPicker() {
  const select = $("home-target");
  select.textContent = "";
  for (const s of state.situations) {
    const opt = document.createElement("option");
    opt.value = s.id;
    opt.textContent = s.name;
    select.appendChild(opt);
  }
  const newOpt = document.createElement("option");
  newOpt.value = "__new__";
  newOpt.textContent = state.situations.length === 0 ? "New situation…" : "+ New situation…";
  select.appendChild(newOpt);
}

function renderContent() {
  const c = state.content;
  if (!c) return;
  const chips = $("suggested");
  chips.textContent = "";
  for (const q of c.suggested_questions) {
    const chip = document.createElement("button");
    chip.className = "chip";
    chip.textContent = q;
    chip.onclick = () => { $("home-question").value = q; $("home-question").focus(); };
    chips.appendChild(chip);
  }
  const grid = $("scenarios");
  grid.textContent = "";
  for (const s of c.scenarios) {
    const card = document.createElement("button");
    card.className = "scenario-card";
    const strip = document.createElement("div");
    strip.className = "scenario-strip";
    for (const src of s.images) {
      const img = document.createElement("img");
      img.src = src; img.alt = ""; img.loading = "lazy";
      strip.appendChild(img);
    }
    const body = document.createElement("div");
    body.className = "scenario-body";
    const h = document.createElement("h3"); h.textContent = s.title;
    const p = document.createElement("p"); p.textContent = s.subtitle;
    const t = document.createElement("span"); t.className = "try"; t.textContent = "Ask about this →";
    body.append(h, p, t);
    card.append(strip, body);
    card.onclick = () => { $("home-question").value = s.question; $("home-question").focus(); window.scrollTo(0, 0); };
    grid.appendChild(card);
  }
  const topics = $("topics");
  topics.textContent = "";
  for (const t of c.topics) {
    const card = document.createElement("button");
    card.className = "topic-card";
    const h = document.createElement("h3"); h.textContent = t.label;
    const p = document.createElement("p"); p.textContent = t.description;
    card.append(h, p);
    card.onclick = () => {
      $("home-question").value = `${t.label}: ${t.description} What should I know, given my situation?`;
      showView("home");
      $("home-question").focus();
    };
    topics.appendChild(card);
  }
  const videos = $("videos");
  videos.textContent = "";
  // Group the catalog by source channel so each block is attributable.
  const byChannel = new Map();
  for (const v of c.videos) {
    const key = v.channel ?? "Guided Awareness";
    if (!byChannel.has(key)) byChannel.set(key, []);
    byChannel.get(key).push(v);
  }
  for (const [channel, list] of byChannel) {
    const head = document.createElement("div");
    head.className = "channel-head";
    const name = document.createElement("span");
    name.className = "channel-name";
    name.textContent = channel;
    const count = document.createElement("span");
    count.className = "channel-count";
    count.textContent = `${list.length} videos`;
    head.append(name, count);
    videos.appendChild(head);

    const group = document.createElement("div");
    group.className = "video-list";
    for (const v of list) {
      const row = document.createElement("a");
      row.className = "video-row";
      row.href = `https://www.youtube.com/watch?v=${v.id}`;
      row.target = "_blank";
      row.rel = "noreferrer noopener";
      const title = document.createElement("span"); title.className = "v-title"; title.textContent = v.title;
      const views = document.createElement("span"); views.className = "v-views"; views.textContent = v.views || "↗";
      row.append(title, views);
      group.appendChild(row);
    }
    videos.appendChild(group);
  }
}

function assistantCard(content, streaming) {
  const wrap = document.createElement("div");
  wrap.className = "msg-assistant";
  const card = document.createElement("div");
  card.className = "card";
  card.appendChild(renderMarkdown(content));
  if (streaming) {
    const w = document.createElement("div");
    w.className = "writing";
    const dot = document.createElement("span"); dot.className = "dot";
    const label = document.createElement("span");
    label.textContent = content ? "Writing…" : "Reading your situation…";
    w.append(dot, label);
    card.appendChild(w);
  } else {
    const sources = extractSources(content);
    if (sources.length > 0) {
      const row = document.createElement("div");
      row.className = "sources";
      for (const s of sources) {
        const a = document.createElement("a");
        a.className = "source-chip";
        a.href = `https://www.youtube.com/watch?v=${s.id}`;
        a.target = "_blank"; a.rel = "noreferrer noopener";
        const label = document.createElement("span"); label.textContent = s.title;
        a.append(label, document.createTextNode("↗"));
        row.appendChild(a);
      }
      card.appendChild(row);
    }
    const copy = document.createElement("button");
    copy.className = "copy-btn";
    copy.textContent = "copy";
    copy.onclick = () => {
      navigator.clipboard.writeText(content).then(() => {
        copy.textContent = "copied";
        setTimeout(() => (copy.textContent = "copy"), 1400);
      }).catch(() => {});
    };
    wrap.appendChild(copy);
  }
  wrap.appendChild(card);
  return wrap;
}

function openThread(id) {
  state.view = id;
  state.messages = loadStore().messages[id] ?? [];
  render();
  scrollThread(false);
}

function renderThread() {
  const situation = situationById(state.view);
  if (!situation) { showView("home"); return; }
  $("thread-name").textContent = situation.name;
  $("thread-meta").textContent = [situation.stage, situation.partnerStyle].filter(Boolean).join(" · ");
  $("thread-note").textContent = "Grounded in Guided Awareness · not therapy";

  const thread = $("thread");
  thread.textContent = "";
  const showAsking = state.asking && state.asking.situationId === state.view;
  const isEmpty = state.messages.length === 0 && !showAsking;
  $("thread-empty").classList.toggle("hidden", !isEmpty);
  $("thread-empty-sub").textContent = situation.profile
    ? "Your situation is saved — every answer will use it. Ask what's on your mind below."
    : "Add your story with Edit details, then ask what's on your mind below.";

  for (const m of state.messages) {
    if (m.role === "user") {
      const wrap = document.createElement("div");
      wrap.className = "msg-user";
      const bubble = document.createElement("div");
      bubble.className = "bubble";
      bubble.textContent = m.content;
      wrap.appendChild(bubble);
      thread.appendChild(wrap);
    } else {
      thread.appendChild(assistantCard(m.content, false));
    }
  }
  if (showAsking) {
    const wrap = document.createElement("div");
    wrap.className = "msg-user";
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = state.asking.question;
    wrap.appendChild(bubble);
    thread.appendChild(wrap);
    const live = assistantCard(state.asking.answer, true);
    live.id = "live-answer";
    thread.appendChild(live);
  }
}

function renderLiveAnswer() {
  const live = $("live-answer");
  if (!live || !state.asking) return;
  const fresh = assistantCard(state.asking.answer, true);
  fresh.id = "live-answer";
  live.replaceWith(fresh);
}

function scrollThread(smooth) {
  requestAnimationFrame(() => {
    const el = $("thread-scroll");
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  });
}

function showView(view) {
  state.view = view;
  render();
}

function render() {
  const isThread = state.view !== "home" && state.view !== "library";
  $("view-home").classList.toggle("hidden", state.view !== "home");
  $("view-library").classList.toggle("hidden", state.view !== "library");
  $("view-thread").classList.toggle("hidden", !isThread);
  if (isThread) renderThread();
  const askingNow = state.asking != null;
  $("home-ask").disabled = askingNow;
  $("thread-ask").disabled = askingNow;
  $("home-ask").textContent = askingNow ? "Answering…" : "Ask ✦";
  $("thread-ask").textContent = askingNow ? "Answering…" : "Ask ✦";
  setActiveNav();
}

/* ── modal ────────────────────────────────────────────────── */
function openModal(situationId) {
  state.editingId = situationId;
  const s = situationById(situationId);
  $("modal-title").textContent = s ? "Edit situation" : "New situation";
  $("modal-save").textContent = s ? "Save changes" : "Create situation";
  $("f-name").value = s?.name ?? "";
  $("f-stage").value = s?.stage ?? "";
  $("f-style").value = s?.partnerStyle ?? "";
  $("f-profile").value = s?.profile ?? "";
  $("form-error").classList.add("hidden");
  $("modal").classList.remove("hidden");
  $("f-name").focus();
}

function closeModal() {
  $("modal").classList.add("hidden");
  state.editingId = null;
  state.pendingAsk = null;
}

function saveModal(event) {
  event.preventDefault();
  const name = $("f-name").value.trim().slice(0, 80);
  if (!name) return;
  const payload = {
    name,
    stage: $("f-stage").value,
    partnerStyle: $("f-style").value,
    profile: $("f-profile").value.trim().slice(0, 4000),
  };
  const store = loadStore();
  let situation;
  const now = new Date().toISOString();
  if (state.editingId) {
    situation = store.situations.find((s) => s.id === state.editingId);
    if (situation) Object.assign(situation, payload, { updatedAt: now });
  } else {
    situation = { id: newId(), ...payload, createdAt: now, updatedAt: now };
    store.situations.push(situation);
    store.messages[situation.id] = [];
  }
  saveStore(store);
  const pending = state.pendingAsk;
  state.pendingAsk = null;
  $("modal").classList.add("hidden");
  state.editingId = null;
  refreshState();
  if (pending && situation) ask(situation.id, pending);
  else if (situation && state.view === situation.id) { state.messages = loadStore().messages[situation.id] ?? []; render(); }
  else if (situation) openThread(situation.id);
}

/* ── wiring ───────────────────────────────────────────────── */
function submitFromHome() {
  const q = $("home-question").value.trim();
  if (!q) return;
  const target = $("home-target").value;
  if (target === "__new__" || !target) {
    state.pendingAsk = q;
    openModal(null);
    return;
  }
  ask(target, q);
}

function init() {
  $("nav-home").onclick = () => showView("home");
  $("nav-library").onclick = () => showView("library");
  $("new-situation").onclick = () => openModal(null);
  $("home-ask").onclick = submitFromHome;
  $("home-question").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitFromHome(); }
  });
  $("thread-ask").onclick = () => ask(state.view, $("thread-question").value);
  $("thread-question").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(state.view, e.target.value); }
  });
  $("home-target").addEventListener("change", (e) => {
    if (e.target.value === "__new__") openModal(null);
  });
  $("edit-situation").onclick = () => openModal(state.view);
  $("delete-situation").onclick = () => {
    const s = situationById(state.view);
    if (!s) return;
    if (!confirm(`Delete "${s.name}" and its whole conversation?`)) return;
    const store = loadStore();
    store.situations = store.situations.filter((x) => x.id !== s.id);
    delete store.messages[s.id];
    saveStore(store);
    refreshState();
    showView("home");
  };
  $("modal-close").onclick = closeModal;
  $("modal").addEventListener("click", (e) => { if (e.target === $("modal")) closeModal(); });
  $("situation-form").addEventListener("submit", saveModal);
  $("lock-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const value = $("lock-input").value.trim();
    if (!value) return;
    localStorage.setItem(AUTH_KEY, value);
    hideLock();
  });

  refreshState();
  api("/api/content")
    .then((c) => { state.content = c; renderContent(); })
    .catch(() => {});
  render();
}

init();
