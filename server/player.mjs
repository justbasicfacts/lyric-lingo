import { execFile } from "node:child_process";
import { createHash } from "node:crypto";

/**
 * Reads the local Spotify desktop client over MPRIS (D-Bus). This needs no
 * login, no API key and no Premium: whatever the app is playing is right there,
 * including the playback position, which is exactly what lyric sync needs.
 */
const DBUS =
  process.env.DBUS_SESSION_BUS_ADDRESS ||
  `unix:path=/run/user/${typeof process.getuid === "function" ? process.getuid() : 1000}/bus`;

const ENV = { ...process.env, DBUS_SESSION_BUS_ADDRESS: DBUS };

const PLAYERS = (process.env.MPRIS_PLAYERS || "spotify")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function playerctl(args, timeout = 4000) {
  return new Promise((resolve) => {
    execFile("playerctl", args, { env: ENV, timeout }, (err, stdout) => {
      resolve(err ? null : stdout.trim());
    });
  });
}

async function firstPlayer() {
  const names = (await playerctl(["-l"])) || "";
  const list = names.split("\n").map((n) => n.trim()).filter(Boolean);
  for (const wanted of PLAYERS) {
    const hit = list.find((n) => n === wanted || n.startsWith(`${wanted}.`));
    if (hit) return hit;
  }
  return null;
}

const FORMAT = [
  "{{status}}",
  "{{artist}}",
  "{{title}}",
  "{{album}}",
  "{{mpris:length}}",
  "{{mpris:artUrl}}",
  "{{position}}",
].join("\u001f");

/**
 * @returns {Promise<null | { track: object, playing: boolean, positionMs: number }>}
 */
export async function mprisNowPlaying() {
  const player = await firstPlayer();
  if (!player) return null;

  const raw = await playerctl(["-p", player, "metadata", "--format", FORMAT]);
  if (!raw) return null;

  const [status, artist, title, album, length, artUrl, position] = raw.split("\u001f");
  if (!title || title === "Spotify" || title === "Advertisement") return null;

  const durationMs = Math.round(Number(length) / 1000) || 0;
  const positionMs = Math.round(Number(position) / 1000) || 0;
  const id =
    "mpris-" +
    createHash("sha1")
      .update(`${artist}|${title}|${album}|${durationMs}`)
      .digest("hex")
      .slice(0, 16);

  return {
    player,
    playing: status === "Playing",
    positionMs,
    track: {
      id,
      title,
      artist: artist || "",
      album: album || "",
      image: artUrl && /^https?:\/\//.test(artUrl) ? artUrl : null,
      durationMs,
      url: null,
      demo: false,
      source: "mpris",
    },
  };
}

export async function mprisSeek(positionMs) {
  const player = await firstPlayer();
  if (!player) return false;
  const seconds = (Math.max(0, positionMs) / 1000).toFixed(3);
  return (await playerctl(["-p", player, "position", seconds])) !== null;
}

export async function mprisPause() {
  const player = await firstPlayer();
  if (!player) return false;
  return (await playerctl(["-p", player, "pause"])) !== null;
}

export async function mprisPlay() {
  const player = await firstPlayer();
  if (!player) return false;
  return (await playerctl(["-p", player, "play"])) !== null;
}

export async function mprisActive() {
  return (await firstPlayer()) !== null;
}
