const MY_BUILD = new URL(import.meta.url).searchParams.get("v") || "dev";
const LANGUAGES = [
  "English", "German", "Spanish", "French", "Italian", "Portuguese", "Dutch",
  "Turkish", "Polish", "Russian", "Ukrainian", "Swedish", "Danish", "Greek",
  "Arabic", "Hindi", "Japanese", "Korean", "Chinese", "Indonesian",
];

const WORDS_KEY = "lyric-lingo.words.v1";
const LANG_KEY = "lyric-lingo.lang.v1";
const HIDE_KEY = "lyric-lingo.hide.v1";

const el = (id) => document.getElementById(id);
const ui = {
  lang: el("lang"),
  title: el("title"),
  artist: el("artist"),
  art: el("art"),
  progress: el("progress"),
  elapsed: el("elapsed"),
  left: el("left"),
  note: el("note"),
  karaoke: el("karaoke"),
  connect: el("connect"),
  playpause: el("playpause"),
  source: el("source"),
  alllines: el("alllines"),
  words: el("words"),
  wordsEmpty: el("words-empty"),
  wordcount: el("wordcount"),
  toggleTranslation: el("toggle-translation"),
  build: el("build"),
};

const state = {
  lang: localStorage.getItem(LANG_KEY) || "English",
  data: null,
  trackId: null,
  renderedIndex: -2,
  anchor: { progress: 0, at: performance.now(), playing: false },
  vocab: readVocab(),
  busy: new Set(),
};

