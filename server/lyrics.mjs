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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function lrclib(pathname, params) {
  const url = `${LRCLIB}/${pathname}?${new URLSearchParams(params)}`;
  let lastStatus = 0;
  // LRCLIB is a free service run by volunteers: 429 and 503 happen, and a single
  // flaky reply used to look like "no lyrics for this song".
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, {
      headers: { "user-agent": USER_AGENT, accept: "application/json" },
    }).catch(() => null);
    if (!res) {
      lastStatus = 0;
      await sleep(400 * (attempt + 1));
      continue;
    }
    if (res.status === 404) return null;
    if (res.status === 429 || res.status >= 500) {
      lastStatus = res.status;
      await sleep(700 * (attempt + 1));
      continue;
    }
    if (!res.ok) throw new Error(`LRCLIB ${pathname} failed (${res.status})`);
    return res.json();
  }
  throw new Error(`LRCLIB ${pathname} unavailable (${lastStatus || "network error"})`);
}

const NOISE =
  /(official|lyrics?|video|audio|visuali[sz]er|remaster\w*|hd|4k|8k|hq|mv|m\/v|clip|explicit|performance|live (?:at|from|session)|full song|with lyrics)/i;

/**
 * Clean the noise out of a title and work out who the artist really is.
 * Streaming apps give clean metadata; YouTube gives "Artist - Song (Official
 * Video) (4K Remaster)" with the channel name as the artist, so a few
 * candidates are tried in order rather than trusting one guess.
 */
export function describeTrack({ title, artist }) {
  let text = (title || "").trim();

  // Bracket groups that only say what kind of upload this is.
  for (let i = 0; i < 4; i++) {
    const next = text.replace(/\s*[([][^)\]]*[)\]]/g, (group) =>
      NOISE.test(group) ? "" : group
    );
    if (next === text) break;
    text = next;
  }

  // Players that report a filename: "Song.mp4", "Artist - Song.mkv".
  text = text.replace(/\.(mp4|m4v|webm|mkv|avi|mov|mp3|m4a|flac|opus|wav|ogg)$/i, "");

  // "Song | Official Video" and "Song - Official Video" style tails.
  text = text.split(/\s+\|\s+/)[0];
  text = text.replace(/\s*[-–]\s*$/g, "").trim();

  let cleanArtist = (artist || "")
    .replace(/\s*-\s*Topic$/i, "")
    .replace(/VEVO$/i, "")
    .trim();
  if (/^various artists?$/i.test(cleanArtist)) cleanArtist = "";

  const split = text.split(/\s+[-–]\s+/);
  const lead = split.length > 1 ? split[0].trim() : "";
  const rest = split.length > 1 ? split.slice(1).join(" - ").trim() : text;

  const sameArtist = lead && cleanArtist && normalize(lead).includes(normalize(cleanArtist));
  const guesses = [];
  if (sameArtist) {
    guesses.push({ artist: cleanArtist, title: rest });
  } else {
    if (lead && !cleanArtist) guesses.push({ artist: lead, title: rest });
    if (cleanArtist) guesses.push({ artist: cleanArtist, title: rest });
    if (lead) guesses.push({ artist: lead, title: rest });
  }
  guesses.push({ artist: cleanArtist, title: text });
  guesses.push({ artist: "", title: rest });
  guesses.push({ artist: "", title: text });

  const seen = new Set();
  return guesses
    .filter((g) => g.title)
    .filter((g) => {
      const key = `${normalize(g.artist)}|${normalize(g.title)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/**
 * Look a track up on LRCLIB. Each artist/title guess gets an exact lookup, then
 * a search scored by title, artist, duration and whether the lyrics are synced.
 * Returns { segments, source } or null when nothing usable exists.
 */
export async function findLyrics({ title, artist, album, durationMs }) {
  const duration = durationMs ? Math.round(durationMs / 1000) : undefined;
  const guesses = describeTrack({ title, artist });
  const candidates = [];

  // Exact lookups for the first few guesses, best guess first.
  for (const guess of guesses.slice(0, 3)) {
    const exact = await lrclib("get", {
      artist_name: guess.artist || "",
      track_name: guess.title,
      ...(album ? { album_name: album } : {}),
      ...(duration ? { duration } : {}),
    }).catch(() => null);
    if (exact && !candidates.some((c) => c.id === exact.id)) candidates.push(exact);
  }

  // Then search, but only trust a hit that also looks right: an exact title, or
  // a close title backed by the artist or the track length. A loose title alone
  // matches half the catalogue, which is how "Song" finds a random song.
  for (const guess of guesses.slice(0, 2)) {
    const found = await lrclib("search", {
      track_name: guess.title,
      ...(guess.artist ? { artist_name: guess.artist } : {}),
    }).catch(() => []);
    const list = Array.isArray(found) ? found : (found?.data ?? []);
    const scored = list
      .map((item) => {
        const titleExact = normalize(item.trackName) === normalize(guess.title);
        const titleNear = normalize(item.trackName).includes(normalize(guess.title));
        const artistHit = Boolean(
          guess.artist && normalize(item.artistName).includes(normalize(guess.artist))
        );
        const durationNear = Boolean(
          duration && item.duration && Math.abs(item.duration - duration) <= 6
        );
        const ok =
          titleExact || (titleNear && (artistHit || durationNear)) || (artistHit && durationNear);
        const score =
          (titleExact ? 10 : titleNear ? 4 : 0) +
          (artistHit ? 6 : 0) +
          (durationNear ? 6 : 0) +
          (item.syncedLyrics ? 5 : 0);
        return { item, ok, score };
      })
      .filter((entry) => entry.ok)
      .sort((a, b) => b.score - a.score);
    for (const { item } of scored.slice(0, 3)) {
      if (!candidates.some((c) => c.id === item.id)) candidates.push(item);
    }
  }

  // A useful answer has more than a stray line. Keep a weak result as a last
  // resort rather than returning something that looks like a lyric to a chorus.
  let weak = null;
  for (const item of candidates) {
    const result = toSegments(item);
    if (!result) continue;
    if (result.instrumental) return result;
    if (result.segments.length >= 4) return result;
    if (!weak) weak = result;
  }
  return weak;
}

function toSegments(item) {
  if (item.instrumental) {
    return { segments: [], source: "lrclib", instrumental: true };
  }
  if (item.syncedLyrics) {
    const segments = parseLrc(item.syncedLyrics);
    if (segments.length) return { segments, source: "lrclib-synced", instrumental: false };
  }
  if (item.plainLyrics) {
    const segments = spreadLines(item.plainLyrics, item.duration);
    if (segments.length) return { segments, source: "lrclib-estimated", instrumental: false };
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
