// ---------- Setup ----------
const $ = (id) => document.getElementById(id);
const messagesEl = $("messages");
const startersEl = $("starters");
const statusEl = $("status");
const inputEl = $("input");
const sendBtn = $("sendBtn");
const keyDialog = $("keyDialog");
const keyInput = $("keyInput");
const rememberBox = $("rememberBox");

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models/";
const STORAGE_NAME = "roadready_gemini_key";
const CACHE_NAME = "roadready_embeddings_v1";
const MAX_NOTE_CHARS = 1500;   // longer notes are split at blank lines
const BATCH_SIZE = 50;         // notes per embedding request

let history = [];       // plain conversation (questions and replies only)
let busy = false;
let memoryKey = "";     // backup if browser storage is blocked

// Knowledge (notes) state
let notes = [];                 // each: { title, text, vector }
let knowledgeState = "off";     // "off" | "loading" | "missing" | "empty" | "ready"
let meaningReady = false;       // true once note embeddings are available
let statusExtra = "";           // small extra message shown in the status line
let loadId = 0;                 // used to ignore out-of-date loads
let knowledgePromise = Promise.resolve();

// ---------- Storage (wrapped in try/catch) ----------
function getKey() {
  try {
    const s = sessionStorage.getItem(STORAGE_NAME);
    if (s) return s;
  } catch (e) {}
  try {
    const l = localStorage.getItem(STORAGE_NAME);
    if (l) return l;
  } catch (e) {}
  return memoryKey;
}
function saveKey(key, remember) {
  memoryKey = key;
  try { sessionStorage.setItem(STORAGE_NAME, key); } catch (e) {}
  try {
    if (remember) localStorage.setItem(STORAGE_NAME, key);
    else localStorage.removeItem(STORAGE_NAME);
  } catch (e) {}
}
function clearKey() {
  memoryKey = "";
  try { sessionStorage.removeItem(STORAGE_NAME); } catch (e) {}
  try { localStorage.removeItem(STORAGE_NAME); } catch (e) {}
}

// ---------- Safe text formatting ----------
function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;")
             .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function bold(s) {
  return s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}
function formatText(raw) {
  const lines = escapeHtml(raw).split("\n");
  let html = "";
  let inList = false;
  for (const line of lines) {
    const m = line.match(/^\s*[-*•]\s+(.*)$/);
    if (m) {
      if (!inList) { html += "<ul>"; inList = true; }
      html += "<li>" + bold(m[1]) + "</li>";
    } else {
      if (inList) { html += "</ul>"; inList = false; }
      if (line.trim() !== "") html += "<p>" + bold(line) + "</p>";
    }
  }
  if (inList) html += "</ul>";
  return html;
}

// ---------- Copying ----------
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch (e2) {
      return false;
    }
  }
}

// ---------- Reading knowledge.md ----------
// Each note starts with "## Note title". Anything above the first one is ignored.
function parseNotes(md) {
  const out = [];
  let title = null;
  let buf = [];
  const flush = () => {
    if (title === null) return;
    const body = buf.join("\n").trim();
    if (body) splitNote(title, body).forEach((n) => out.push(n));
  };
  for (const line of md.replace(/\r\n/g, "\n").split("\n")) {
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m) { flush(); title = m[1]; buf = []; }
    else if (title !== null) buf.push(line);
  }
  flush();
  return out;
}
// Long notes are split at blank lines into parts
function splitNote(title, body) {
  if (body.length <= MAX_NOTE_CHARS) return [{ title, text: body }];
  const chunks = [];
  let cur = "";
  for (const p of body.split(/\n\s*\n/)) {
    if (cur && cur.length + p.length + 2 > MAX_NOTE_CHARS) { chunks.push(cur); cur = p; }
    else cur = cur ? cur + "\n\n" + p : p;
  }
  if (cur) chunks.push(cur);
  return chunks.map((text, i) => ({
    title: chunks.length > 1 ? title + " (part " + (i + 1) + ")" : title,
    text,
  }));
}

// A short "fingerprint" of the file, so we only re-embed when it changes
function fingerprint(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16) + "-" + str.length;
}

// ---------- Embeddings ----------
async function embedTexts(texts, key) {
  const model = BOT_CONFIG.embeddingModel;
  const response = await fetch(API_BASE + encodeURIComponent(model) + ":batchEmbedContents", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      requests: texts.map((t) => ({
        model: "models/" + model,
        content: { parts: [{ text: t }] },
      })),
    }),
  });
  if (!response.ok) throw { status: response.status };
  const data = await response.json();
  const vectors = (data.embeddings || []).map((e) => e.values);
  if (vectors.length !== texts.length) throw { status: 0 };
  return vectors;
}