function readVocab() {
  try {
    const raw = JSON.parse(localStorage.getItem(WORDS_KEY) || "[]");
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function writeVocab() {
  localStorage.setItem(WORDS_KEY, JSON.stringify(state.vocab));
}

const clock = (ms) => {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};

function position() {
  const { progress, at, playing } = state.anchor;
  return playing ? progress + (performance.now() - at) : progress;
}

function currentIndex(seconds) {
  const segs = state.data?.segments || [];
  let index = -1;
  for (let i = 0; i < segs.length; i++) {
    if (segs[i].t <= seconds) index = i;
    else break;
  }
  return index;
}

function renderHeader() {
  const { track, authed } = state.data;
  ui.connect.hidden = !state.data.webApi || Boolean(authed);
  ui.connect.setAttribute("href", "/login");
  if (!track) {
    ui.title.textContent = "Nothing playing";
    ui.artist.textContent = "Start a song in Spotify and it shows up here.";
    ui.art.removeAttribute("src");
    return;
  }
  document.title = `${track.title} | Lyric Lingo`;
  ui.title.textContent = track.title;
  ui.artist.textContent = [track.artist, track.album].filter(Boolean).join(" · ");
  if (track.image) ui.art.src = track.image;
  else ui.art.removeAttribute("src");

  const bits = [];
  if (track.demo) bits.push("demo track");
  if (state.data.source) bits.push(state.data.source.replace("lrclib-", "lyrics "));
  if (state.data.sourceLanguage) bits.push(`from ${state.data.sourceLanguage}`);
  ui.source.textContent = bits.join(" · ");
}

function renderNote() {
  const note = state.data?.note;
  ui.note.textContent = note || "";
  ui.note.hidden = !note;
}

function wordSpans(line) {
  const frag = document.createDocumentFragment();
  const parts = line.split(/(\s+)/);
  for (const part of parts) {
    if (!part) continue;
    if (/^\s+$/.test(part)) {
      frag.append(document.createTextNode(part));
      continue;
    }
    const clean = part.replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, "");
    if (!clean) {
      frag.append(document.createTextNode(part));
      continue;
    }
    const span = document.createElement("span");
    span.className = "word";
    if (state.vocab.some((v) => v.word.toLowerCase() === clean.toLowerCase())) {
      span.classList.add("saved");
    }
    span.dataset.word = clean;
    span.textContent = part;
    frag.append(span);
  }
  return frag;
}

function lineNode(seg, index, klass) {
  const wrap = document.createElement("div");
  wrap.className = `line ${klass}`;
  if (!seg.translation) wrap.classList.add("estimated");
  wrap.dataset.index = String(index);
  const orig = document.createElement("div");
  orig.className = "orig";
  orig.append(wordSpans(seg.text));
  const trans = document.createElement("div");
  trans.className = "trans";
  trans.textContent = seg.translation || "";
  wrap.append(orig, trans);
  wrap.addEventListener("click", (event) => {
    const target = event.target.closest(".word");
    if (target) {
      event.stopPropagation();
      lookUpWord(target.dataset.word, seg.text);
      return;
    }
    seekTo(index);
  });
  return wrap;
}

function renderKaraoke(index) {
  const segs = state.data?.segments || [];
  ui.karaoke.replaceChildren();
  if (!segs.length) {
    const empty = document.createElement("div");
    empty.className = "skeleton";
    empty.textContent = state.data?.track
      ? "No timed lyrics for this track."
      : "Waiting for Spotify.";
    ui.karaoke.append(empty);
    return;
  }
  const start = Math.max(0, index - 2);
  const end = Math.min(segs.length, index + 3);
  if (index < 0 && start === 0) {
    for (let i = 0; i < Math.min(3, segs.length); i++) {
      ui.karaoke.append(lineNode(segs[i], i, i === 0 ? "current" : "next"));
    }
    return;
  }
  for (let i = start; i < end; i++) {
    const klass = i === index ? "current" : i < index ? "past" : "next";
    ui.karaoke.append(lineNode(segs[i], i, klass));
  }
}

function renderAllLines() {
  const segs = state.data?.segments || [];
  ui.alllines.replaceChildren();
  segs.forEach((seg, i) => {
    const li = document.createElement("li");
    li.dataset.index = String(i);
    const stamp = document.createElement("span");
    stamp.className = "stamp";
    stamp.textContent = clock(seg.t * 1000);
    const body = document.createElement("span");
    body.textContent = seg.text;
    if (seg.translation) {
      const tr = document.createElement("span");
      tr.className = "tr";
      tr.textContent = seg.translation;
      body.append(tr);
    }
    li.append(stamp, body);
    li.addEventListener("click", () => seekTo(i));
    ui.alllines.append(li);
  });
}

function highlightSidebar(index) {
  const items = ui.alllines.children;
  for (let i = 0; i < items.length; i++) {
    items[i].classList.toggle("active", i === index);
  }
  const active = items[index];
  if (active) {
    const panel = active.closest(".panel");
    const offset = active.offsetTop - panel.offsetTop;
    if (offset < panel.scrollTop || offset > panel.scrollTop + panel.clientHeight - 80) {
      panel.scrollTo({ top: Math.max(0, offset - panel.clientHeight / 2), behavior: "smooth" });
    }
  }
}

function renderWords() {
  ui.words.replaceChildren();
  ui.wordcount.textContent = String(state.vocab.length);
  ui.wordsEmpty.hidden = state.vocab.length > 0;
  for (const item of state.vocab) {
    const li = document.createElement("li");
    const head = document.createElement("div");
    const word = document.createElement("span");
    word.className = "w";
    word.textContent = item.word;
    head.append(word);
    if (item.base && item.base.toLowerCase() !== item.word.toLowerCase()) {
      const base = document.createElement("span");
      base.className = "base";
      base.textContent = item.base;
      head.append(base);
    }
    const tr = document.createElement("div");
    tr.className = "t";
    tr.textContent = item.translation || (item.pending ? "looking up..." : "");
    li.append(head, tr);
    if (item.meaning) {
      const m = document.createElement("div");
      m.className = "m";
      m.textContent = item.meaning;
      li.append(m);
    }
    ui.words.append(li);
  }
}

async function lookUpWord(word, line) {
  const known = state.vocab.find(
    (v) => v.word.toLowerCase() === word.toLowerCase() && v.lang === state.lang
  );
  if (known) return;
  const key = `${word}|${state.lang}`;
  if (state.busy.has(key)) return;
  state.busy.add(key);

  const entry = { word, base: "", translation: "", meaning: "", line, lang: state.lang, pending: true };
  state.vocab.unshift(entry);
  writeVocab();
  renderWords();

  try {
    const res = await fetch("/api/word", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ word, line, lang: state.lang }),
    });
    const data = await res.json();
    entry.base = data.base || word;
    entry.translation = data.translation || "no translation";
    entry.meaning = data.meaning || "";
  } catch {
    entry.translation = "lookup failed";
  } finally {
    entry.pending = false;
    state.busy.delete(key);
    writeVocab();
    renderWords();
    markSavedWords();
  }
}

