// Syncs the book catalog from a public Google Sheet CSV export.
//
// Only pulls 5 fields, by design: name, author, category, quantity
// (stock count) - from which availability is derived - and price.
// Everything else on a book record (image, description, ISBN, publisher,
// cover type, etc.) is left for manual editing via the normal Add/Edit
// Book pages - the sheet doesn't have that data anyway.
//
// The sheet's actual columns are just: SN, BOOK NAME, AUTHOR NAME, STOCK,
// PRICE(TK). Category isn't a column either - it's implied by
// section-header rows scattered through the sheet (e.g. "Fantasy
// Collection"), which we track as we walk through the rows.
//
// Behavior (see conversation for why):
//   - Existing book (matched by name+edition, falling back to name+author
//     for entries that predate edition tracking): only price, quantity,
//     and availability (derived: quantity > 0) are updated. Nothing else
//     is touched.
//   - Book not found in the catalog: created with name/author/category/
//     edition/price/quantity/availability from the sheet. No image is set -
//     covers are uploaded manually via the admin Edit Book page - and
//     needsCoverImage: true flags it for that manual follow-up.
//
// Uses one query to load all existing {name, author} pairs into memory and
// a single bulkWrite for every insert/update, instead of one round trip per
// sheet row (which would be 1000+ queries and risk timing out).

const Papa = require("papaparse");

// Matches the "Only X left in stock" threshold BookDetails.jsx already shows
// shoppers - reused here so a stock drop triggers an admin notification at
// the same point a customer would start seeing the low-stock warning.
const LOW_STOCK_THRESHOLD = 5;

// Section-header text (normalized: collapsed whitespace, lowercased) ->
// this app's actual category values (see AddBooks.jsx's category <select>).
// "" is the bucket for rows before the first section header in the sheet.
//
// Several of these ("penguin classics collection", "oxford classic
// collection", "projapoti classic", "everyman's library collection", ...)
// all map to the SAME category ("classics"). That's intentional for
// category/browsing purposes, but it used to mean the sheet's actual
// section - which is what distinguishes real, separately-priced-and-
// stocked EDITIONS of the same title - was thrown away entirely once
// mapped down to just "classics". A "Crime and Punishment" row under
// Penguin Classics and one under Oxford Classic are two different physical
// products, not the same catalog entry - see `edition` in parseBookRows
// below, which now keeps the section text itself for exactly this.
const CATEGORY_MAP = {
  "": "fiction",
  "romantic books collection": "romance",
  "non-fiction collection": "non-fiction",
  "science fiction collection": "science fiction",
  "fantasy collection": "fantasy",
  "penguin classics collection": "classics",
  "penguin archive classic": "classics",
  "oxford classic collection": "classics",
  "collins classics collection": "classics",
  "projapoti classic": "classics",
  "papilio childern hardcover classic": "children's",
  "puffin hardcover classic collection": "children's",
  "cuppa classics": "classics",
  "fingerprint deluxe edition hard cover": "deluxe edition",
  "wilco sprayed edge classic": "classics",
  "everyman's library collection": "classics",
  "manga & comics collection": "manga",
  "dk & marvel collection": "comics",
  "islamic books collection": "islamic",
  "barnes & noble leatherbound collection": "barnes & noble",
  "penguin clothbound classic": "classics",
  "macmillan collectors library": "classics",
};

// Cleans up a raw section-header for storage/display as `edition` - title
// cases it instead of keeping the sheet's often ALL-CAPS or stray-space
// formatting verbatim ("OXFORD CLASSIC COLLECTION   " -> "Oxford Classic
// Collection"). The blank/pre-first-header bucket has no real edition name.
function formatEdition(sectionTitle) {
  // Google Sheets' CSV export HTML-entity-escapes "&" in some cells
  // ("Manga & Comics Collection" -> "Manga &amp; Comics Collection") -
  // undo that here rather than storing the escaped form as if it were the
  // real text.
  const cleaned = normalize(sectionTitle).replace(/&amp;/g, "&");
  if (!cleaned) return "";
  return cleaned.replace(/\b\w/g, (c) => c.toUpperCase());
}