function embedReason(err) {
  const s = err && err.status;
  if (s === 400 || s === 403) return "check your API key";
  if (s === 404) return "check embeddingModel in config.js";
  if (s === 429) return "rate limit, try again soon";
  if (s >= 500) return "Google is busy";
  return "no internet or a connection problem";
}

async function getVectors(md, key) {
  const texts = notes.map((n) => "title: " + n.title + " | text: " + n.text);
  const fp = fingerprint(BOT_CONFIG.embeddingModel + "\n" + md);

  // Reuse saved vectors if the file hasn't changed
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_NAME));
    if (cached && cached.fp === fp && Array.isArray(cached.vectors) &&
        cached.vectors.length === notes.length) return cached.vectors;
  } catch (e) {}

  const vectors = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const part = await embedTexts(texts.slice(i, i + BATCH_SIZE), key);
    part.forEach((v) => vectors.push(v));
  }

  // Save for next time (rounded a little so it takes less space)
  try {
    localStorage.setItem(CACHE_NAME, JSON.stringify({
      fp,
      vectors: vectors.map((v) => v.map((x) => Math.round(x * 1e6) / 1e6)),
    }));
  } catch (e) {}
  return vectors;
}

// ---------- Status line ----------
function updateStatus() {
  if (!BOT_CONFIG.useKnowledge) { statusEl.hidden = true; return; }
  statusEl.hidden = false;
  statusEl.classList.remove("warn");
  const file = BOT_CONFIG.knowledgeFile;

  if (knowledgeState === "loading") {
    statusEl.textContent = "📚 Loading notes...";
  } else if (knowledgeState === "missing") {
    statusEl.classList.add("warn");
    statusEl.textContent = "📚 Can't find " + file + ". Add it next to index.html, or set useKnowledge to false in config.js.";
  } else if (knowledgeState === "empty") {
    statusEl.classList.add("warn");
    statusEl.textContent = "📚 " + file + " has no notes. Start each note with a line like: ## Note title";
  } else if (knowledgeState === "ready") {
    const mode = BOT_CONFIG.searchMethod === "meaning" && meaningReady ? "meaning" : "keyword";
    const count = notes.length + (notes.length === 1 ? " note" : " notes");
    statusEl.textContent = "📚 " + count + " loaded · " + mode + " search" +
      (statusExtra ? " (" + statusExtra + ")" : "");
  } else {
    statusEl.hidden = true;
  }
}

// ---------- Loading the notes ----------
function loadKnowledge() {
  knowledgePromise = doLoadKnowledge();
  return knowledgePromise;
}

async function doLoadKnowledge() {
  const myId = ++loadId;
  if (!BOT_CONFIG.useKnowledge) { knowledgeState = "off"; updateStatus(); return; }

  knowledgeState = "loading";
  meaningReady = false;
  statusExtra = "";
  updateStatus();

  let md = "";
  try {
    const res = await fetch(BOT_CONFIG.knowledgeFile, { cache: "no-cache" });
    if (!res.ok) throw new Error("not found");
    md = await res.text();
  } catch (e) {
    if (myId !== loadId) return;
    notes = [];
    knowledgeState = "missing";
    updateStatus();
    return;
  }
  if (myId !== loadId) return;

  notes = parseNotes(md);
  if (!notes.length) { knowledgeState = "empty"; updateStatus(); return; }
  knowledgeState = "ready";

  if (BOT_CONFIG.searchMethod === "meaning") {
    const key = getKey();
    if (!key) {
      statusExtra = "add your API key to use meaning search";
    } else {
      statusExtra = "preparing meaning search...";
      updateStatus();
      try {
        const vectors = await getVectors(md, key);
        if (myId !== loadId) return;
        notes.forEach((n, i) => { n.vector = vectors[i]; });
        meaningReady = true;
        statusExtra = "";
      } catch (err) {
        if (myId !== loadId) return;
        statusExtra = "meaning search unavailable: " + embedReason(err);
      }
    }
  }
  updateStatus();
}

// ---------- Finding the right notes ----------
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

