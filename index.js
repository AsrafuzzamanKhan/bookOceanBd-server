const express = require("express");
const cors = require("cors");
const compression = require("compression"); // Added for speed
const { ObjectId, MongoClient, ServerApiVersion} = require("mongodb");
const jwt = require("jsonwebtoken");
require("dotenv").config();
const { initFirebaseAdminLite } = require("./firebaseAdminLite");
const { sendOrderStatusEmail, sendNewOrderAdminEmail, sendPasswordResetEmail, sendVerificationEmail, shortInvoiceId } = require("./mailer");
const { syncGoogleSheet, LOW_STOCK_THRESHOLD } = require("./googleSheetSync");

const BOOK_SHEET_URL = "https://docs.google.com/spreadsheets/d/1oJMLhYZrA4Rjiot65zuR75ZmTVrVqQmYDxUNwtNS3U4/edit?gid=0";

// Used to generate password reset links server-side so we can email them
// ourselves (branded, via mailer.js) instead of relying on Firebase's own
// default email (generic sender, no branding, easily flagged as spam).
//
// NOTE: this intentionally does NOT use the `firebase-admin` npm package -
// that pulls in Firestore/Storage/google-gax/protobufjs, a dependency tree
// large enough to blow past Vercel's serverless bundle size limit and crash
// the ENTIRE server (every route, not just this one) on cold start. That
// happened once already; see firebaseAdminLite.js for the lightweight
// REST-based replacement. Don't reintroduce firebase-admin here.
//
// Needs FIREBASE_SERVICE_ACCOUNT_BASE64 in .env: the service account JSON
// downloaded from Firebase Console -> Project Settings -> Service Accounts ->
// Generate new private key, base64-encoded onto one line. Everything that
// depends on this (just /auth/forgot-password) no-ops safely if it isn't set.
let firebaseAuth = null;
if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
  try {
    const serviceAccount = JSON.parse(
      Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, "base64").toString("utf8")
    );
    firebaseAuth = initFirebaseAdminLite(serviceAccount);
  } catch (err) {
    console.error("[firebase-admin-lite] failed to parse FIREBASE_SERVICE_ACCOUNT_BASE64:", err.message);
  }
} else {
  console.warn("[firebase-admin] FIREBASE_SERVICE_ACCOUNT_BASE64 not set - custom password reset emails are disabled.");
}

const app = express();
const port = process.env.PORT || 5000;

// middleware
app.use(compression()); // Compresses JSON data for faster loading
app.use(cors());
// app.use(cors({ origin: process.env.CLIENBT_URL }));
app.use(express.json());

