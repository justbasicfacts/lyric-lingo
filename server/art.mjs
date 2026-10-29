import { readdir, readFile, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Album art from a local player.
 *
 * Browsers write the artwork of the playing tab to a temp file and report it as
 * a file:// URL, which a web page cannot load. Worse, a sandboxed browser
 * (Flatpak, Snap, Chrome's own namespace) writes that file inside its private
 * filesystem, so the path does not exist for anyone outside. The file is still
 * reachable through /proc/<pid>/root, which is what this module uses.
 *
 * Only image files inside temp and cache directories are ever read, so a player
 * cannot talk the server into handing out arbitrary local files.
 */
const UID = typeof process.getuid === "function" ? process.getuid() : 1000;

const ALLOWED = [
  "/tmp",
  "/var/tmp",
  "/dev/shm",
  os.tmpdir(),
  `/run/user/${UID}`,
  path.join(os.homedir(), ".cache"),
];

const MAX_BYTES = 8 * 1024 * 1024;

const inside = (file, dir) => file === dir || file.startsWith(dir + path.sep);

function sniff(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  if (
    buf.subarray(0, 4).toString("latin1") === "RIFF" &&
    buf.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "image/webp";
  }
  if (buf[0] === 0x42 && buf[1] === 0x4d) return "image/bmp";
  if (buf.subarray(4, 12).toString("latin1").includes("ftypavif")) return "image/avif";
  return null;
}

/** chromium -> chrome|chromium, brave -> brave, and so on. */
function familyMatcher(playerName) {
  const base = (playerName || "").split(".")[0].toLowerCase();
  if (/^(chromium|chrome)$/.test(base)) return /chrom/;
  if (base === "brave" || base === "brave-browser") return /brave/;
  if (base === "firefox") return /firefox/;
  return new RegExp(base.replace(/[^a-z0-9]/g, ""), "i");
}

let pidCache = { at: 0, pids: [] };

async function candidatePids(playerName) {
  if (Date.now() - pidCache.at < 5000 && pidCache.pids.length) return pidCache.pids;
  const matcher = familyMatcher(playerName);
  const pids = [];
  let entries = [];
  try {
    entries = await readdir("/proc");
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const comm = (await readFile(`/proc/${entry}/comm`, "utf8")).trim();
      if (matcher.test(comm)) pids.push(entry);
    } catch {
      /* process vanished */
    }
  }
  pidCache = { at: Date.now(), pids };
  return pids;
}

async function readIfImage(file) {
  const info = await stat(file);
  if (!info.isFile() || info.size === 0 || info.size > MAX_BYTES) return null;
  const body = await readFile(file);
  const type = sniff(body);
  return type ? { body, type } : null;
}

/**
 * @param {string} rawUrl the player's mpris:artUrl
 * @param {string} playerName the MPRIS name the art belongs to
 * @returns {Promise<null | { body: Buffer, type: string }>}
 */
export async function readArt(rawUrl, playerName) {
  if (!rawUrl || !rawUrl.startsWith("file://")) return null;

  let logical;
  try {
    logical = decodeURIComponent(new URL(rawUrl).pathname);
  } catch {
    return null;
  }
  if (!ALLOWED.some((dir) => inside(logical, dir))) return null;

  // The plain path, when the browser is not sandboxed.
  try {
    const direct = await realpath(logical);
    if (ALLOWED.some((dir) => inside(direct, dir))) {
      const image = await readIfImage(direct);
      if (image) return image;
    }
  } catch {
    /* fall through to the sandboxed lookup */
  }

  // The same file seen from inside the browser's own filesystem namespace.
  for (const pid of await candidatePids(playerName)) {
    try {
      const image = await readIfImage(`/proc/${pid}/root${logical}`);
      if (image) return image;
    } catch {
      /* try the next process */
    }
  }
  return null;
}
