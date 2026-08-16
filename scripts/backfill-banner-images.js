// One-off script: re-compresses existing banner images (raw, unresized admin
// uploads - PNG, 74-131KB each observed) into proportionally resized JPEGs,
// matching the fix already applied to new uploads in AddBanner.jsx. These
// are shown eagerly on the homepage hero, so their size directly affects
// how fast the first thing a visitor sees actually appears.
//
// Only a handful of banners exist (~7), so this just runs start-to-finish
// without the batching/rate-limit-recovery machinery backfill-thumbnails.js
// needed for the 1300-book catalog.
//
// Usage (from book-ocean-bd-server/): node scripts/backfill-banner-images.js

require("dotenv").config();
const { MongoClient, ServerApiVersion } = require("mongodb");
const sharp = require("sharp");

const IMG_HOST_TOKEN = process.env.VITE_image_Upload_token || "b4f9b235a1abc56603d231b0e2443764";
const IMG_HOST_URL = `https://api.imgbb.com/1/upload?key=${IMG_HOST_TOKEN}`;
const MAX_DIMENSION = 800; // longest side, in px; aspect ratio preserved

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.6kqiq.mongodb.net/?retryWrites=true&w=majority`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function uploadToImgbb(buffer) {
  const res = await fetch(IMG_HOST_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ image: buffer.toString("base64") }),
  });
  const json = await res.json();
  if (!json.success) {
    throw new Error(`imgbb error: ${JSON.stringify(json).slice(0, 300)}`);
  }
  return json.data;
}

async function run() {
  const client = new MongoClient(uri, {
    serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true },
  });
  await client.connect();
  const banners = client.db("bookOceanBdDB").collection("banners");

  const all = await banners.find({ image: { $exists: true, $ne: "" } }).toArray();
  console.log(`Found ${all.length} banners.`);

  let ok = 0;
  let failed = 0;

  for (const banner of all) {
    try {
      const imgRes = await fetch(banner.image);
      if (!imgRes.ok) throw new Error(`download failed: HTTP ${imgRes.status}`);
      const original = Buffer.from(await imgRes.arrayBuffer());

      const resized = await sharp(original)
        .resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer();

      const data = await uploadToImgbb(resized);
      const newUrl = data.display_url || data.url;

      await banners.updateOne({ _id: banner._id }, { $set: { image: newUrl } });
      ok++;
      console.log(`OK   ${banner._id} ${(banner.name || "").slice(0, 45)} - ${original.length}B -> ${resized.length}B`);
    } catch (err) {
      failed++;
      console.log(`FAIL ${banner._id} ${(banner.name || "").slice(0, 45)} - ${err.message}`);
    }
    await sleep(500); // gentle pacing on imgbb
  }

  console.log(`DONE. ${ok} succeeded, ${failed} failed out of ${all.length}.`);
  await client.close();
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("FATAL:", err);
    process.exit(1);
  });
