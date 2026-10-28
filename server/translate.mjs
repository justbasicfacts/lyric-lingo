import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DATA, hasLLM } from "./env.mjs";

function endpoint() {
  if (process.env.DEEPSEEK_API_URL) return process.env.DEEPSEEK_API_URL;
  const base = (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/+$/, "");
  return base.endsWith("/v1") || base.endsWith("/chat/completions")
    ? `${base}/chat/completions`.replace("/v1/chat/completions", "/chat/completions")
    : `${base}/chat/completions`;
}
const API = endpoint();
const MODEL = process.env.DEEPSEEK_MODEL || "deepseek-chat";
const CACHE = path.join(DATA, "translations");

async function chat(messages, { json = true, temperature = 0.2, maxTokens = 4000 } = {}) {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error("DEEPSEEK_API_KEY is not set");

  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(API, {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL,
          messages,
          temperature,
          max_tokens: maxTokens,
          ...(json ? { response_format: { type: "json_object" } } : {}),
        }),
      });
      if (res.status === 429 || res.status >= 500) {
        throw new Error(`DeepSeek busy (${res.status})`);
      }
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`DeepSeek failed (${res.status}): ${body.slice(0, 200)}`);
      }
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content ?? "";
      return text;
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
  throw lastError;
}

function parseJson(text) {
  const trimmed = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start !== -1 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error("DeepSeek returned something that is not JSON");
  }
}

const hash = (value) => createHash("sha1").update(value).digest("hex");

async function readCache(key) {
  try {
    return JSON.parse(await readFile(path.join(CACHE, `${key}.json`), "utf8"));
  } catch {
    return null;
  }
}

async function writeCache(key, value) {
  await mkdir(CACHE, { recursive: true });
  await writeFile(path.join(CACHE, `${key}.json`), JSON.stringify(value));
}

const SYSTEM = (target) => `You translate song lyrics for someone learning ${target}.
You get a JSON array of lyric lines from one song. Reply with a JSON object:
{"sourceLanguage":"<name of the language the lyrics are in>","lines":["<line 1>", "..."]}

Rules:
- Exactly one entry in "lines" per input line, in the same order, same count.
- Translate meaning naturally, the way a native speaker would say it, not word for word.
- Keep the translator's line honest: no commentary, no notes, no romanization.
- Names, brands and onomatopoeia stay as they are. A repeated hook repeats the same way.
- Empty input line gives an empty string. Instrumental markers like [Chorus] become the same marker in ${target}.`;

function chunks(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * Translate a whole song's lines in one call. Results are cached on disk per
 * track so replaying a song is instant and does not spend tokens twice.
 */
export async function translateLines(lines, target, cacheId) {
  const key = hash(`${target}|${cacheId}|${lines.join("\n")}`);
  const hit = await readCache(key);
  if (hit) return hit;

  if (!hasLLM()) {
    return { sourceLanguage: null, lines: lines.map(() => ""), offline: true };
  }

  const translated = [];
  let sourceLanguage = null;
  for (const part of chunks(lines, 60)) {
    const text = await chat([
      { role: "system", content: SYSTEM(target) },
      { role: "user", content: JSON.stringify(part) },
    ]);
    const data = parseJson(text);
    const got = Array.isArray(data?.lines) ? data.lines : [];
    sourceLanguage = sourceLanguage || data?.sourceLanguage || null;
    for (let i = 0; i < part.length; i++) {
      const value = got[i];
      translated.push(typeof value === "string" ? value.trim() : "");
    }
  }

  const result = { sourceLanguage, lines: translated };
  await writeCache(key, result);
  return result;
}

/** One word in context, for the tap-a-word vocabulary list. */
export async function translateWord(word, contextLine, target) {
  const key = hash(`word|${target}|${word}|${contextLine}`);
  const hit = await readCache(key);
  if (hit) return hit;
  if (!hasLLM()) return { word, translation: "", meaning: "", base: word, offline: true };

  const text = await chat(
    [
      {
        role: "system",
        content: `You explain one word to a ${target} speaker learning the song's language.
Reply with JSON: {"base":"<dictionary form of the word>","translation":"<short ${target} translation>","meaning":"<at most 8 words on how it is used in this line>"}
No extra keys, no commentary.`,
      },
      { role: "user", content: JSON.stringify({ word, line: contextLine }) },
    ],
    { maxTokens: 300 }
  );
  const data = parseJson(text);
  const result = {
    word,
    base: data?.base || word,
    translation: data?.translation || "",
    meaning: data?.meaning || "",
  };
  await writeCache(key, result);
  return result;
}