function markSavedWords() {
  const saved = new Set(state.vocab.map((v) => v.word.toLowerCase()));
  for (const span of document.querySelectorAll(".karaoke .word")) {
    span.classList.toggle("saved", saved.has(span.dataset.word.toLowerCase()));
  }
}

// True when there is a real player behind the page: the local Spotify app over
// MPRIS, or the Web API fallback. Demo and preview tracks have nothing to drive.
const remote = () => Boolean(state.data?.track && !state.data.track.demo);

async function seekTo(index) {
  const seg = state.data?.segments?.[index];
  if (!seg) return;
  const ms = Math.max(0, Math.round(seg.t * 1000));
  state.anchor = { progress: ms, at: performance.now(), playing: state.anchor.playing };
  state.renderedIndex = -2;
  if (!remote()) return;
  try {
    await fetch("/api/seek", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ positionMs: ms }),
    });
  } catch {
    /* the next poll re-syncs anyway */
  }
}

async function transport(action) {
  if (!remote()) {
    state.anchor.playing = !state.anchor.playing;
    return;
  }
  // Flip the local state straight away so the button answers the click, then
  // let the next poll confirm what the player actually did.
  state.anchor.playing = action === "resume";
  state.anchor.at = performance.now();
  ui.playpause.textContent = action === "resume" ? "Pause" : "Play";
  const res = await fetch(`/api/${action}`, { method: "POST" }).catch(() => null);
  if (!res) {
    ui.note.hidden = false;
    ui.note.textContent = "Cannot reach the local server. Is node server/index.mjs still running?";
  } else if (!res.ok) {
    ui.note.hidden = false;
    ui.note.textContent = "The player refused that. Is Spotify still open?";
  }
  setTimeout(poll, 350);
}

function nudge(deltaMs) {
  const ms = Math.max(0, position() + deltaMs);
  const segs = state.data?.segments || [];
  let index = -1;
  segs.forEach((s, i) => {
    if (s.t * 1000 <= ms) index = i;
  });
  state.anchor = { progress: ms, at: performance.now(), playing: state.anchor.playing };
  state.renderedIndex = -2;
  if (remote()) {
    fetch("/api/seek", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ positionMs: Math.round(ms) }),
    }).catch(() => {});
  }
}

const preview = new URLSearchParams(location.search);

function endpoint() {
  const title = preview.get("preview");
  const demo = preview.get("demo") === "1" ? "&demo=1" : "";
  if (!title) return `/api/playing?lang=${encodeURIComponent(state.lang)}${demo}`;
  const params = new URLSearchParams({
    title,
    artist: preview.get("artist") || "",
    album: preview.get("album") || "",
    lang: state.lang,
  });
  if (preview.get("durationMs")) params.set("durationMs", preview.get("durationMs"));
  if (preview.get("at")) params.set("at", preview.get("at"));
  return `/api/preview?${params}`;
}

async function poll() {
  try {
    const res = await fetch(endpoint());
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    const trackKey = data.track ? `${data.track.id}|${state.lang}` : "none";
    const newTrack = trackKey !== state.trackId;
    const reported = Number(data.progress) || 0;
    // Re-anchor only on a new track or when Spotify's clock really drifted.
    // Preview and demo pages keep reporting the same position, so trust ours.
    const drift = Math.abs(position() - reported);
    if (newTrack || drift > 1500) {
      state.anchor = { progress: reported, at: performance.now(), playing: Boolean(data.playing) };
    } else {
      state.anchor.playing = Boolean(data.playing);
    }

    state.data = data;
    if (data.build && data.build !== MY_BUILD) {
      // The files changed on disk while this tab was open. Reload once per build
      // so the page never keeps running a stale script.
      const key = "lyric-lingo.build";
      if (sessionStorage.getItem(key) !== data.build) {
        sessionStorage.setItem(key, data.build);
        location.reload();
        return;
      }
    }
    renderHeader();
    renderNote();

    if (newTrack) {
      state.trackId = trackKey;
      state.renderedIndex = -2;
      renderAllLines();
      renderWords();
      markSavedWords();
      if (preview.get("at") && data.track?.demo) {
        state.anchor.progress = Number(preview.get("at")) * 1000;
        state.anchor.at = performance.now();
      }
    }
      ui.playpause.textContent = data.playing ? "Pause" : "Play";
    // In demo mode the transport only moves this page, so say that out loud
    // instead of letting a click look broken.
    const demoOnly = !remote();
    for (const id of ["back", "playpause", "forward"]) {
      const button = el(id);
      button.title = demoOnly ? "Demo track: this only moves the demo page" : "";
    }
    const duration = data.track?.durationMs || 0;
    ui.left.textContent = duration ? `-${clock(Math.max(0, duration - position()))}` : "";
  } catch (err) {
    ui.note.hidden = false;
    ui.note.textContent = `Cannot reach the local server: ${err.message}`;
  }
}

