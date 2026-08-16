// One-off/rerunnable maintenance script: finds a real cover image for every
// book that only has the sheet-sync placeholder cover (needsCoverImage: true)
// and replaces it with a real one.
//
// Source: Open Library's public Search + Covers APIs (openlibrary.org) - free,
// no API key, no scraping. (Amazon was the original ask, but Amazon actively
// blocks automated fetches and its ToS forbids scraping it - not something to
// do even if it "worked". Google Books' API was tried first but its shared
// anonymous daily quota was already exhausted from this network.)
//
// Matching strategy, to avoid attaching the WRONG cover to a book:
//   1. Search Open Library by title only (author-constrained search is too
//      strict and misses a lot of real matches - typos, "Translated by X",
//      missing middle names, etc, same problem the catalog itself has).
//   2. Walk the top results in relevance order; only accept a candidate that
//      (a) has a cover image indexed at all, and (b) whose listed author(s)
//      fuzzy-match the book's stored author (typo/word-overlap tolerant,
//      same heuristic as scripts/dedupe-books.js).
//   3. No confident candidate in the top results -> skip the book entirely
//      and log it. We do not guess.
//
// For an accepted match: links directly to Open Library's own covers CDN
// (covers.openlibrary.org) for both image (-L size) and thumbnail (-M size)
// - both are the full cover proportionally scaled to a fixed width, not
// crops. No need to re-host these through imgbb: unlike user-uploaded covers,
// these already have a stable, public, permanent host (that's what Open
// Library's covers API is for), and skipping the re-upload sidesteps imgbb's
// rate limiting entirely for this run.
//
// Safe to re-run: only processes needsCoverImage: true books, and successful
// ones get that flag cleared, so an interrupted run resumes where it left
// off. "No confident match" books stay flagged (nothing to retry differently
// without more info) - see backfill-covers-nomatch.json for that list.
//
// Usage (from book-ocean-bd-server/):
//   node scripts/backfill-covers-openlibrary.js            # full run
//   BACKFILL_LIMIT=15 node scripts/backfill-covers-openlibrary.js   # test batch

require("dotenv").config();
const { MongoClient, ServerApiVersion } = require("mongodb");
const fs = require("fs");
const path = require("path");

const USER_AGENT = "BookOceanBD-CoverBackfill/1.0 (contact: bookoceanbd@gmail.com)";

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.6kqiq.mongodb.net/?retryWrites=true&w=majority`;

const LOG_PATH = path.join(__dirname, "backfill-covers.log");
const FAIL_PATH = path.join(__dirname, "backfill-covers-failures.json");
const NOMATCH_PATH = path.join(__dirname, "backfill-covers-nomatch.json");

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_PATH, line + "\n");
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// --- author fuzzy match (same approach as dedupe-books.js) ---
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
    dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
  }
  return dp[m][n];
}
function cleanWords(s) {
  return (s || "").toLowerCase().replace(/\(.*?\)/g, " ").replace(/[^a-z\s]/g, " ")
    .split(/\s+/).filter((w) => w.length >= 3);
}
function authorsSimilar(a, b) {
  const wa = cleanWords(a), wb = cleanWords(b);
  if (wa.length === 0 || wb.length === 0) return false;
  if (wa.join("") === wb.join("")) return true;
  let shared = 0;
  for (const w1 of wa) for (const w2 of wb) {
    if (w1 === w2) { shared++; continue; }
    const d = levenshtein(w1, w2);
    if (Math.max(w1.length, w2.length) >= 4 && d / Math.max(w1.length, w2.length) <= 0.3) shared++;
  }
  return shared >= 1 && shared / Math.min(wa.length, wb.length) >= 0.5;
}

async function findCover(title, author) {
  const url = `https://openlibrary.org/search.json?title=${encodeURIComponent(title)}&limit=8&fields=title,author_name,cover_i`;
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`Open Library search HTTP ${res.status}`);
  const json = await res.json();
  const docs = json.docs || [];
  for (const d of docs) {
    if (!d.cover_i) continue;
    const authorMatch = (d.author_name || []).some((a) => authorsSimilar(a, author));
    if (authorMatch) return { coverId: d.cover_i, matchedTitle: d.title, matchedAuthor: d.author_name };
  }
  return null;
}

// quick check that Open Library actually has a real cover at this id (not a
// broken/missing one) before writing the URL into the catalog. Has to be a
// GET, not HEAD - Open Library's covers CDN doesn't send Content-Length on
// HEAD responses, so a HEAD-based size check always looks like "missing".
async function coverExists(url) {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) return false;
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.length > 1000; // Open Library serves a tiny placeholder image for missing covers
}

async function run() {
  const client = new MongoClient(uri, { serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true } });
  await client.connect();
  const books = client.db("bookOceanBdDB").collection("books");

  const docs = await books.find({ needsCoverImage: true }).toArray();
  const limit = parseInt(process.env.BACKFILL_LIMIT || "0", 10);
  const queue = limit > 0 ? docs.slice(0, limit) : docs;
  const total = queue.length;
  log(`Found ${total} books needing a cover image.`);

  let done = 0, matched = 0, noMatch = 0, failed = 0;
  const failures = [];
  const noMatches = [];

  for (const book of queue) {
    done++;
    try {
      const found = await findCover(book.name, book.author);
      if (!found) {
        noMatch++;
        noMatches.push({ id: book._id.toString(), name: book.name, author: book.author });
        log(`[${done}/${total}] NO-MATCH ${book._id} ${(book.name || "").slice(0, 50)}`);
        await sleep(300);
        continue;
      }

      const imageUrl = `https://covers.openlibrary.org/b/id/${found.coverId}-L.jpg`;
      const thumbUrl = `https://covers.openlibrary.org/b/id/${found.coverId}-M.jpg`;
      if (!(await coverExists(imageUrl))) throw new Error("cover id has no real image (missing-cover placeholder)");

      await books.updateOne(
        { _id: book._id },
        {
          $set: { image: imageUrl, thumbnail: thumbUrl },
          $unset: { needsCoverImage: "" },
        }
      );
      matched++;
      log(`[${done}/${total}] OK ${book._id} ${(book.name || "").slice(0, 40)} <- OL "${found.matchedTitle}" by ${found.matchedAuthor}`);
    } catch (err) {
      failed++;
      failures.push({ id: book._id.toString(), name: book.name, error: err.message });
      log(`[${done}/${total}] FAIL ${book._id} ${(book.name || "").slice(0, 50)} - ${err.message}`);
    }

    // gentle pacing on Open Library's free API
    await sleep(350);
    if (done % 25 === 0 || done === total) {
      fs.writeFileSync(FAIL_PATH, JSON.stringify(failures, null, 2));
      fs.writeFileSync(NOMATCH_PATH, JSON.stringify(noMatches, null, 2));
      log(`--- progress: ${done}/${total} processed, ${matched} matched, ${noMatch} no-match, ${failed} failed ---`);
    }
  }

  fs.writeFileSync(FAIL_PATH, JSON.stringify(failures, null, 2));
  fs.writeFileSync(NOMATCH_PATH, JSON.stringify(noMatches, null, 2));
  log(`DONE. ${matched} matched, ${noMatch} no-match, ${failed} failed out of ${done} processed this run.`);
  await client.close();
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    log(`FATAL: ${err.stack || err}`);
    process.exit(1);
  });
