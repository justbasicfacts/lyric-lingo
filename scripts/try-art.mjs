import { readArt } from "../server/art.mjs";
import { writeFile, unlink } from "node:fs/promises";

// 1. the art file Chrome reported earlier, if it is still around
const stale = await readArt("file:///tmp/.com.google.Chrome.XLZqhQ", "chromium.instance2");
console.log("chrome art file:", stale ? `${stale.type} ${stale.body.length} bytes` : "not found (session ended)");

// 2. a real image in a temp dir, through the plain path
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);
const tmp = "/tmp/lyric-lingo-art-test.png";
await writeFile(tmp, png);
const direct = await readArt(`file://${tmp}`, "chromium");
console.log("direct temp image:", direct ? `${direct.type} ${direct.body.length} bytes` : "FAILED");

// 3. things that must be refused
const outside = await readArt("file:///etc/passwd", "chromium");
console.log("outside allowed dirs:", outside ? "LEAKED" : "refused");
const notImage = "/tmp/lyric-lingo-not-image.txt";
await writeFile(notImage, "just text, not an image");
const refused = await readArt(`file://${notImage}`, "chromium");
console.log("non-image file:", refused ? "LEAKED" : "refused");
const httpUrl = await readArt("https://i.scdn.co/image/abc", "spotify");
console.log("http url (not our job):", httpUrl ? "unexpected" : "ignored");

await unlink(tmp);
await unlink(notImage);
