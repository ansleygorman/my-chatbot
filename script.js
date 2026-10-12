// ---------- Setup ----------
const $ = (id) => document.getElementById(id);
const messagesEl = $("messages");
const startersEl = $("starters");
const inputEl = $("input");
const sendBtn = $("sendBtn");
const keyDialog = $("keyDialog");
const keyInput = $("keyInput");
const rememberBox = $("rememberBox");

let history = [];       // conversation sent to Gemini
let busy = false;
let memoryKey = "";     // backup if browser storage is blocked
const STORAGE_NAME = "roadready_gemini_key";

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
  history.push({ role: "user", parts: [{ text }] });
  inputEl.value = "";
  inputEl.style.height = "auto";
  setBusy(true);
  const thinking = showThinking();

  try {
    const url = "https://generativelanguage.googleapis.com/v1beta/models/" +
      encodeURIComponent(BOT_CONFIG.model) + ":generateContent";
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: BOT_CONFIG.systemInstructions }] },
        contents: history,
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
    addBubble("bot", reply);
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
  if (key) saveKey(key, rememberBox.checked);
});

init();
