import { readFile } from "node:fs/promises";
import path from "node:path";

export const ROOT = path.resolve(import.meta.dirname, "..");
export const DATA = path.join(ROOT, "data");

/**
 * Minimal .env reader. Values already present in the real environment win,
 * so a shell export or a hosting platform setting overrides the file.
 */
export async function loadEnv() {
  let text = "";
  try {
    text = await readFile(path.join(ROOT, ".env"), "utf8");
  } catch {
    return;
  }
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

export const hasSpotify = () =>
  Boolean(process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET);

export const hasLLM = () => Boolean(process.env.DEEPSEEK_API_KEY);

export const PORT = Number(process.env.PORT || 8899);

export const REDIRECT_URI =
  process.env.SPOTIFY_REDIRECT_URI || `http://127.0.0.1:${PORT}/callback`;

export const USER_AGENT =
  "lyric-lingo/1.0 (local language-learning companion)";