const STOP_WORDS = new Set(("a an the and or but if of to in on at for from by with about as is are was were be been " +
  "do does did can could should would will what which who whom how when where why i me my you your we our it its " +
  "this that these those give tell show need know quiz please").split(" "));

function stem(w) { return w.length > 4 ? w.replace(/(ing|ed|es|s)$/, "") : w; }
function terms(s) {
  const words = s.toLowerCase().match(/[a-z0-9]+/g) || [];
  return [...new Set(words.filter((w) => w.length > 1 && !STOP_WORDS.has(w)).map(stem))];
}

// Simple keyword search: title matches count more than text matches
function keywordScores(question) {
  const qt = terms(question);
  return notes.map((n) => {
    if (!qt.length) return { note: n, score: 0 };
    const title = n.title.toLowerCase();
    const text = n.text.toLowerCase();
    let raw = 0;
    for (const t of qt) {
      if (title.includes(t)) raw += 3;
      raw += Math.min(text.split(t).length - 1, 3);
    }
    return { note: n, score: raw / (qt.length * 6) };
  });
}

function topHits(scored, k) {
  return scored.sort((a, b) => b.score - a.score).slice(0, k);
}

async function retrieve(question, key) {
  if (!BOT_CONFIG.useKnowledge || knowledgeState !== "ready" || !notes.length) return [];
  const k = Math.max(1, Number(BOT_CONFIG.topK) || 3);

  if (BOT_CONFIG.searchMethod === "meaning" && meaningReady) {
    try {
      const q = await embedTexts(["task: search result | query: " + question], key);
      const scored = notes.map((n) => ({ note: n, score: cosine(q[0], n.vector) }));
      if (statusExtra) { statusExtra = ""; updateStatus(); }
      return topHits(scored, k);
    } catch (err) {
      statusExtra = "last question used keyword search instead";
      updateStatus();
    }
  }
  return topHits(keywordScores(question), k).filter((h) => h.score > 0);
}

// The question plus numbered notes, sent to Gemini for this turn only
function buildPrompt(question, hits) {
  let text = "NOTES:\n";
  if (!hits.length) text += "(No notes matched this question.)\n\n";
  hits.forEach((h, i) => {
    text += "[" + (i + 1) + "] " + h.note.title + "\n" + h.note.text + "\n\n";
  });
  return text + "QUESTION: " + question;
}