// connect mongodb 
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.6kqiq.mongodb.net/?retryWrites=true&w=majority`;
// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

// jwt token
const verifyJWT = (req, res, next) => {
  const authorization = req.headers.authorization;
  if (!authorization) {
    return res
      .status(401)
      .send({ error: true, message: "unauthorized access" });
  }
  //  bearer token
  const token = authorization.split(" ")[1];
  // verify a token symmetric
  jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, (err, decoded) => {
    if (err) {
      return res
        .status(401)
        .send({ error: true, message: "unauthorized access" });
    }
    req.decoded = decoded;
    next();
  });
};




async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    // await client.connect();
    client.connect();

    // Get the database and collection on which to run the operation
    const usersCollection = client.db("bookOceanBdDB").collection("users");
    const booksCollection = client.db("bookOceanBdDB").collection("books");
    const bannersCollection = client.db("bookOceanBdDB").collection("banners");
    const cartCollection = client.db("bookOceanBdDB").collection("carts");
    const ordersCollection = client.db("bookOceanBdDB").collection("orders");
    const reviewsCollection = client.db("bookOceanBdDB").collection("reviews");
    const notificationsCollection = client.db("bookOceanBdDB").collection("notifications");

    // creates an in-app notification for the navbar bell (see GET /notifications
    // below). Best-effort - a failed insert must never fail the order-status
    // update (or book edit, or sheet sync) that triggered it, so callers
    // don't need to await/catch this. `link` is where the bell's dropdown
    // sends the user when they click the notification (e.g. an admin's "new
    // order" notification links to /dashboard/allOrders, a shopper's "order
    // approved" links to /dashboard/orderHistory).
    const createNotification = async ({ email, title, message, type, link }) => {
      if (!email) return;
      try {
        await notificationsCollection.insertOne({
          email,
          title,
          message,
          type,
          link,
          read: false,
          createdAt: new Date(),
        });
      } catch (err) {
        console.error(`Failed to create notification (${type}) for ${email}:`, err);
      }
    };

    // fans a notification out to every admin - used for events admins need
    // to act on (new order) or just be aware of (low stock), as opposed to
    // the per-customer notifications above which target a single email.
    const notifyAdmins = async ({ title, message, type, link }) => {
      try {
        const admins = await usersCollection.find({ role: "admin" }, { projection: { email: 1 } }).toArray();
        await Promise.all(
          admins.map((admin) => createNotification({ email: admin.email, title, message, type, link }))
        );
      } catch (err) {
        console.error(`Failed to notify admins (${type}):`, err);
      }
    };

    // jwt
    // const age = 1000 * 60 * 60 * 24 * 7;
    app.post("/jwt", (req, res) => {
      const user = req.body;
      const token = jwt.sign(user, process.env.ACCESS_TOKEN_SECRET, {
        expiresIn: "1h",
      });
      res.send({ token });
    });

    // forgot password - public (the whole point is the user isn't logged in
    // yet). Generates a real Firebase reset link server-side and emails it
    // ourselves via mailer.js instead of Firebase's own default email.
    //
    // Always responds with the same generic message regardless of outcome -
    // this must never reveal whether a given email has an account (that's an
    // account-enumeration security leak), so failures are only logged, not
    // surfaced to the caller.
    app.post("/auth/forgot-password", async (req, res) => {
      const { email } = req.body;
      const genericResponse = {
        success: true,
        message: "If an account exists for this email, a reset link has been sent.",
      };

      if (!email) {
        return res.status(400).send({ error: true, message: "email is required" });
      }
      if (!firebaseAuth) {
        console.error("[forgot-password] firebase-admin not configured, cannot generate reset link");
        return res.send(genericResponse);
      }

      try {
        const resetLink = await firebaseAuth.generatePasswordResetLink(email);
        await sendPasswordResetEmail(email, resetLink);
      } catch (err) {
        // e.g. auth/user-not-found - deliberately swallowed, see comment above
        console.error(`[forgot-password] failed for ${email}:`, err.message);
      }
      res.send(genericResponse);
    });

    // send/resend an email-verification link - public (called right after
    // signup, before the user necessarily has a working session, and again
    // from the "resend" button on the verify-email banner). Generates a real
    // Firebase verification link server-side and emails it ourselves via
    // mailer.js instead of Firebase's own default email (same reasoning as
    // /auth/forgot-password - branding + deliverability).
    app.post("/auth/send-verification-email", async (req, res) => {
      const { email } = req.body;
      const genericResponse = {
        success: true,
        message: "If an account exists for this email, a verification link has been sent.",
      };

      if (!email) {
        return res.status(400).send({ error: true, message: "email is required" });
      }
      if (!firebaseAuth) {
        console.error("[send-verification-email] firebase-admin not configured, cannot generate verification link");
        return res.send(genericResponse);
      }

      try {
        const verifyLink = await firebaseAuth.generateEmailVerificationLink(email);
        await sendVerificationEmail(email, verifyLink);
      } catch (err) {
        console.error(`[send-verification-email] failed for ${email}:`, err.message);
      }
      res.send(genericResponse);
    });

    // Warning : use verifyJWT before middle were verify admin middlewere

    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded.email;
      const query = { email: email };
      const user = await usersCollection.findOne(query);
      if (user?.role !== "admin") {
        return res
          .status(403)
          .send({ error: true, message: "forbidden message" });
      }
      next();
    };

    // create user record - public/unauthenticated by design (called right
    // after signup, before this app's own JWT necessarily exists yet).
    // BUT: was inserting req.body verbatim, so anyone could POST
    // { email, role: "admin" } directly (bypassing the frontend entirely)
    // and grant themselves admin on a brand-new account. Whitelisted to
    // only the fields signup actually needs - role can never come from
    // the client; every new account starts as a regular user, promoted
    // only via PATCH /users/admin/:id (verifyAdmin-protected).
    app.post("/users", async (req, res) => {
      const { name, email, photoURL } = req.body;
      if (!email) {
        return res.status(400).send({ error: true, message: "email is required" });
      }
      const existingUser = await usersCollection.findOne({ email });
      if (existingUser) {
        return res.send({ message: "User All ready exist" });
      }
      const result = await usersCollection.insertOne({ name, email, photoURL });
      res.send(result);
    });

    // get own profile - self-service, matched by the email in their JWT
    app.get("/users/profile", verifyJWT, async (req, res) => {
      const email = req.decoded.email;
      const result = await usersCollection.findOne({ email });
      res.send(result || {});
    });

    // update own profile (name/phone/address/gender) - self-service, any
    // logged-in user can update their own record, matched by the email in
    // their JWT (not the request body, so nobody can edit someone else's
    // profile by id/email)
    app.patch("/users/profile", verifyJWT, async (req, res) => {
      const email = req.decoded.email;
      const { name, phone, address, gender } = req.body;
      if (!name || !name.trim()) {
        return res.status(400).send({ error: true, message: "name is required" });
      }
      const filter = { email };
      const updateDoc = {
        $set: {
          name: name.trim(),
          phone: phone ?? "",
          address: address ?? "",
          gender: gender ?? "",
        },
      };
      const result = await usersCollection.updateOne(filter, updateDoc);
      res.send(result);
    });

    // get all users
    // 0. do not show secure link without admin
    // 1. use jwt token :verifyJWT
    // 2. use adminverify middlewere
    app.get("/users", verifyJWT, verifyAdmin, async (req, res) => {
      const result = await usersCollection.find().toArray();
      res.send(result);
    });

    // create user admin
    app.patch("/users/admin/:id", verifyJWT, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      console.log(id);
      const filter = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: {
          role: "admin",
        },
      };
      const result = await usersCollection.updateOne(filter, updateDoc);
      res.send(result);
    });

    // get user admin
    // security layer: verify jawt
    // email same
    // check admin
    app.get("/users/admin/:email", verifyJWT, async (req, res) => {
      const email = req.params.email;
      if (req.decoded.email !== email) {
        return res.send({ admin: false });
      }
      const query = { email: email };
      const user = await usersCollection.findOne(query);
      const result = { admin: user?.role === "admin" };
      res.send(result);
    });
    // delete user - was verifyJWT only (any logged-in user, not just an
    // admin, could delete any other account by calling this directly - the
    // AllUsers.jsx page is admin-gated in the UI, but the API itself wasn't).
    // verifyAdmin matches every other admin-only mutation in this file.
    app.delete("/users/:id", verifyJWT, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await usersCollection.deleteOne(query);
      res.send(result);
    });

    // books
    //
    // Excludes `description` - it's the largest field on every document and
    // isn't used anywhere this listing feeds (book cards, search, category
    // pages, cart) - only the individual book detail page needs it, which
    // now fetches it separately via GET /books/:id below. Returning it here
    // meant every single page load pulled ~2000 documents' worth of
    // description text just to render book cards that never display it,
    // which is what made this route slow enough to exceed the server's
    // request timeout under real traffic.
    app.get("/books", async (req, res) => {
      const result = await booksCollection.find({}, { projection: { description: 0 } }).toArray();
      res.send(result);
    });
    // single book, WITH description - used by the book detail page and the
    // admin edit-book page, the only two places that actually need it
    app.get("/books/:id", async (req, res) => {
      const id = req.params.id;
      if (!ObjectId.isValid(id)) {
        return res.status(400).send({ error: true, message: "invalid id" });
      }
      const result = await booksCollection.findOne({ _id: new ObjectId(id) });
      if (!result) {
        return res.status(404).send({ error: true, message: "book not found" });
      }
      res.send(result);
    });
    // post  books
    app.post("/books", verifyJWT, verifyAdmin, async (req, res) => {
      const query = req.body;
      // quantity is the source of truth for stock - if it was sent, derive
      // available from it instead of trusting a separately-submitted value
      const hasQuantity = query.quantity !== undefined && query.quantity !== null && query.quantity !== "";
      if (hasQuantity) {
        query.quantity = Number(query.quantity);
        query.available = query.quantity > 0 ? "true" : "false";
      } else {
        delete query.quantity;
      }
      const result = await booksCollection.insertOne(query);
      // a book can be added already low/out of stock (e.g. only 2 copies in
      // hand) - worth flagging once immediately, no "previous" value needed
      // since this is the book's first-ever quantity
      if (hasQuantity && query.quantity <= LOW_STOCK_THRESHOLD) {
        await notifyAdmins({
          title: query.quantity === 0 ? "Book added out of stock" : "New book low on stock",
          message: query.quantity === 0
            ? `"${query.name}" was added with 0 in stock.`
            : `"${query.name}" was added with only ${query.quantity} in stock.`,
          type: query.quantity === 0 ? "book_out_of_stock" : "book_low_stock",
          link: `/dashboard/updateBook/${result.insertedId}`,
        });
      }
      res.send(result);
    });

    // delete books
    app.delete("/books/:id", verifyJWT, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await booksCollection.deleteOne(query);
      res.send(result);
    });

    // update Books information
    //  image: bookInfo.image,
    app.put("/books/:id", verifyJWT, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      const filter = { _id: new ObjectId(id) };
      const bookInfo = req.body;
      const option = { upsert: true };
      // quantity is the source of truth for stock - if it was sent, derive
      // available from it instead of trusting a separately-submitted value.
      // Only touches quantity in $set when actually provided, so an older
      // cached client that doesn't send it can't null out a real count.
      let available = bookInfo.available;
      const hasQuantity = bookInfo.quantity !== undefined && bookInfo.quantity !== null && bookInfo.quantity !== "";
      const quantity = hasQuantity ? Number(bookInfo.quantity) : undefined;
      if (hasQuantity) {
        available = quantity > 0 ? "true" : "false";
      }
      // fetched before the update so we can tell whether this edit just
      // crossed the low-stock line, rather than notifying on every save of
      // an already-low book
      const previousBook = hasQuantity
        ? await booksCollection.findOne(filter, { projection: { quantity: 1, name: 1 } })
        : null;
      const updatedBook = {
        $set: {
          name: bookInfo.name,
          author: bookInfo.author,
          category: bookInfo.category,
          price: bookInfo.price,
          cover: bookInfo.cover,
          available: available,
          new: bookInfo.new,
          best: bookInfo.best,
          description: bookInfo.description,
          dimensions: bookInfo.dimensions,
          isbn10: bookInfo.isbn10,
          isbn13: bookInfo.isbn13,
          itemWeight: bookInfo.itemWeight,
          language: bookInfo.language,
          page: bookInfo.page,
          publisher: bookInfo.publisher,
        },
      };
      if (hasQuantity) updatedBook.$set.quantity = quantity;
      // image/thumbnail are optional on update - only overwrite them when a
      // new one was actually uploaded, so leaving the file picker empty
      // keeps the book's existing cover instead of wiping it out
      if (bookInfo.image) updatedBook.$set.image = bookInfo.image;
      if (bookInfo.thumbnail) updatedBook.$set.thumbnail = bookInfo.thumbnail;
      const result = await booksCollection.updateOne(
        filter,
        updatedBook,
        option
      );
      if (hasQuantity && previousBook) {
        const wasLow = typeof previousBook.quantity === "number" && previousBook.quantity <= LOW_STOCK_THRESHOLD;
        const isLow = quantity <= LOW_STOCK_THRESHOLD;
        if (isLow && !wasLow) {
          const bookName = bookInfo.name || previousBook.name;
          await notifyAdmins({
            title: quantity === 0 ? "Book out of stock" : "Book low on stock",
            message: quantity === 0
              ? `"${bookName}" is now out of stock.`
              : `"${bookName}" has only ${quantity} left in stock.`,
            type: quantity === 0 ? "book_out_of_stock" : "book_low_stock",
            link: `/dashboard/updateBook/${id}`,
          });
        }
      }
      res.send(result);
    });

    // Quick in-stock/out-of-stock toggle from the Manage Books list, deliberately
    // separate from the full PUT above - that endpoint $sets every field from
    // req.body unconditionally, so sending just {available} through it would
    // wipe out the book's name/author/category/etc with undefined. This only
    // ever touches `available`, and never quantity - a manual override, not a
    // restock/sell-out event (the next Google Sheet sync still derives
    // availability from quantity as usual and will override this if it disagrees).
    app.patch("/books/availability/:id", verifyJWT, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      const available = req.body.available === "true" ? "true" : "false";
      const result = await booksCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { available } }
      );
      res.send(result);
    });

    // banner
    app.get("/banners", async (req, res) => {
      const result = await bannersCollection.find().toArray();
      res.send(result);
    });
    // post  banner
    app.post("/banners", verifyJWT, verifyAdmin, async (req, res) => {
      const query = req.body;
      const result = await bannersCollection.insertOne(query);
      res.send(result);
    });

    // delete banner

    app.delete("/banner/:id", verifyJWT, verifyAdmin, async (req, res) => {
      const id = req.params.id;

      const query = { _id: new ObjectId(id) };
      const result = await bannersCollection.deleteOne(query);
      res.send(result);
    });

    // cart insart - adding a book that's already in this user's cart bumps
    // its quantity (capped at current stock) instead of creating a second,
    // duplicate line for the same book. Was unauthenticated with `email`
    // taken straight from the request body - anyone could POST a cart item
    // claiming to be any other customer's email, polluting their cart. Now
    // requires login and the item is always filed under the caller's own
    // email, ignoring whatever the client sent.
    app.post("/carts", verifyJWT, async (req, res) => {
      const item = { ...req.body, email: req.decoded.email };
      const query = { bookId: item.bookId, email: item.email };
      const existing = await cartCollection.findOne(query);

      const book = await booksCollection.findOne({ _id: new ObjectId(item.bookId) });
      // if we can't verify stock for some reason, don't let quantity climb
      const maxQty = book?.quantity ?? 1;

      if (existing) {
        const quantity = Math.min((existing.quantity || 1) + 1, Math.max(maxQty, 1));
        const result = await cartCollection.updateOne(query, { $set: { quantity } });
        return res.send({ ...result, existed: true, quantity, maxQty });
      }

      const result = await cartCollection.insertOne({ ...item, quantity: 1 });
      res.send({ ...result, existed: false, quantity: 1, maxQty });
    });

    // update a cart item's quantity (the +/- stepper in the cart drawer) -
    // always clamped to [1, book's current stock], and only the item's own
    // owner can change it
    app.patch("/carts/:id", verifyJWT, async (req, res) => {
      const id = req.params.id;
      const requestedQty = parseInt(req.body.quantity, 10);
      if (!requestedQty || requestedQty < 1) {
        return res.status(400).send({ error: true, message: "Invalid quantity" });
      }

      const cartItem = await cartCollection.findOne({ _id: new ObjectId(id) });
      if (!cartItem) return res.status(404).send({ error: true, message: "Cart item not found" });
      if (cartItem.email !== req.decoded.email) {
        return res.status(403).send({ error: true, message: "Forbidden access" });
      }

      const book = await booksCollection.findOne({ _id: new ObjectId(cartItem.bookId) });
      const maxQty = book?.quantity ?? 1;
      const quantity = Math.max(1, Math.min(requestedQty, Math.max(maxQty, 1)));

      const result = await cartCollection.updateOne({ _id: new ObjectId(id) }, { $set: { quantity } });
      res.send({ ...result, quantity, maxQty });
    });

    // get cart by email
    app.get("/carts", verifyJWT, async (req, res) => {
      const email = req.query.email;
      if (!email) {
        res.send([]);
      }

      const decodedEmail = req.decoded.email;
      if (email !== decodedEmail) {
        return res
          .status(403)
          .send({ error: true, message: "Forbidden access" });
      }
      const query = { email: email };

      const result = await cartCollection.find(query).toArray();
      res.send(result);
    });
    // delete cart item - was unauthenticated with no ownership check at all
    // (PATCH /carts/:id right above already does this correctly - this one
    // just never got the same treatment). Anyone could delete any other
    // customer's cart line by guessing its _id.
    app.delete("/carts/:id", verifyJWT, async (req, res) => {
      const id = req.params.id;
      const cartItem = await cartCollection.findOne({ _id: new ObjectId(id) });
      if (!cartItem) return res.status(404).send({ error: true, message: "Cart item not found" });
      if (cartItem.email !== req.decoded.email) {
        return res.status(403).send({ error: true, message: "Forbidden access" });
      }
      const result = await cartCollection.deleteOne({ _id: new ObjectId(id) });
      res.send(result);
    });

    // reviews
    app.get("/reviews", async (req, res) => {
      const result = await reviewsCollection.find().toArray();
      res.send(result);
    });

    // payment / order

    // payment

    app.post("/create-payment-intent", verifyJWT, async (req, res) => {
      const { price } = req.body;

      const amount = parseInt(price * 100);
      console.log(price, amount);
      // Create a PaymentIntent with the order amount and currency
      const paymentIntent = await stripe.paymentIntents.create({
        amount: amount,
        currency: "usd",
        // In the latest version of the API, specifying the `automatic_payment_methods` parameter is optional because Stripe enables its functionality by default.
        payment_method_types: ["card"],
      });

      res.send({
        clientSecret: paymentIntent.client_secret,
      });
    });

    // payment collection

    // was inserting req.body.email verbatim - anyone logged in could place
    // an order "as" another customer's email (fraudulent order attributed
    // to a stranger, notification spam to their inbox, shows up in their
    // Order History). Forced to the caller's own email, same fix as the
    // cart-spoofing issue above.
    app.post("/orders", verifyJWT, async (req, res) => {
      const orders = { ...req.body, email: req.decoded.email };
      const insertResult = await ordersCollection.insertOne(orders);

      const query = {
        _id: { $in: orders.cartItems.map((id) => new ObjectId(id)) },
      };
      const deleteResult = await cartCollection.deleteMany(query);
      console.log(insertResult, deleteResult);

      // notify admins so they can review and approve/cancel the order -
      // looked up by role rather than a hardcoded address, so it automatically
      // covers anyone promoted to admin via AllUsers.jsx
      try {
        const admins = await usersCollection.find({ role: "admin" }).toArray();
        const adminEmails = admins.map((a) => a.email);
        await sendNewOrderAdminEmail(adminEmails, { ...orders, _id: insertResult.insertedId });
      } catch (err) {
        console.error("Failed to send new-order admin email:", err);
      }

      const placedOrder = { ...orders, _id: insertResult.insertedId };
      await createNotification({
        email: orders.email,
        title: "Order placed",
        message: `Your order #${shortInvoiceId(placedOrder)} has been received and is awaiting confirmation.`,
        type: "order_placed",
        link: "/dashboard/orderHistory",
      });
      // same event as the admin email above, but in-app so it shows up as an
      // unread badge on the bell instead of relying on admins checking inbox
      await notifyAdmins({
        title: "New order received",
        message: `Order #${shortInvoiceId(placedOrder)} needs your review.`,
        type: "admin_new_order",
        link: "/dashboard/allOrders",
      });

      res.send({ insertResult, deleteResult });
    });
    // get all orders (admin) - was completely unauthenticated: every
    // customer's name/phone/address/email and full order history was
    // fetchable by anyone on the internet with a single GET request, no
    // login required at all.
    app.get("/allOrders", verifyJWT, verifyAdmin, async (req, res) => {
      const result = await ordersCollection.find().toArray();
      res.send(result);
    });

    // get order by email
    app.get("/orders", verifyJWT, async (req, res) => {
      const email = req.query.email;
      if (!email) {
        res.send([]);
      }

      const decodedEmail = req.decoded.email;
      if (email !== decodedEmail) {
        return res
          .status(403)
          .send({ error: true, message: "Forbidden access" });
      }
      const query = { email: email };

      const result = await ordersCollection.find(query).toArray();
      res.send(result);
    });
    // order approve - admin-only in the AllOrders.jsx UI, but that was never
    // enforced here: any logged-in customer could approve/cancel/deliver
    // *anyone's* order by calling these three endpoints directly.
    app.patch("/orders/approve-order/:id", verifyJWT, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      console.log(id);
      const filter = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: {
          status: "approve",
        },
      };
      const result = await ordersCollection.updateOne(filter, updateDoc);
      if (result.modifiedCount > 0) {
        const order = await ordersCollection.findOne(filter);
        // awaited (not fire-and-forget) since this runs on a Vercel serverless
        // function - it can freeze right after the response is sent, killing
        // any un-awaited work. Failure here must not fail the status update itself.
        try {
          await sendOrderStatusEmail(order, "approve");
        } catch (err) {
          console.error("Failed to send approval email:", err);
        }
        await createNotification({
          email: order.email,
          title: "Order approved",
          message: `Your order #${shortInvoiceId(order)} has been approved and is being prepared.`,
          type: "order_approved",
          link: "/dashboard/orderHistory",
        });
      }
      res.send(result);
    });
    // order cancel (admin) - see the note on approve-order above
    app.patch("/orders/cancel-order/:id", verifyJWT, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      console.log(id);
      const filter = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: {
          status: "canceled",
        },
      };
      const result = await ordersCollection.updateOne(filter, updateDoc);
      if (result.modifiedCount > 0) {
        const order = await ordersCollection.findOne(filter);
        try {
          await sendOrderStatusEmail(order, "canceled");
        } catch (err) {
          console.error("Failed to send cancellation email:", err);
        }
        await createNotification({
          email: order.email,
          title: "Order canceled",
          message: `Your order #${shortInvoiceId(order)} has been canceled.`,
          type: "order_canceled",
          link: "/dashboard/orderHistory",
        });
      }
      res.send(result);
    });
    // order delivery (admin) - see the note on approve-order above
    app.patch("/orders/delivery-order/:id", verifyJWT, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      console.log(id);
      const filter = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: {
          status: "delivered",
        },
      };
      const result = await ordersCollection.updateOne(filter, updateDoc);
      // no email on delivery (see mailer.js SUBJECTS) - but it still gets an
      // in-app notification like approve/cancel do.
      if (result.modifiedCount > 0) {
        const order = await ordersCollection.findOne(filter);
        await createNotification({
          email: order.email,
          title: "Order delivered",
          message: `Your order #${shortInvoiceId(order)} has been delivered. Enjoy your books!`,
          type: "order_delivered",
          link: "/dashboard/orderHistory",
        });
      }
      res.send(result);
    });

    // get the logged-in user's notifications for the navbar bell, newest first
    app.get("/notifications", verifyJWT, async (req, res) => {
      const email = req.query.email;
      if (!email) {
        return res.send([]);
      }
      if (email !== req.decoded.email) {
        return res.status(403).send({ error: true, message: "Forbidden access" });
      }
      const result = await notificationsCollection
        .find({ email })
        .sort({ createdAt: -1 })
        .limit(30)
        .toArray();
      res.send(result);
    });

    // mark a single notification as read (filtering by email too, not just
    // _id, so a user can't mark another user's notification as read)
    app.patch("/notifications/:id/read", verifyJWT, async (req, res) => {
      const id = req.params.id;
      const result = await notificationsCollection.updateOne(
        { _id: new ObjectId(id), email: req.decoded.email },
        { $set: { read: true } }
      );
      res.send(result);
    });

    // mark all of the logged-in user's notifications as read
    app.patch("/notifications/mark-all-read", verifyJWT, async (req, res) => {
      const result = await notificationsCollection.updateMany(
        { email: req.decoded.email, read: false },
        { $set: { read: true } }
      );
      res.send(result);
    });

    // customer self-cancel of their own pending order (OrderHistory.jsx's
    // "Cancel order" button - deletes the record entirely, matching that
    // page's "Removed from History" confirmation copy, as opposed to the
    // admin PATCH /orders/cancel-order/:id above, which soft-cancels and
    // keeps the record). Was completely unauthenticated - anyone who knew
    // or guessed an order's _id could delete ANY order for ANY customer,
    // regardless of status. Now requires the order to belong to the caller
    // and still be pending.
    app.delete("/orders/:id", verifyJWT, async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const order = await ordersCollection.findOne(query);
      if (!order) {
        return res.status(404).send({ error: true, message: "Order not found" });
      }
      if (order.email !== req.decoded.email) {
        return res.status(403).send({ error: true, message: "Forbidden access" });
      }
      if (order.status !== "pending") {
        return res.status(400).send({ error: true, message: "Only a pending order can be canceled this way" });
      }
      const result = await ordersCollection.deleteOne(query);
      res.send(result);
    });

    // admin dashboard information
    app.get("/admin-stats", verifyJWT, verifyAdmin, async (req, res) => {
      const users = await usersCollection.estimatedDocumentCount();
      const products = await booksCollection.estimatedDocumentCount();
      const orders = await ordersCollection.estimatedDocumentCount();

      // Revenue = delivered orders only. This is Cash on Delivery - money
      // isn't actually collected until the book is delivered, so pending/
      // approved/canceled orders aren't real revenue yet (previously this
      // summed every order regardless of status, which overstated revenue).
      const revenueAgg = await ordersCollection.aggregate([
        { $match: { status: "delivered" } },
        { $group: { _id: null, total: { $sum: "$totalAmount" } } },
      ]).toArray();
      const revenue = revenueAgg[0]?.total || 0;

      res.send({
        users,
        products,
        orders,
        revenue,
      });
    });

    // manual trigger - admin dashboard's "Sync Now" button
    // turns syncGoogleSheet's lowStockAlerts (books that just crossed into
    // low/out-of-stock as a result of this sync) into admin notifications.
    // Shared by both sync routes below; a no-op for dryRun since nothing
    // actually changed in that case.
    const notifyLowStockAlerts = async (alerts) => {
      await Promise.all(
        (alerts || []).map(({ id, name, quantity }) =>
          notifyAdmins({
            title: quantity === 0 ? "Book out of stock" : "Book low on stock",
            message: quantity === 0
              ? `"${name}" is now out of stock (synced from the stock sheet).`
              : `"${name}" has only ${quantity} left in stock (synced from the stock sheet).`,
            type: quantity === 0 ? "book_out_of_stock" : "book_low_stock",
            link: `/dashboard/updateBook/${id}`,
          })
        )
      );
    };

    app.post("/admin/sync-google-sheet", verifyJWT, verifyAdmin, async (req, res) => {
      try {
        const dryRun = !!req.body?.dryRun;
        const result = await syncGoogleSheet(booksCollection, BOOK_SHEET_URL, { dryRun });
        if (!dryRun) await notifyLowStockAlerts(result.lowStockAlerts);
        res.send(result);
      } catch (err) {
        console.error("[sync-google-sheet] failed:", err);
        res.status(500).send({ error: true, message: err.message });
      }
    });

    // automatic trigger - called by Vercel Cron (see vercel.json). Not
    // admin-JWT protected since Vercel's scheduler doesn't carry a user
    // session; instead it must present the shared CRON_SECRET. No-ops
    // (403) for anyone else, so the sheet can't be synced by just knowing
    // this URL.
    app.get("/cron/sync-google-sheet", async (req, res) => {
      const authHeader = req.headers.authorization;
      if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(403).send({ error: true, message: "forbidden" });
      }
      try {
        const result = await syncGoogleSheet(booksCollection, BOOK_SHEET_URL);
        console.log("[cron sync-google-sheet]", result.totalRows, "rows,", result.updated, "updated,", result.created, "created");
        await notifyLowStockAlerts(result.lowStockAlerts);
        res.send(result);
      } catch (err) {
        console.error("[cron sync-google-sheet] failed:", err);
        res.status(500).send({ error: true, message: err.message });
      }
    });

    // order stats
    // not used
    app.get("/order-stats", verifyJWT, verifyAdmin, async (req, res) => {
      const pipeline = [
        {
          $lookup: {
            from: "menu",
            localField: "menuItems",
            foreignField: "_id",
            as: "menuItemsData",
          },
        },

        {
          $unwind: "$menuItemsData",
        },
        {
          $group: {
            _id: "$menuItemsData.category",
            count: { $sum: 1 },
            total: { $sum: "$menuItemsData.price" },
          },
        },
        {
          $project: {
            category: "$_id",
            count: 1,
            total: { $round: ["$total", 2] },
            _id: 0,
          },
        },
      ];
      const result = await paymentCollection.aggregate(pipeline).toArray();
      res.send(result);
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Book Ocean BD server running");
});
app.listen(port, () => {
  console.log(`Book OCean BD server running ${port}`);
});
