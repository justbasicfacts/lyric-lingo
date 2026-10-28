import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DATA, USER_AGENT } from "./env.mjs";

const LRCLIB = "https://lrclib.net/api";
const CACHE = path.join(DATA, "lyrics");

/** [mm:ss.xx] or [mm:ss:xx] timestamps, possibly several per line. */
const STAMP = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;

export function parseLrc(text) {
  const out = [];
  for (const raw of (text || "").split("\n")) {
    const stamps = [...raw.matchAll(STAMP)];
    if (!stamps.length) continue;
    const body = raw.replace(STAMP, "").trim();
    for (const m of stamps) {
      const minutes = Number(m[1]);
      const seconds = Number(m[2]);
      const frac = m[3] ? Number(m[3].padEnd(3, "0")) / 1000 : 0;
      out.push({ t: minutes * 60 + seconds + frac, text: body });
    }
  }
  // Word-synced lyrics repeat lines with <mm:ss.xx> tags inside the text.
  return out
    .map((s) => ({ ...s, text: s.text.replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, "").trim() }))
    .filter((s) => s.text.length || true)
    .sort((a, b) => a.t - b.t);
}

/** Spread plain lines across the track so unsynced lyrics still scroll. */
export function spreadLines(plainLyrics, durationSeconds) {
  const lines = (plainLyrics || "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (!lines.length) return [];
  const end = Math.max(20, (durationSeconds || lines.length * 4) - 4);
  const step = end / lines.length;
  return lines.map((text, i) => ({ t: +(i * step).toFixed(2), text }));
}

function normalize(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

async function lrclib(pathname, params) {
  const url = `${LRCLIB}/${pathname}?${new URLSearchParams(params)}`;
  const res = await fetch(url, {
    headers: { "user-agent": USER_AGENT, accept: "application/json" },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`LRCLIB ${pathname} failed (${res.status})`);
  return res.json();
}

/**
 * Look a track up on LRCLIB. Tries the exact get endpoint first, then search
 * and picks the closest duration with the same artist. Returns
 * { segments, source } or null when nothing usable exists.
 */
export async function findLyrics({ title, artist, album, durationMs }) {
  const duration = durationMs ? Math.round(durationMs / 1000) : undefined;
  const cleanTitle = (title || "")
    .replace(/\s*[([].*?(official|lyrics?|video|audio|remaster\w*|version|edit).*?[)\]]/gi, "")
    .replace(/\s+-\s+.*$/, "")
    .trim();

  const candidates = [];
  const exact = await lrclib("get", {
    artist_name: artist || "",
    track_name: cleanTitle,
    ...(album ? { album_name: album } : {}),
    ...(duration ? { duration } : {}),
  }).catch(() => null);
  if (exact) candidates.push(exact);

  if (!exact || (!exact.syncedLyrics && !exact.plainLyrics)) {
    const found = await lrclib("search", {
      track_name: cleanTitle,
      ...(artist ? { artist_name: artist } : {}),
    }).catch(() => []);
    const list = Array.isArray(found) ? found : (found?.data ?? []);
    const scored = list
      .map((item) => {
        const titleHit = normalize(item.trackName) === normalize(cleanTitle) ? 10 : 0;
        const artistHit = normalize(item.artistName).includes(normalize(artist || "")) ? 6 : 0;
        const durationHit =
          duration && Math.abs((item.duration || 0) - duration) < 4 ? 6 : 0;
        const syncedHit = item.syncedLyrics ? 5 : 0;
        return { item, score: titleHit + artistHit + durationHit + syncedHit };
      })
      .sort((a, b) => b.score - a.score);
    for (const { item } of scored.slice(0, 3)) {
      if (!candidates.some((c) => c.id === item.id)) candidates.push(item);
    }
  }

  for (const item of candidates) {
    if (item.instrumental) {
      return { segments: [], source: "lrclib", instrumental: true };
    }
    if (item.syncedLyrics) {
      const segments = parseLrc(item.syncedLyrics);
      if (segments.length) {
        return { segments, source: "lrclib-synced", instrumental: false };
      }
    }
    if (item.plainLyrics) {
      const segments = spreadLines(item.plainLyrics, item.duration);
      if (segments.length) {
        return { segments, source: "lrclib-estimated", instrumental: false };
      }
    }
  }
  return null;
}

export function cacheKey({ title, artist, durationMs }) {
  return (
    normalize(`${artist} ${title} ${durationMs || ""}`).replace(/\s+/g, "-") ||
    "unknown"
  );
}

export async function readCache(key) {
  try {
    return JSON.parse(await readFile(path.join(CACHE, `${key}.json`), "utf8"));
  } catch {
    return null;
  }
}

export async function writeCache(key, value) {
  await mkdir(CACHE, { recursive: true });
  await writeFile(path.join(CACHE, `${key}.json`), JSON.stringify(value));
}