function normalize(text) {
  return (text || "").toString().replace(/\s+/g, " ").trim().toLowerCase();
}

function mapCategory(sectionTitle) {
  return CATEGORY_MAP[normalize(sectionTitle)] || "fiction";
}

// Drops parenthetical qualifiers - "(hardcover)", "( Mass market paperback
// uk edition )", "(Vintage)" - so e.g. sheet row "Circe (hardcover )" can
// still match an existing catalog entry titled plain "Circe" by the same
// author, instead of being treated as a different book. Only affects
// matching, never the stored name (matched updates only ever touch price/
// availability; newly created books keep the sheet's original title).
function normalizeForMatch(text) {
  return normalize((text || "").replace(/\([^)]*\)/g, ""));
}

// Book NAME is the primary match key (see syncGoogleSheet below) - author is
// only used as a secondary check, to tell apart genuinely different books
// that happen to share a generic title ("Selected Poems" by half a dozen
// different poets is a real, confirmed case in this catalog) from sheet
// rows that are actually the same book with the author typed slightly
// differently ("HD CARLTON" vs "H.D carlton", "Art Spieglman" vs "Art
// Spiegelman"). A plain exact-string comparison catches neither of those -
// this strips ALL punctuation/spacing first, then tolerates a small typo
// via edit distance, so formatting differences and minor misspellings both
// resolve to "the same author" while genuinely different names don't.
function normalizeAuthorKey(author) {
  return normalize(author).replace(/[^a-z0-9]/g, "");
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j - 1], prev[j], curr[j - 1]);
    }
    prev = curr;
  }
  return prev[n];
}

// true if these two author strings plausibly refer to the same person -
// used to decide whether a sheet row updates an existing same-named book or
// creates a new one. An empty/"Unknown" side never blocks a match (a sheet
// row with no author shouldn't spawn a duplicate of a book that already has
// one on file).
function authorsMatch(a, b) {
  const na = normalizeAuthorKey(a);
  const nb = normalizeAuthorKey(b);
  if (!na || !nb || na === "unknown" || nb === "unknown") return true;
  if (na === nb) return true;
  // one name is a truncated/partial version of the other, e.g. "Gabriel
  // Garcia" vs "Gabriel Garcia Marquez" - require some length so short
  // names ("Lee" vs "Lee Child") don't false-positive against each other
  if (na.length >= 6 && nb.length >= 6 && (na.startsWith(nb) || nb.startsWith(na))) return true;
  // small edit distance relative to length - catches a handful of
  // misspelled/mistyped letters without conflating unrelated names
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen >= 6 && levenshtein(na, nb) <= 2) return true;
  return false;
}

// Only name/author/category/availability/price come from the sheet - cover
// type isn't one of them, so new books just get a fixed default here rather
// than guessing from the title text. Update it manually along with the rest.
const DEFAULT_COVER = "paperback";

