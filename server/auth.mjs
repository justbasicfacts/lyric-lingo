import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DATA, REDIRECT_URI } from "./env.mjs";

const AUTHORIZE = "https://accounts.spotify.com/authorize";
const TOKEN = "https://accounts.spotify.com/api/token";
const SCOPES = [
  "user-read-currently-playing",
  "user-read-playback-state",
  "user-modify-playback-state",
];
const STORE = path.join(DATA, "tokens.json");

let tokens = null;
let pending = new Map();

const base64url = (buf) =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export async function loadTokens() {
  try {
    tokens = JSON.parse(await readFile(STORE, "utf8"));
  } catch {
    tokens = null;
  }
  return tokens;
}

export const isAuthed = () => Boolean(tokens?.refresh_token || tokens?.access_token);

export async function saveTokens(next) {
  tokens = next;
  await mkdir(DATA, { recursive: true });
  await writeFile(STORE, JSON.stringify(next, null, 2), { mode: 0o600 });
}

export function clearTokens() {
  tokens = null;
  return writeFile(STORE, "{}", { mode: 0o600 }).catch(() => {});
}

export function authorizationUrl() {
  const verifier = base64url(randomBytes(48));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const state = base64url(randomBytes(12));
  pending.set(state, { verifier, at: Date.now() });

  // Drop stale handshakes so the map cannot grow forever.
  for (const [key, value] of pending) {
    if (Date.now() - value.at > 10 * 60_000) pending.delete(key);
  }

  const params = new URLSearchParams({
    client_id: process.env.SPOTIFY_CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    code_challenge_method: "S256",
    code_challenge: challenge,
    state,
    scope: SCOPES.join(" "),
    show_dialog: "false",
  });
  return `${AUTHORIZE}?${params}`;
}

export async function exchangeCode(code, state) {
  const entry = pending.get(state);
  if (!entry) throw new Error("Unknown login state. Start again from the login button.");
  pending.delete(state);

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    client_id: process.env.SPOTIFY_CLIENT_ID,
    code_verifier: entry.verifier,
  });

  const res = await fetch(TOKEN, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(process.env.SPOTIFY_CLIENT_SECRET
        ? {
            authorization:
              "Basic " +
              Buffer.from(
                `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
              ).toString("base64"),
          }
        : {}),
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`Token exchange failed (${res.status}): ${await res.text()}`);
  }
  const json = await res.json();
  await saveTokens({
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at: Date.now() + (json.expires_in || 3600) * 1000,
    scope: json.scope,
  });
  return json;
}

/** Valid access token, refreshed when it is about to expire. */
export async function accessToken() {
  if (!tokens) await loadTokens();
  if (!tokens?.access_token) throw new Error("Not logged in to Spotify");

  if (Date.now() < (tokens.expires_at || 0) - 60_000) return tokens.access_token;
  if (!tokens.refresh_token) throw new Error("Spotify session expired, log in again");

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
    client_id: process.env.SPOTIFY_CLIENT_ID,
  });
  const res = await fetch(TOKEN, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(process.env.SPOTIFY_CLIENT_SECRET
        ? {
            authorization:
              "Basic " +
              Buffer.from(
                `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
              ).toString("base64"),
          }
        : {}),
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 400 || res.status === 401) await clearTokens();
    throw new Error(`Token refresh failed (${res.status}): ${text.slice(0, 160)}`);
  }
  const json = await res.json();
  await saveTokens({
    access_token: json.access_token,
    refresh_token: json.refresh_token || tokens.refresh_token,
    expires_at: Date.now() + (json.expires_in || 3600) * 1000,
    scope: json.scope || tokens.scope,
  });
  return json.access_token;
}
