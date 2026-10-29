import { execFile } from "node:child_process";
import { createHash } from "node:crypto";

/**
 * Reads whatever media player is running on this machine over MPRIS (D-Bus).
 * Spotify, a browser playing YouTube, VLC, mpv, Rhythmbox, Tidal, they all
 * publish the same interface, so one reader covers every app. No login, no API
 * key, and the playback position comes along for free, which lyric sync needs.
 */
const DBUS =
  process.env.DBUS_SESSION_BUS_ADDRESS ||
  `unix:path=/run/user/${typeof process.getuid === "function" ? process.getuid() : 1000}/bus`;

const ENV = { ...process.env, DBUS_SESSION_BUS_ADDRESS: DBUS };

/**
 * When several players are open, this order decides who wins a tie. Unlisted
 * players still show up in the picker, they just rank after these.
 */
const PREFERRED = (
  process.env.MPRIS_PLAYERS ||
  "spotify,chromium,chrome,brave,firefox,vivaldi,opera,mpv,vlc,tidal,deezer,cider,strawberry,rhythmbox,elisa,lollypop,clementine,audacious"
)
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

function playerctl(args, timeout = 5000) {
  return new Promise((resolve) => {
    execFile("playerctl", args, { env: ENV, timeout }, (err, stdout) => {
      resolve(err ? null : stdout.trim());
    });
  });
}

/** chromium.instance470868 -> Chrome, spotify -> Spotify, mpv -> mpv */
export function playerLabel(name) {
  const base = name.split(".")[0].toLowerCase();
  const table = {
    spotify: "Spotify",
    chromium: "Chrome",
    chrome: "Chrome",
    "brave-browser": "Brave",
    brave: "Brave",
    firefox: "Firefox",
    vivaldi: "Vivaldi",
    opera: "Opera",
    mpv: "mpv",
    vlc: "VLC",
    tidal: "Tidal",
    deezer: "Deezer",
    cider: "Cider",
    strawberry: "Strawberry",
    rhythmbox: "Rhythmbox",
    elisa: "Elisa",
    lollypop: "Lollypop",
    clementine: "Clementine",
    audacious: "Audacious",
  };
  return table[base] || base.charAt(0).toUpperCase() + base.slice(1);
}

/** Browsers can play anything, so their label is only the app name. */
export const isBrowser = (name) =>
  /^(chromium|chrome|brave|firefox|vivaldi|opera|edge)/i.test(name);

const FORMAT = [
  "{{status}}",
  "{{artist}}",
  "{{title}}",
  "{{album}}",
  "{{mpris:length}}",
  "{{mpris:artUrl}}",
  "{{position}}",
].join("\u001f");

const trackId = (artist, title, durationMs) =>
  "mpris-" +
  createHash("sha1")
    .update(`${artist}|${title}|${durationMs}`)
    .digest("hex")
    .slice(0, 16);

async function readPlayer(name) {
  const raw = await playerctl(["-p", name, "metadata", "--format", FORMAT]);
  if (!raw) return null;

  const [status, artist, title, album, length, artUrl, position] = raw.split("\u001f");
  if (!title) return null;
  if (/^(spotify|advertisement)$/i.test(title.trim())) return null;

  const durationMs = Math.round(Number(length) / 1000) || 0;
  const positionMs = Math.round(Number(position) / 1000) || 0;
  const label = playerLabel(name);

  // Browsers hand out their artwork as a local temp file, which a page cannot
  // load. Point the page at our own endpoint instead and let it proxy the file.
  let image = null;
  if (artUrl && /^https?:\/\//.test(artUrl)) {
    image = artUrl;
  } else if (artUrl && artUrl.startsWith("file://")) {
    const token = createHash("sha1")
      .update(`${artUrl}|${artist}|${title}`)
      .digest("hex")
      .slice(0, 8);
    image = `/api/art?player=${encodeURIComponent(name)}&v=${token}`;
  }

  return {
    player: name,
    label,
    browser: isBrowser(name),
    playing: status === "Playing",
    positionMs,
    track: {
      id: trackId(artist, title, durationMs),
      title,
      artist: artist || "",
      album: album || "",
      image,
      artUrl: artUrl || null,
      durationMs,
      url: null,
      demo: false,
      source: "mpris",
      player: name,
      playerLabel: label,
      browser: isBrowser(name),
    },
  };
}

/** Every MPRIS player with a track loaded, ranked by the preference order. */
export async function listPlayers() {
  const names = await playerctl(["-l"]);
  if (!names) return [];

  const list = names.split("\n").map((n) => n.trim()).filter(Boolean);
  const rank = (name) => {
    const base = name.split(".")[0].toLowerCase();
    const index = PREFERRED.findIndex((p) => base === p || base.startsWith(p));
    return index === -1 ? PREFERRED.length : index;
  };
  list.sort((a, b) => rank(a) - rank(b));

  const out = [];
  for (const name of list) {
    const entry = await readPlayer(name).catch(() => null);
    if (entry) out.push(entry);
  }
  return out;
}

/**
 * Pick the player to follow: whatever is actually playing wins, otherwise the
 * first one in preference order that has a track loaded.
 */
export function pickPlayer(entries, requested) {
  if (!entries.length) return null;
  if (requested) {
    const exact = entries.find((e) => e.player === requested);
    if (exact) return exact;
    const loose = entries.find((e) => e.player.startsWith(requested));
    if (loose) return loose;
  }
  const playing = entries.filter((e) => e.playing);
  return playing[0] || entries[0];
}

export async function mprisNowPlaying(requested) {
  return pickPlayer(await listPlayers(), requested);
}

/**
 * Resolve the player a transport call should touch. An explicit request is
 * honoured exactly or not at all: if that player is gone, the call does
 * nothing. Substituting another app here would pause somebody else's music.
 */
async function target(requested) {
  const names = (await playerctl(["-l"])) || "";
  const list = names.split("\n").map((n) => n.trim()).filter(Boolean);

  if (requested) {
    const exact = list.find((n) => n === requested);
    if (exact) return exact;
    const loose = list.find((n) => n.startsWith(requested));
    return loose || null;
  }
  const best = pickPlayer(await listPlayers(), null);
  return best?.player || null;
}

export async function mprisSeek(positionMs, requested) {
  const name = await target(requested);
  if (!name) return false;
  const seconds = (Math.max(0, positionMs) / 1000).toFixed(3);
  return (await playerctl(["-p", name, "position", seconds])) !== null;
}

export async function mprisPause(requested) {
  const name = await target(requested);
  if (!name) return false;
  return (await playerctl(["-p", name, "pause"])) !== null;
}

export async function mprisPlay(requested) {
  const name = await target(requested);
  if (!name) return false;
  return (await playerctl(["-p", name, "play"])) !== null;
}

export async function mprisActive() {
  const names = await playerctl(["-l"]);
  return Boolean(names && names.trim());
}
