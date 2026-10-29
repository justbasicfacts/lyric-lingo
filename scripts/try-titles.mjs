import { describeTrack, findLyrics } from "../server/lyrics.mjs";

const cases = [
  { title: "Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)", artist: "Rick Astley" },
  { title: "Nena - 99 Luftballons (Official Video)", artist: "Nena" },
  { title: "Deutschland", artist: "Rammstein" },
  { title: "Kanonenfieber - History Fever: Battle and Storm", artist: "Kanonenfieber" },
  { title: "Wir sind Helden - Denkmal [Official Video]", artist: "Wir sind Helden - Topic" },
  { title: "Song | Official Music Video", artist: "SomeChannel" },
];

for (const c of cases) {
  const guesses = describeTrack(c);
  console.log("IN   ", JSON.stringify(c));
  console.log("GUESS", guesses.slice(0, 3).map((g) => `${g.artist || "?"} :: ${g.title}`).join("   |   "));
  const found = await findLyrics(c).catch((e) => ({ error: e.message }));
  console.log(
    "FOUND",
    found ? `${found.source} lines=${found.segments?.length ?? 0}` : "null",
    found?.error || ""
  );
  console.log("");
}
