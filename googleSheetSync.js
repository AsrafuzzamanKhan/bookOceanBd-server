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
//   - Existing book (matched by name+author, case-insensitive): only
//     price, quantity, and availability (derived: quantity > 0) are
//     updated. Nothing else is touched.
//   - Book not found in the catalog: created with name/author/category/
//     price/quantity/availability from the sheet, a placeholder cover
//     image, and needsCoverImage: true so it's easy to find and finish
//     manually later.
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

// Reused elsewhere in the app as a generic Book Ocean BD fallback image
// (see bookOceanBD/scripts/generate-og-pages.cjs) - reusing it here too
// instead of hosting a new placeholder asset.
const PLACEHOLDER_IMAGE = "https://i.ibb.co/yhDbPYf/logo2.jpg";

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

function matchKey(name, author) {
  return `${normalizeForMatch(name)}|${normalize(author)}`;
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
  const books = [];

  for (const row of dataRows) {
    const [sn, name, author, stock, price] = row;
    const hasName = (name || "").trim() !== "";
    const snText = (sn || "").trim();

    if (!hasName) {
      // section header (or a blank separator row, which we just skip)
      if (snText !== "") {
        currentCategory = mapCategory(snText);
      }
      continue;
    }

    const stockCount = parseStock(stock);
    books.push({
      name: name.trim(),
      author: (author || "").trim() || "Unknown",
      category: currentCategory,
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

  const existingBooks = await booksCollection.find({}, { projection: { name: 1, author: 1, quantity: 1 } }).toArray();
  const existingMap = new Map();
  for (const b of existingBooks) {
    existingMap.set(matchKey(b.name, b.author), { id: b._id, quantity: b.quantity });
  }

  const bulkOps = [];
  const newlyCreated = [];
  const lowStockAlerts = [];
  const categoryCounts = {};
  let updated = 0;
  let created = 0;

  for (const book of parsedBooks) {
    categoryCounts[book.category] = (categoryCounts[book.category] || 0) + 1;
    const key = matchKey(book.name, book.author);
    const existing = existingMap.get(key);

    if (existing) {
      const setFields = { available: book.available, quantity: book.quantity };
      if (book.price != null) setFields.price = book.price;
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
        price: book.price || 0,
        quantity: book.quantity,
        available: book.available,
        image: PLACEHOLDER_IMAGE,
        thumbnail: PLACEHOLDER_IMAGE,
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
      newlyCreated.push({ name: book.name, author: book.author, category: book.category, price: book.price });
      created++;
      // dedupe within this same run - a duplicated row in the sheet
      // shouldn't create the same book twice
      existingMap.set(key, true);
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

module.exports = { syncGoogleSheet, fetchSheetRows, parseBookRows, LOW_STOCK_THRESHOLD };
