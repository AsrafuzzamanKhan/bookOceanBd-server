require("dotenv").config();
const { MongoClient, ServerApiVersion } = require("mongodb");
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.6kqiq.mongodb.net/?retryWrites=true&w=majority`;

const DRY_RUN = process.argv.includes("--execute") ? false : true;

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

function cleanAuthorWords(s) {
  return (s || "")
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/\btranslated by\b/g, " ")
    .replace(/\btranslator\b/g, " ")
    .replace(/\btrans\.?\b/g, " ")
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length >= 3)
    .filter(w => !["and", "the", "dr", "phd", "mr", "mrs"].includes(w));
}

function isGenericAuthor(author) {
  const n = (author || "").toLowerCase().replace(/[^a-z]/g, "");
  return ["", "-", "unknown", "na", "various", "tbd", "anonymous"].includes(n);
}

function authorsSimilar(a, b) {
  const wa = cleanAuthorWords(a), wb = cleanAuthorWords(b);
  if (wa.length === 0 || wb.length === 0) return false;
  const ja = wa.join(""), jb = wb.join("");
  if (ja === jb) return true;
  let shared = 0;
  for (const w1 of wa) {
    for (const w2 of wb) {
      if (w1 === w2) { shared++; continue; }
      const d = levenshtein(w1, w2);
      const maxLen = Math.max(w1.length, w2.length);
      if (maxLen >= 4 && d / maxLen <= 0.3) shared++;
    }
  }
  return shared >= 1 && (shared / Math.min(wa.length, wb.length)) >= 0.5;
}

function unionFind(n) {
  const parent = Array.from({ length: n }, (_, i) => i);
  function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
  function union(a, b) { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; }
  return { find, union };
}

function pickSurvivor(cluster) {
  const real = cluster.filter(b => b.needsCoverImage !== true);
  const pool = real.length > 0 ? real : cluster;
  return pool.slice().sort((a, b) => {
    if ((b.quantity || 0) !== (a.quantity || 0)) return (b.quantity || 0) - (a.quantity || 0);
    if ((b.price || 0) !== (a.price || 0)) return (b.price || 0) - (a.price || 0);
    return String(a._id) < String(b._id) ? -1 : 1;
  })[0];
}

(async () => {
  const client = new MongoClient(uri, { serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true } });
  await client.connect();
  const books = client.db("bookOceanBdDB").collection("books");

  const all = await books.find({}, { projection: { name: 1, author: 1, price: 1, quantity: 1, available: 1, needsCoverImage: 1 } }).toArray();
  const groups = new Map();
  for (const b of all) {
    const key = (b.name || "").trim().toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(b);
  }
  const dupGroups = [...groups.entries()].filter(([, arr]) => arr.length > 1);

  const mergePlans = [];
  const reviewGroups = [];

  for (const [key, arr] of dupGroups) {
    const { find, union } = unionFind(arr.length);
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const genI = isGenericAuthor(arr[i].author), genJ = isGenericAuthor(arr[j].author);
        if (genI && genJ) { union(i, j); continue; }
        if (!genI && !genJ && authorsSimilar(arr[i].author, arr[j].author)) { union(i, j); continue; }
        // generic <-> specific: only link if this is the ONLY specific author in the whole group
        if (genI !== genJ) {
          const specificAuthors = arr.filter(b => !isGenericAuthor(b.author));
          const distinctClusters = [];
          for (const s of specificAuthors) {
            let matched = false;
            for (const c of distinctClusters) if (authorsSimilar(c[0].author, s.author)) { c.push(s); matched = true; break; }
            if (!matched) distinctClusters.push([s]);
          }
          if (distinctClusters.length <= 1) union(i, j);
        }
      }
    }
    const clusters = new Map();
    arr.forEach((b, idx) => {
      const root = find(idx);
      if (!clusters.has(root)) clusters.set(root, []);
      clusters.get(root).push(b);
    });

    for (const cluster of clusters.values()) {
      if (cluster.length === 1) continue;
      const survivor = pickSurvivor(cluster);
      const losers = cluster.filter(b => b._id !== survivor._id);
      const maxQty = Math.max(...cluster.map(b => b.quantity || 0));
      const nonZeroPrices = cluster.filter(b => b.price > 0).map(b => b.price);
      const finalPrice = survivor.price > 0 ? survivor.price : (nonZeroPrices[0] || 0);
      mergePlans.push({
        name: key,
        survivor: { id: survivor._id, author: survivor.author, oldQty: survivor.quantity, oldPrice: survivor.price },
        newQuantity: maxQty,
        newPrice: finalPrice,
        removed: losers.map(l => ({ id: l._id, author: l.author, price: l.price, qty: l.quantity })),
      });
    }
    // whole-group leftover entries not covered by any multi-member cluster = review
    const mergedIds = new Set(mergePlans.filter(p => p.name === key).flatMap(p => [p.survivor.id, ...p.removed.map(r => r.id)]));
    const leftover = arr.filter(b => !mergedIds.has(b._id));
    if (leftover.length > 1) {
      reviewGroups.push({ name: key, entries: leftover.map(b => ({ id: b._id, author: b.author, price: b.price, qty: b.quantity, placeholder: !!b.needsCoverImage })) });
    }
  }

  console.log(`Mode: ${DRY_RUN ? "DRY RUN" : "EXECUTE"}`);
  console.log("Duplicate name-groups:", dupGroups.length);
  console.log("Merge operations:", mergePlans.length, "(removing", mergePlans.reduce((s, p) => s + p.removed.length, 0), "books)");
  console.log("Groups still needing manual review:", reviewGroups.length);

  require("fs").writeFileSync("/tmp/merge_plans.json", JSON.stringify(mergePlans, null, 2));
  require("fs").writeFileSync("/tmp/review_groups.json", JSON.stringify(reviewGroups, null, 2));

  if (!DRY_RUN) {
    const bulkOps = [];
    for (const plan of mergePlans) {
      const available = plan.newQuantity > 0 ? "true" : "false";
      bulkOps.push({ updateOne: { filter: { _id: plan.survivor.id }, update: { $set: { quantity: plan.newQuantity, price: plan.newPrice, available } } } });
      for (const r of plan.removed) {
        bulkOps.push({ deleteOne: { filter: { _id: r.id } } });
      }
    }
    if (bulkOps.length > 0) {
      const result = await books.bulkWrite(bulkOps, { ordered: false });
      console.log("bulkWrite result: modified", result.modifiedCount, "deleted", result.deletedCount);
    }
    const total = await books.countDocuments();
    console.log("total books after merge:", total);
  }

  await client.close();
  process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