// ---------- Chat display ----------
function addBubble(kind, text) {
  const div = document.createElement("div");
  div.className = "bubble " + kind;
  if (kind === "user") div.textContent = text;
  else div.innerHTML = formatText(text);
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

// A bot answer with a Sources section and a Copy button underneath
function addReply(text, hits) {
  const wrap = document.createElement("div");
  wrap.className = "reply";

  const bubble = document.createElement("div");
  bubble.className = "bubble bot";
  bubble.innerHTML = formatText(text);
  wrap.appendChild(bubble);

  if (hits && hits.length) {
    const details = document.createElement("details");
    details.className = "sources";
    const summary = document.createElement("summary");
    summary.textContent = "Sources (" + hits.length + ")";
    details.appendChild(summary);
    hits.forEach((h, i) => {
      const item = document.createElement("div");
      item.className = "source";
      const head = document.createElement("strong");
      head.textContent = "[" + (i + 1) + "] " + h.note.title;
      const score = document.createElement("span");
      score.textContent = " · score " + h.score.toFixed(2);
      const preview = document.createElement("p");
      const t = h.note.text.replace(/\s+/g, " ");
      preview.textContent = t.length > 200 ? t.slice(0, 200) + "..." : t;
      item.appendChild(head);
      item.appendChild(score);
      item.appendChild(preview);
      details.appendChild(item);
    });
    wrap.appendChild(details);
  }

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "copy";
  btn.textContent = "Copy";
  btn.setAttribute("aria-label", "Copy this reply");
  btn.addEventListener("click", async () => {
    const ok = await copyText(text);
    btn.textContent = ok ? "Copied!" : "Couldn't copy";
    setTimeout(() => { btn.textContent = "Copy"; }, 1500);
  });
  wrap.appendChild(btn);

  messagesEl.appendChild(wrap);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function showThinking() {
  const div = document.createElement("div");
  div.className = "bubble bot thinking";
  div.innerHTML = "<span></span><span></span><span></span>";
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}
function setBusy(value) {
  busy = value;
  sendBtn.disabled = value;
}

// ---------- Friendly errors ----------
function errorMessage(status) {
  if (status === 400 || status === 403)
    return "Your API key doesn't seem to work. Click the \"API key\" button and paste a valid key.";
  if (status === 429)
    return "Too many requests right now. Please wait a minute and try again.";
  if (status === 404)
    return "The AI model name wasn't found. Check the \"model\" line in config.js.";
  if (status >= 500)
    return "Google's AI service is having problems. Please try again in a bit.";
  return "Something went wrong (error " + status + "). Please try again.";
}

// ---------- Talking to Gemini ----------
async function sendMessage(text) {
  text = text.trim();
  if (!text || busy) return;

  const key = getKey();
  if (!key) {
    addBubble("error", "Please add your API key first. Click the \"API key\" button at the top.");
    keyDialog.showModal();
    return;
  }

  startersEl.style.display = "none";
  addBubble("user", text);
  history.push({ role: "user", parts: [{ text }] });   // history keeps the plain question
  inputEl.value = "";
  inputEl.style.height = "auto";
  setBusy(true);
  const thinking = showThinking();

  try {
    await knowledgePromise;   // wait if the notes are still loading

    const useNotes = BOT_CONFIG.useKnowledge && knowledgeState === "ready" && notes.length > 0;
    const hits = useNotes ? await retrieve(text, key) : [];

    // This turn's question gets the notes attached; history stays plain
    const contents = useNotes
      ? history.slice(0, -1).concat({ role: "user", parts: [{ text: buildPrompt(text, hits) }] })
      : history;
    const system = BOT_CONFIG.systemInstructions +
      (useNotes ? "\n\n" + BOT_CONFIG.knowledgeRules : "");

    const url = API_BASE + encodeURIComponent(BOT_CONFIG.model) + ":generateContent";
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents,
      }),
    });

    if (!response.ok) {
      history.pop(); // remove the message that failed
      thinking.remove();
      addBubble("error", errorMessage(response.status));
      return;
    }

    const data = await response.json();
    const parts = (data.candidates && data.candidates[0] &&
                   data.candidates[0].content && data.candidates[0].content.parts) || [];
    const reply = parts
      .filter((p) => !p.thought && typeof p.text === "string")
      .map((p) => p.text)
      .join("");

    thinking.remove();
    if (!reply.trim()) {
      history.pop();
      addBubble("error", "I couldn't come up with an answer to that. Try asking in a different way.");
      return;
    }
    history.push({ role: "model", parts: [{ text: reply }] });
    addReply(reply, hits);
  } catch (err) {
    history.pop();
    thinking.remove();
    addBubble("error", "Can't reach the internet. Check your connection and try again.");
  } finally {
    setBusy(false);
    inputEl.focus();
  }
}

// ---------- Start / reset ----------
function startChat() {
  history = [];
  messagesEl.innerHTML = "";
  addBubble("bot", BOT_CONFIG.welcomeMessage);
  startersEl.style.display = "flex";
}

function init() {
  document.documentElement.style.setProperty("--accent", BOT_CONFIG.themeColor);
  document.title = BOT_CONFIG.name;
  $("botName").textContent = BOT_CONFIG.name;
  $("botEmoji").textContent = BOT_CONFIG.emoji;
  $("botTagline").textContent = BOT_CONFIG.tagline;

  BOT_CONFIG.starterQuestions.forEach((q) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = q;
    b.addEventListener("click", () => sendMessage(q));
    startersEl.appendChild(b);
  });
  startChat();
  loadKnowledge();
}

// ---------- Events ----------
$("chatForm").addEventListener("submit", (e) => {
  e.preventDefault();
  sendMessage(inputEl.value);
});
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendMessage(inputEl.value);
  }
});
inputEl.addEventListener("input", () => {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 140) + "px";
});
$("newBtn").addEventListener("click", startChat);

$("keyBtn").addEventListener("click", () => {
  keyInput.value = "";
  rememberBox.checked = false;
  try { rememberBox.checked = !!localStorage.getItem(STORAGE_NAME); } catch (e) {}
  keyDialog.showModal();
});
$("keyCancel").addEventListener("click", () => keyDialog.close());
$("keyClear").addEventListener("click", () => { clearKey(); keyDialog.close(); });
$("keyForm").addEventListener("submit", () => {
  const key = keyInput.value.trim();
  if (key) {
    saveKey(key, rememberBox.checked);
    loadKnowledge();   // (re)prepare the notes with the new key
  }
});

init();