function parsePrice(raw) {
  const cleaned = (raw || "").toString().replace(/[^\d.]/g, "");
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

function parseStock(raw) {
  const cleaned = (raw || "").toString().trim();
  if (cleaned === "" || cleaned === "-" || cleaned === "--") return 0;
  const num = parseInt(cleaned, 10);
  return isNaN(num) ? 0 : num;
}

function sheetIdFromUrl(urlOrId) {
  const match = String(urlOrId).match(/\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : urlOrId;
}

async function fetchSheetRows(sheetUrlOrId, gid = "0") {
  const id = sheetIdFromUrl(sheetUrlOrId);
  const csvUrl = `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`;
  const res = await fetch(csvUrl);
  if (!res.ok) {
    throw new Error(
      `Failed to fetch the sheet (HTTP ${res.status}). Make sure it's shared as "Anyone with the link can view".`
    );
  }
  const csvText = await res.text();
  const parsed = Papa.parse(csvText, { skipEmptyLines: false });
  return parsed.data; // array of arrays
}

// Walks the raw CSV rows, tracking the current category as it crosses
// section-header rows (a row with text in the SN column but nothing in the
// BOOK NAME column), and returns a flat list of parsed book records.
function parseBookRows(rows) {
  const headerIndex = rows.findIndex((r) => normalize(r[1]) === "book name");
  const dataRows = headerIndex >= 0 ? rows.slice(headerIndex + 1) : rows;

  let currentCategory = mapCategory("");
  let currentEdition = formatEdition("");
  const books = [];

  for (const row of dataRows) {
    const [sn, name, author, stock, price] = row;
    const hasName = (name || "").trim() !== "";
    const snText = (sn || "").trim();

    if (!hasName) {
      // section header (or a blank separator row, which we just skip). A
      // real section title always has letters in it ("Fantasy Collection")
      // - a bare number here is some other kind of stray/separator row in
      // the sheet, not an actual header, so it's ignored rather than
      // treated as a (nonsensical) edition name like "20".
      if (snText !== "" && /[a-zA-Z]/.test(snText)) {
        currentCategory = mapCategory(snText);
        currentEdition = formatEdition(snText);
      }
      continue;
    }

    const stockCount = parseStock(stock);
    books.push({
      name: name.trim(),
      author: (author || "").trim() || "Unknown",
      category: currentCategory,
      edition: currentEdition,
      price: parsePrice(price),
      quantity: stockCount,
      available: stockCount > 0 ? "true" : "false",
    });
  }

  return books;
}

// dryRun: true skips the actual bulkWrite and just reports what would happen
async function syncGoogleSheet(booksCollection, sheetUrlOrId, { dryRun = false } = {}) {
  const rows = await fetchSheetRows(sheetUrlOrId);
  const parsedBooks = parseBookRows(rows);

  // grouped by NAME (the primary key) - each name maps to the list of
  // existing catalog entries with that title, since more than one is
  // legitimate: different authors' "Selected Poems", but ALSO the same
  // book in different editions (Penguin Classics vs Oxford Classic vs
  // Projapoti Classic, etc) - each a separately priced/stocked product,
  // not the same catalog entry, even though the sheet's section headers
  // that distinguish them all map to the same *category* ("classics").
  const existingBooks = await booksCollection.find({}, { projection: { name: 1, author: 1, quantity: 1, edition: 1 } }).toArray();
  const byName = new Map();
  for (const b of existingBooks) {
    const key = normalizeForMatch(b.name);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push({ id: b._id, author: b.author, quantity: b.quantity, edition: b.edition || null });
  }

  const bulkOps = [];
  const newlyCreated = [];
  const lowStockAlerts = [];
  const categoryCounts = {};
  let updated = 0;
  let created = 0;

  for (const book of parsedBooks) {
    categoryCounts[book.category] = (categoryCounts[book.category] || 0) + 1;
    const nameKey = normalizeForMatch(book.name);
    const candidates = byName.get(nameKey) || [];

    // 1. an existing entry already recorded with this exact edition wins
    let existing = candidates.find((c) => c.edition && normalize(c.edition) === normalize(book.edition) && authorsMatch(c.author, book.author));

    // 2. no candidate has this edition on file yet - if there's exactly one
    //    candidate with NO edition recorded at all (i.e. it predates this
    //    field existing), treat it as this edition and backfill the field,
    //    rather than creating a duplicate for every already-cataloged book.
    //    Only when it's unambiguous: 2+ edition-less candidates for the same
    //    name means we genuinely don't know which one this sheet row is,
    //    UNLESS the sheet row's author uniquely narrows it down to one of
    //    them - without this, once a name had 2+ edition-less candidates
    //    (however that happened) every future sync run would keep creating
    //    yet another new row for it instead of ever updating the one it
    //    actually already matches, since none of them can ever gain an
    //    edition on their own to hit case 1. Confirmed live: ~138 titles
    //    ("The Midnight Library"/Harper Lee, "American Psycho"/Bret Easton
    //    Ellis, etc.) were about to be duplicated again on the next sync.
    let backfillEdition = false;
    if (!existing) {
      const editionlessCandidates = candidates.filter((c) => !c.edition);
      if (editionlessCandidates.length === 1 && authorsMatch(editionlessCandidates[0].author, book.author)) {
        existing = editionlessCandidates[0];
        backfillEdition = true;
      } else if (editionlessCandidates.length > 1) {
        const authorMatched = editionlessCandidates.filter((c) => authorsMatch(c.author, book.author));
        if (authorMatched.length === 1) {
          existing = authorMatched[0];
          backfillEdition = true;
        }
        // 0 or 2+ author-matched candidates: still genuinely ambiguous (or a
        // real pre-existing duplicate for the dedupe script to merge, e.g.
        // two "East of Eden" rows both by John Steinbeck) - fall through to
        // creating a new entry rather than guessing wrong.
      }
    }

    // Record the backfill on the in-memory candidate immediately, not just
    // in the bulkOp - otherwise, when a title has a real edition on file
    // (Penguin Classics, say) but the DB has only one legacy edition-less
    // row for it, that ONE row keeps re-matching "the single edition-less
    // candidate" for every remaining sheet row of that title in this same
    // run (Everyman's Library, Oxford Classic, ...), each overwriting the
    // last one's price/quantity - so a book sold in 3 real editions collapses
    // into a single DB entry instead of 3. Once backfilled, this candidate
    // has a real edition and can only be matched again by an identical one
    // (case 1) or left alone so the next distinct edition creates its own
    // new row, same as if it had always had this edition on file.
    if (backfillEdition && book.edition) existing.edition = book.edition;

    if (existing && existing.id === null) {
      // matches a row already created earlier in THIS SAME run (a
      // duplicated row in the sheet itself) - nothing new to write, and
      // there's no real _id yet to update against
    } else if (existing) {
      const setFields = { available: book.available, quantity: book.quantity };
      if (book.price != null) setFields.price = book.price;
      if (backfillEdition) setFields.edition = book.edition;
      bulkOps.push({ updateOne: { filter: { _id: existing.id }, update: { $set: setFields } } });
      updated++;

      // only alert on the crossing (was above the line, now at/below it) -
      // not on every sync that re-confirms an already-low count, so admins
      // get one notification per book per stock dip instead of one per cron run
      const wasLow = typeof existing.quantity === "number" && existing.quantity <= LOW_STOCK_THRESHOLD;
      const isLow = book.quantity <= LOW_STOCK_THRESHOLD;
      if (isLow && !wasLow) {
        lowStockAlerts.push({ id: existing.id, name: book.name, quantity: book.quantity });
      }
    } else {
      const newBookDoc = {
        name: book.name,
        author: book.author,
        category: book.category,
        edition: book.edition,
        price: book.price || 0,
        quantity: book.quantity,
        available: book.available,
        // deliberately no auto-assigned image/thumbnail - covers get
        // uploaded manually via the admin Edit Book page. needsCoverImage
        // below is what flags these for that manual follow-up.
        image: null,
        thumbnail: null,
        description: "",
        publisher: "",
        language: "",
        page: "",
        isbn10: "",
        isbn13: "",
        itemWeight: "",
        dimensions: "",
        cover: DEFAULT_COVER,
        best: "false",
        newBook: "false",
        needsCoverImage: true,
      };
      bulkOps.push({ insertOne: { document: newBookDoc } });
      newlyCreated.push({ name: book.name, author: book.author, category: book.category, edition: book.edition, price: book.price });
      created++;
      // dedupe within this same run - a duplicated row in the sheet
      // shouldn't create the same book twice (no real _id yet since this
      // hasn't been written; later rows just need this candidate to exist
      // for the authorsMatch check, not a real id to update against)
      if (!byName.has(nameKey)) byName.set(nameKey, []);
      byName.get(nameKey).push({ id: null, author: book.author, quantity: book.quantity, edition: book.edition || null });
    }
  }

  if (!dryRun && bulkOps.length > 0) {
    await booksCollection.bulkWrite(bulkOps, { ordered: false });
  }

  return {
    dryRun,
    totalRows: parsedBooks.length,
    updated,
    created,
    categoryCounts,
    newlyCreated: dryRun ? newlyCreated : newlyCreated.slice(0, 200), // cap response size
    lowStockAlerts, // caller (index.js) turns these into admin notifications
  };
}

module.exports = {
  syncGoogleSheet,
  fetchSheetRows,
  parseBookRows,
  LOW_STOCK_THRESHOLD,
  normalizeForMatch,
  authorsMatch,
};