function frame() {
  if (state.data) {
    const ms = position();
    const duration = state.data.track?.durationMs || 0;
    const pct = duration ? Math.min(100, (ms / duration) * 100) : 0;
    ui.progress.style.width = `${pct}%`;
    ui.elapsed.textContent = clock(ms);

    const index = currentIndex(ms / 1000);
    if (index !== state.renderedIndex) {
      state.renderedIndex = index;
      renderKaraoke(index);
      highlightSidebar(index);
    }
  }
  requestAnimationFrame(frame);
}

function initLanguage() {
  for (const lang of LANGUAGES) {
    const option = document.createElement("option");
    option.value = lang;
    option.textContent = lang;
    if (lang === state.lang) option.selected = true;
    ui.lang.append(option);
  }
  ui.lang.addEventListener("change", () => {
    state.lang = ui.lang.value;
    localStorage.setItem(LANG_KEY, state.lang);
    state.trackId = null;
    ui.karaoke.innerHTML = '<div class="skeleton">Translating...</div>';
    poll();
  });
}

function initTabs() {
  for (const tab of document.querySelectorAll(".tab")) {
    tab.addEventListener("click", () => {
      for (const other of document.querySelectorAll(".tab")) {
        other.classList.toggle("active", other === tab);
      }
      el("panel-lyrics").hidden = tab.dataset.tab !== "lyrics";
      el("panel-words").hidden = tab.dataset.tab !== "words";
    });
  }
}

function initTranslationToggle() {
  const hide = localStorage.getItem(HIDE_KEY) === "1";
  document.body.classList.toggle("hide-translation", hide);
  ui.toggleTranslation.textContent = hide ? "Show translation" : "Hide translation";
  ui.toggleTranslation.addEventListener("click", () => {
    const next = !document.body.classList.contains("hide-translation");
    document.body.classList.toggle("hide-translation", next);
    localStorage.setItem(HIDE_KEY, next ? "1" : "0");
    ui.toggleTranslation.textContent = next ? "Show translation" : "Hide translation";
  });
}

function initKeys() {
  document.addEventListener("keydown", (event) => {
    const tag = event.target.tagName;
    if (tag === "SELECT" || tag === "INPUT" || tag === "TEXTAREA") return;
    if (event.key === "ArrowLeft") nudge(-5000);
    else if (event.key === "ArrowRight") nudge(5000);
    else if (event.key === " " || event.key === "k") {
      event.preventDefault();
      transport(state.anchor.playing ? "pause" : "resume");
    } else if (event.key.toLowerCase() === "t") {
      ui.toggleTranslation.click();
    }
  });
}

el("back").addEventListener("click", () => nudge(-5000));
el("forward").addEventListener("click", () => nudge(5000));
el("playpause").addEventListener("click", () => transport(state.anchor.playing ? "pause" : "resume"));
el("clear-words").addEventListener("click", () => {
  state.vocab = [];
  writeVocab();
  renderWords();
  markSavedWords();
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) poll();
});

ui.build.textContent = MY_BUILD === "dev" ? "" : MY_BUILD;
initLanguage();
initTabs();
initTranslationToggle();
initKeys();
renderWords();
poll();
requestAnimationFrame(frame);
setInterval(() => {
  if (!document.hidden) poll();
}, 5000);
