// One-off/rerunnable maintenance script: generates a small `thumbnail` URL
// for every book that only has a full-size `image` today.
//
// It downloads each book's existing cover, resizes it PROPORTIONALLY (no
// cropping - full cover stays visible, aspect ratio preserved, longest side
// capped at THUMB_MAX_DIMENSION) with sharp, then uploads the resized image
// to imgbb (same host the app already uses) and saves the resulting URL as
// `thumbnail`.
//
// NOTE: do not swap this back to imgbb's own auto-generated `data.thumb.url`
// - that variant is a hard square CENTER-CROP (e.g. 640x431 -> 121x121),
// which chops off the top/bottom of every cover. That was tried and reverted;
// see git history / conversation for the incident.
//
// Safe to re-run: it only processes books missing a `thumbnail` field, so an
// interrupted run can just be started again and it will pick up where it
// left off. Progress and failures are logged to scripts/backfill-thumbnails.log
// and scripts/backfill-thumbnails-failures.json.
//
// Usage (from book-ocean-bd-server/):  node scripts/backfill-thumbnails.js

require("dotenv").config();
const { MongoClient, ServerApiVersion } = require("mongodb");
const sharp = require("sharp");
const fs = require("fs");
const path = require("path");

const THUMB_MAX_DIMENSION = 400; // longest side, in px; aspect ratio preserved

const IMG_HOST_TOKEN = process.env.VITE_image_Upload_token || "b4f9b235a1abc56603d231b0e2443764";
const IMG_HOST_URL = `https://api.imgbb.com/1/upload?key=${IMG_HOST_TOKEN}`;

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.6kqiq.mongodb.net/?retryWrites=true&w=majority`;

const LOG_PATH = path.join(__dirname, "backfill-thumbnails.log");
const FAIL_PATH = path.join(__dirname, "backfill-thumbnails-failures.json");

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_PATH, line + "\n");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function uploadToImgbb(buffer, retries = 3) {
  const base64 = buffer.toString("base64");
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(IMG_HOST_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ image: base64 }),
      });
      const json = await res.json();
      if (json.success) return json.data;
      const err = new Error(`imgbb error: ${JSON.stringify(json).slice(0, 300)}`);
      // a hard quota isn't a transient blip - retrying the same request
      // immediately just burns more of the same limit, so don't.
      err.isRateLimit = /rate limit/i.test(json?.error?.message || "");
      throw err;
    } catch (err) {
      lastErr = err;
      if (err.isRateLimit) throw err;
      if (attempt < retries) await sleep(1500 * attempt);
    }
  }
  throw lastErr;
}

async function run() {
  const client = new MongoClient(uri, {
    serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true },
  });
  await client.connect();
  const books = client.db("bookOceanBdDB").collection("books");

  const query = {
    image: { $exists: true, $ne: "" },
    $or: [{ thumbnail: { $exists: false } }, { thumbnail: "" }],
  };
  // snapshot into a plain array up front instead of iterating a live cursor -
  // a long-running loop (especially once imgbb starts rate-limiting and each
  // failed request eats several seconds of backoff) can leave a cursor idle
  // long enough for MongoDB to close it server-side ("cursor id ... not
  // found"), which previously crashed the whole run partway through.
  const docs = await books.find(query).toArray();
  const limit = parseInt(process.env.BACKFILL_LIMIT || "0", 10);
  const queue = limit > 0 ? docs.slice(0, limit) : docs;
  const total = queue.length;
  log(`Found ${total} books needing a thumbnail.`);

  let done = 0;
  let ok = 0;
  let failed = 0;
  let consecutiveRateLimits = 0;
  const failures = [];
  const RATE_LIMIT_STOP_THRESHOLD = 5;

  for (const book of queue) {
    done++;
    try {
      const imgRes = await fetch(book.image);
      if (!imgRes.ok) throw new Error(`download failed: HTTP ${imgRes.status}`);
      const original = Buffer.from(await imgRes.arrayBuffer());
      // proportional resize - keeps full cover visible, no cropping
      const resized = await sharp(original)
        .resize({
          width: THUMB_MAX_DIMENSION,
          height: THUMB_MAX_DIMENSION,
          fit: "inside",
          withoutEnlargement: true,
        })
        .jpeg({ quality: 85 })
        .toBuffer();
      const data = await uploadToImgbb(resized);
      const thumbUrl = data.display_url || data.url;
      await books.updateOne({ _id: book._id }, { $set: { thumbnail: thumbUrl } });
      ok++;
      consecutiveRateLimits = 0;
      log(`[${done}/${total}] OK   ${book._id} ${(book.name || "").slice(0, 50)}`);
    } catch (err) {
      failed++;
      failures.push({ id: book._id.toString(), name: book.name, error: err.message });
      log(`[${done}/${total}] FAIL ${book._id} ${(book.name || "").slice(0, 50)} - ${err.message}`);

      if (err.isRateLimit) {
        consecutiveRateLimits++;
        if (consecutiveRateLimits >= RATE_LIMIT_STOP_THRESHOLD) {
          log(
            `imgbb rate limit hit ${consecutiveRateLimits} times in a row - stopping early ` +
            `instead of burning through the rest of the queue. Progress is saved; re-run this ` +
            `script later (e.g. in an hour) to pick up where it left off.`
          );
          break;
        }
      } else {
        consecutiveRateLimits = 0;
      }
    }

    // gentle pacing so we don't trip imgbb's rate limiting
    await sleep(400);

    if (done % 25 === 0 || done === total) {
      fs.writeFileSync(FAIL_PATH, JSON.stringify(failures, null, 2));
      log(`--- progress: ${done}/${total} processed, ${ok} ok, ${failed} failed ---`);
    }
  }

  fs.writeFileSync(FAIL_PATH, JSON.stringify(failures, null, 2));
  log(`DONE. ${ok} succeeded, ${failed} failed out of ${total} processed this run.`);
  await client.close();
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    log(`FATAL: ${err.stack || err}`);
    process.exit(1);
  });
