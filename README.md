# Lyric Lingo

Follows whatever is playing on this computer and shows the lyric line that is
playing right now, next to a translation into the language you are learning.
Click any line to hear it again, click a word to look it up.

It follows any player that publishes MPRIS, which on Linux is nearly all of them:
the Spotify app, YouTube or YouTube Music in a browser tab, VLC, mpv, Rhythmbox,
Strawberry, Elisa, Tidal, Deezer. One reader, every app.

![Lyric Lingo](docs/screenshot.png)

## Why this is a companion app and not a plugin

Spotify closed its in-client app platform in 2018, and browsers do not let a page
read another tab's media either. There is no supported way to put a panel inside
the player window. So this runs as a local web page next to the player:

- The app that plays the music keeps doing that, untouched.
- This app reads the track and the playback position over MPRIS (D-Bus), so it
  needs no login, no API key and no Premium.
- Lyrics come from LRCLIB, which supplies time-stamped (LRC) lyrics.
- Translations come from DeepSeek, one call per song, cached on disk.

## What "works with YouTube" means

A browser publishes an MPRIS entry while a tab is actually playing, so a YouTube
video is readable like any other track. Two things make that usable:

- The title needs cleaning. YouTube reports the video title
  ("Artist - Song (Official Video) (4K Remaster)") with the channel as the artist.
  `server/lyrics.mjs` strips the decoration, splits "Artist - Song", drops
  "- Topic" and VEVO suffixes, and tries the plausible artist/title pairs.
- Browsers expose only what the page tells them. A video without a media session,
  a stalled tab, or a tab that is not playing shows up as nothing at all.

- The same path covers local media files: players that report a filename
  ("Artist - Song.mp4") get the extension stripped before the lookup.

Album art needs one more step. A browser hands out the artwork of the playing tab
as a `file://` path to a temp file, and a page cannot load that. Sandboxed
browsers (Flatpak, Snap) write it inside their own filesystem, where the path does
not even exist from outside. `/api/art` reads it through `/proc/<pid>/root`, but
only for image files inside temp and cache directories, with a size cap.

## Requirements

- Linux with a desktop session (MPRIS is how the player is read)
- Any MPRIS player: Spotify desktop, a browser, VLC, mpv, Rhythmbox...
- `playerctl` (`sudo apt install playerctl`)
- Node 20 or newer
- A DeepSeek API key for the translations (optional, the lyrics still work)

## Setup

    git clone https://github.com/justbasicfacts/lyric-lingo.git
    cd lyric-lingo
    cp .env.example .env      # then fill in DEEPSEEK_API_KEY
    node server/index.mjs

Open http://127.0.0.1:8899 and press play anywhere in Spotify, in a browser tab,
or in any other player.

## Using it

- The big line is what you are hearing, the smaller green line is its translation.
- The lyric column glides like Spotify's: the active line grows and lifts into
  place, the lines it passes shrink and fade back.
- Click any line in the karaoke view or the "All lines" list to jump there and
  hear it again. This seeks the actual Spotify playback.
- Pause, Play, Back 5s and Forward 5s drive the real player, not a local
  simulation. The music in Spotify stops when you press Pause. This works
  without Spotify Premium because it goes through the local app.
- Click a word to get its dictionary form and meaning. Words collect under the
  "Words" tab and stay there between visits (local storage).
- "Hide translation" (or the T key) hides the translations so you can test
  yourself. Arrow keys jump five seconds, space pauses.
- If more than one player is open, a "Playing in" picker appears. Automatic
  follows whatever is actually playing; pick one to pin the page to it. Pause,
  Play and the seeks then go to that player and to no other app.
- "Translate to" changes the target language. Every language is cached per song,
  so switching back is instant and free.
- No Spotify running? Open http://127.0.0.1:8899/?demo=1 for a demo track with
  made up lyrics, or /?preview=Sonne&artist=Rammstein to look up any song by name.

## Configuration

`.env` keys, all optional except the DeepSeek one for translations:

| Key | Meaning |
| --- | --- |
| `DEEPSEEK_API_KEY` | Key for translations. Without it only original lyrics appear. |
| `DEEPSEEK_BASE_URL` | Defaults to `https://api.deepseek.com`. |
| `DEEPSEEK_MODEL` | Defaults to `deepseek-chat`. |
| `PORT` | Defaults to `8899`. |
| `DEFAULT_TARGET_LANG` | Defaults to `English`. |
| `MPRIS_PLAYERS` | Preference order when several players are open, e.g. `spotify,brave`. Anything not listed still shows up, just ranked last. |

Spotify's Web API is supported as a fallback, for the case where music plays on
another device (phone, another computer) and nothing is playing locally. Those
keys are `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` and
`SPOTIFY_REDIRECT_URI`. The redirect URI must be registered in the Spotify app
dashboard, and the account needs to be one of the app's allowed users. When the
local app is playing, MPRIS is used and the Web API is never touched. The
"Connect Spotify" button only shows up when those keys are set.

## Optional: start it with the session

    mkdir -p ~/.config/systemd/user
    cp systemd/lyric-lingo.service ~/.config/systemd/user/
    systemctl --user daemon-reload
    systemctl --user enable --now lyric-lingo.service

## Files

    server/index.mjs     HTTP server, routes, page compilation
    server/player.mjs    MPRIS reader and transport controls (playerctl)
    server/art.mjs       album art from local and sandboxed players
    server/lyrics.mjs    LRCLIB lookup, LRC parsing, plain lyric fallback
    server/translate.mjs DeepSeek translation, disk cache
    server/auth.mjs      optional Spotify Web API OAuth (PKCE)
    public/              the page: index.html, app.js, styles.css
    scripts/try-titles.mjs  check how a messy player title gets parsed
    data/                caches: lyrics, translations, tokens (not in git)

## Notes and limits

- Word timing is line timing: a line lights up when it starts, it does not fill
  word by word. LRCLIB has word level timing for some tracks, and the parser
  strips those inline stamps, so the app can use them later.
- If LRCLIB has no time stamps for a song, the plain lyrics are spread evenly
  over the track length and marked with a small tilde, so treat those timings as
  approximate.
- Translation is machine output. It is good for meaning, not for poetry.
- The LRCLIB and DeepSeek calls happen on first play of a song; after that the
  answer comes from `data/`.
- Linux only for now. The player is read over MPRIS, which Windows and macOS do
  not have. A port would need a different now-playing source.

## If it does not work

- "No player is running on this computer": start Spotify, or play something in a
  browser tab. The Spotify *web* player works through the browser, not through a
  Spotify MPRIS entry, so keep the tab playing rather than muting it away.
- YouTube shows no lyrics: the lookup needs a recognisable artist and title. Talk
  videos, mixes and live streams have neither, and a wrong match is worse than
  none, so nothing is shown.
- A player is listed but does nothing: browsers leave stale MPRIS names behind
  when a media session ends. They cannot be read or controlled, so they are
  skipped; reload the page and the picker settles.
- Art is missing for a browser track: the artwork file only exists while that tab
  is playing, and some browsers never write one. The page shows a placeholder
  instead of a broken image.
- The page shows "Lernlied (demo)": that is the demo fallback. The transport
  buttons then only move the demo page, they cannot touch real playback.
- The music does not stop when you press Pause: check
  `playerctl -p spotify status` in a terminal. If it says no players found, the
  app is closed or its D-Bus interface is sandboxed away; `playerctl -l` lists
  what is visible.
- The page looks old after a change: the small build id next to the title shows
  what the browser actually runs. It reloads itself when the server reports a
  newer build.

## License

MIT, see [LICENSE](LICENSE).
