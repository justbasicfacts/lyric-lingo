import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { ROOT, DATA, PORT, REDIRECT_URI, hasLLM, hasSpotify, loadEnv } from "./env.mjs";
import {
  accessToken,
  authorizationUrl,
  clearTokens,
  exchangeCode,
  isAuthed,
  loadTokens,
} from "./auth.mjs";
import { cacheKey, findLyrics, readCache, writeCache } from "./lyrics.mjs";
import { translateLines, translateWord } from "./translate.mjs";
import {
  mprisActive,
  mprisNowPlaying,
  mprisPause,
  mprisPlay,
  mprisSeek,
} from "./player.mjs";

await loadEnv();
await loadTokens();

const PUBLIC = path.join(ROOT, "public");
const SPOTIFY = "https://api.spotify.com/v1";
const DEFAULT_LANG = process.env.DEFAULT_TARGET_LANG || "English";

/** Compiled track pages, keyed by track id + target language. */
const pages = new Map();
const PAGE_TTL = 6 * 60 * 60 * 1000;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

async function sendFile(res, filePath) {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("not a file");
    const body = await readFile(filePath);
    res.writeHead(200, {
      "content-type": MIME[path.extname(filePath)] || "application/octet-stream",
      "cache-control": /\.(html|js|css)$/.test(filePath) ? "no-cache" : "public, max-age=3600",
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
  }
}

async function spotify(pathname, init = {}) {
  const token = await accessToken();
  const res = await fetch(`${SPOTIFY}${pathname}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers || {}),
    },
  });
  if (res.status === 204) return null;
  if (!res.ok) {
    const text = await res.text();
    const error = new Error(`Spotify ${pathname} failed (${res.status}): ${text.slice(0, 200)}`);
    error.status = res.status;
    throw error;
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const DEMO = {
  id: "demo-track",
  title: "Lernlied (demo)",
  artist: "No Spotify account needed",
  album: "Demo",
  image: null,
  durationMs: 68_000,
  demo: true,
  lyrics: [
    ["Ich stehe jeden Morgen früh auf", "I get up early every morning"],
    ["und lerne neue Wörter dazu", "and pick up new words along the way"],
    ["Die Straße spricht in einer Sprache", "The street speaks in a language"],
    ["die ich langsam verstehen kann", "that I can slowly understand"],
    ["Jeden Tag ein bisschen mehr", "A little more every day"],
    ["bis der Satz von selbst kommt", "until the sentence comes by itself"],
    ["Ich höre zu und spreche nach", "I listen and repeat"],
    ["Das Lied bleibt in meinem Kopf", "The song stays in my head"],
  ],
};

async function demoPayload(lang) {
  const step = DEMO.durationMs / DEMO.lyrics.length;
  const elapsed = Date.now() % DEMO.durationMs;
  const german = DEMO.lyrics.map(([text]) => text);
  const english = DEMO.lyrics.map(([, englishLine]) => englishLine);
  let translations = english;
  if (!lang.toLowerCase().startsWith("english")) {
    const done = await translateLines(german, lang, "demo-track").catch(() => null);
    if (done?.lines?.length) translations = done.lines;
  }
  const segments = german.map((text, i) => ({
    t: +(i * step / 1000).toFixed(2),
    text,
    translation: translations[i] || "",
  }));
  return {
    authed: isAuthed(),
    webApi: hasSpotify(),
    hasLLM: hasLLM(),
    lang,
    track: {
      id: DEMO.id,
      title: DEMO.title,
      artist: DEMO.artist,
      album: DEMO.album,
      image: DEMO.image,
      durationMs: DEMO.durationMs,
      demo: true,
    },
    playing: true,
    progress: elapsed,
    segments,
    source: "demo",
    note: "Demo track with made up lyrics. Open Spotify on this computer and press play: this page follows it automatically, no login needed.",
  };
}

async function buildPage(track, lang) {
  const key = `${track.id}|${lang}`;
  const cached = pages.get(key);
  if (cached && Date.now() - cached.at < PAGE_TTL) return cached.value;

  const storeKey = cacheKey({
    title: track.title,
    artist: track.artist,
    durationMs: track.durationMs,
  });
  let found = await readCache(storeKey);

  if (!found) {
    found = await findLyrics({
      title: track.title,
      artist: track.artist,
      album: track.album,
      durationMs: track.durationMs,
    }).catch((err) => ({ error: err.message }));
    if (found) await writeCache(storeKey, found).catch(() => {});
  }

  const segments = (found?.segments || []).map((s) => ({ t: s.t, text: s.text }));
  let note = null;
  let sourceLanguage = null;

  if (found?.error) {
    note = `Lyrics lookup failed: ${found.error}`;
  } else if (found?.instrumental) {
    note = "This one is instrumental, so there is nothing to translate. Enjoy the groove.";
  } else if (!segments.length) {
    note = "No lyrics found for this track.";
  } else {
    const translated = await translateLines(
      segments.map((s) => s.text),
      lang,
      storeKey
    ).catch((err) => ({ lines: [], error: err.message }));

    if (translated.error) note = `Translation failed: ${translated.error}`;
    else if (translated.offline) note = "No DeepSeek key, so only the original lyrics are shown.";
    sourceLanguage = translated.sourceLanguage || null;
    translated.lines.forEach((value, i) => {
      segments[i].translation = value || "";
    });
  }

  const value = {
    segments: segments.filter((s) => s.text),
    sourceLanguage,
    source: found?.source || null,
    note,
  };
  pages.set(key, { at: Date.now(), value });
  return value;
}

async function localPlaying(lang) {
  const local = await mprisNowPlaying().catch(() => null);
  if (!local) return null;
  const page = await buildPage(local.track, lang);
  return {
    authed: isAuthed(),
    webApi: hasSpotify(),
    hasLLM: hasLLM(),
    lang,
    track: local.track,
    playing: local.playing,
    progress: local.positionMs,
    segments: page.segments,
    sourceLanguage: page.sourceLanguage,
    source: page.source,
    note: page.note,
    via: "mpris",
  };
}

async function currentlyPlaying(lang) {
  const data = await spotify("/me/player/currently-playing?market=from_token");
  if (!data?.item) {
    return { authed: true, playing: false, lang, track: null, segments: [], note: "Nothing playing in Spotify right now." };
  }
  const item = data.item;
  const track = {
    id: item.id,
    title: item.name,
    artist: (item.artists || []).map((a) => a.name).join(", "),
    album: item.album?.name || "",
    image: item.album?.images?.[1]?.url || item.album?.images?.[0]?.url || null,
    durationMs: item.duration_ms,
    url: item.external_urls?.spotify || null,
    demo: false,
  };

  const page = await buildPage(track, lang);
  return {
    authed: true,
    webApi: hasSpotify(),
    hasLLM: hasLLM(),
    lang,
    track,
    playing: Boolean(data.is_playing),
    progress: data.progress_ms || 0,
    segments: page.segments,
    sourceLanguage: page.sourceLanguage,
    source: page.source,
    note: page.note,
  };
}

async function readBody(req) {
  const parts = [];
  for await (const chunk of req) parts.push(chunk);
  const text = Buffer.concat(parts).toString("utf8");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
  const lang = url.searchParams.get("lang") || DEFAULT_LANG;

  try {
    if (url.pathname === "/login") {
      res.writeHead(302, { location: authorizationUrl() });
      return res.end();
    }

    if (url.pathname === "/logout") {
      await clearTokens();
      res.writeHead(302, { location: "/" });
      return res.end();
    }

    if (url.pathname === "/callback") {
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (error || !code) {
        res.writeHead(302, { location: `/?login=failed&reason=${encodeURIComponent(error || "no code")}` });
        return res.end();
      }
      await exchangeCode(code, state);
      res.writeHead(302, { location: "/" });
      return res.end();
    }

    if (url.pathname === "/api/playing") {
      if (url.searchParams.get("demo") === "1") return json(res, 200, await demoPayload(lang));
      const local = await localPlaying(lang).catch(() => null);
      if (local) return json(res, 200, local);
      if (!isAuthed()) {
        const demo = await demoPayload(lang);
        demo.note = demo.note || "Open Spotify on this computer and press play. No login needed.";
        return json(res, 200, demo);
      }
      try {
        return json(res, 200, await currentlyPlaying(lang));
      } catch (err) {
        if (err.status === 401) {
          return json(res, 200, { ...(await demoPayload(lang)), note: "Spotify session expired, log in again." });
        }
        if (err.status === 403) {
          return json(res, 200, { ...(await demoPayload(lang)), note: "Spotify refused the request. Check the app's scopes and that your account has Premium." });
        }
        throw err;
      }
    }

    if (url.pathname === "/api/seek" && req.method === "POST") {
      const body = await readBody(req);
      const position = Math.max(0, Math.round(Number(body.positionMs) || 0));
      const handled = await mprisSeek(position).catch(() => false);
      if (!handled) await spotify(`/me/player/seek?position_ms=${position}`, { method: "PUT" });
      return json(res, 200, { ok: true, position, via: handled ? "mpris" : "web" });
    }

    if (url.pathname === "/api/pause" && req.method === "POST") {
      const handled = await mprisPause().catch(() => false);
      if (!handled) await spotify("/me/player/pause", { method: "PUT" });
      return json(res, 200, { ok: true, via: handled ? "mpris" : "web" });
    }

    if (url.pathname === "/api/resume" && req.method === "POST") {
      const handled = await mprisPlay().catch(() => false);
      if (!handled) await spotify("/me/player/play", { method: "PUT" });
      return json(res, 200, { ok: true, via: handled ? "mpris" : "web" });
    }

    if (url.pathname === "/api/word" && req.method === "POST") {
      const body = await readBody(req);
      const word = String(body.word || "").trim().slice(0, 60);
      const line = String(body.line || "").trim().slice(0, 300);
      if (!word) return json(res, 400, { error: "No word given" });
      const result = await translateWord(word, line, body.lang || lang);
      return json(res, 200, result);
    }

    if (url.pathname === "/api/preview") {
      const title = url.searchParams.get("title");
      const artist = url.searchParams.get("artist") || "";
      if (!title) return json(res, 400, { error: "Add ?title=Track+name&artist=Someone" });
      const track = {
        id: `preview-${Buffer.from(`${artist}-${title}`).toString("hex").slice(0, 16)}`,
        title,
        artist,
        album: url.searchParams.get("album") || "",
        image: null,
        durationMs: Number(url.searchParams.get("durationMs")) || 0,
        demo: true,
        preview: true,
        url: null,
      };
      const page = await buildPage(track, lang);
      return json(res, 200, {
        authed: isAuthed(),
        webApi: hasSpotify(),
        hasLLM: hasLLM(),
        lang,
        track,
        playing: true,
        progress: Number(url.searchParams.get("at") || 0) * 1000,
        segments: page.segments,
        sourceLanguage: page.sourceLanguage,
        source: page.source,
        note: page.note || "Preview mode: lyrics and translations only, no playback.",
      });
    }

    if (url.pathname === "/api/health") {
      return json(res, 200, {
        ok: true,
        authed: isAuthed(),
        localPlayer: await mprisActive().catch(() => false),
        hasLLM: hasLLM(),
        redirectUri: REDIRECT_URI,
        dataDir: DATA,
        lang: DEFAULT_LANG,
      });
    }

    if (url.pathname === "/") return sendFile(res, path.join(PUBLIC, "index.html"));

    const safe = path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, "");
    return sendFile(res, path.join(PUBLIC, safe));
  } catch (err) {
    console.error(err);
    return json(res, 500, { error: err.message });
  }
});

server.listen(PORT, "127.0.0.1", async () => {
  console.log(`Lyric Lingo running at http://127.0.0.1:${PORT}`);
  console.log(`Spotify redirect URI must be registered as: ${REDIRECT_URI}`);
  const local = await mprisActive().catch(() => false);
  console.log(
    `Player: ${local ? "local Spotify app over MPRIS" : isAuthed() ? "Spotify Web API" : "demo only"} | DeepSeek: ${hasLLM() ? "ready" : "missing key"}`
  );
});
