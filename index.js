const express = require("express");
const cors = require("cors");
const compression = require("compression"); // Added for speed
const { ObjectId, MongoClient, ServerApiVersion} = require("mongodb");
const jwt = require("jsonwebtoken");
require("dotenv").config();
const { initFirebaseAdminLite } = require("./firebaseAdminLite");
const { sendOrderStatusEmail, sendNewOrderAdminEmail, sendPasswordResetEmail, sendVerificationEmail } = require("./mailer");

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

    // create users api
    app.post("/users", async (req, res) => {
      const user = req.body;
      const query = { email: user.email };
      const exixtingUser = await usersCollection.findOne(query);
      console.log("exixting user ", exixtingUser);
      if (exixtingUser) {
        return res.send({ message: "User All ready exist" });
      }
      const result = await usersCollection.insertOne(user);
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
    // delete user
    app.delete("/users/:id", verifyJWT, async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await usersCollection.deleteOne(query);
      res.send(result);
    });

    // books
    app.get("/books", async (req, res) => {
      const result = await booksCollection.find().toArray();
      res.send(result);
    });
    // post  books
    app.post("/books", verifyJWT, verifyAdmin, async (req, res) => {
      const query = req.body;
      const result = await booksCollection.insertOne(query);
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
      const updatedBook = {
        $set: {
          name: bookInfo.name,
          author: bookInfo.author,
          category: bookInfo.category,
          price: bookInfo.price,
          cover: bookInfo.cover,
          available: bookInfo.available,
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
      const result = await booksCollection.updateOne(
        filter,
        updatedBook,
        option
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

    // cart insart
    app.post("/carts", async (req, res) => {
      const item = req.body;
      const query = { bookId: item.bookId };

      // check exixting
      // const exixtingCartItem = await cartCollection.findOne(query);
      // console.log("exixted", exixtingCartItem);
      // if (exixtingCartItem) {
      //   return res.send({ message: "Existed" });
      // }
      const result = await cartCollection.insertOne(item);
      res.send(result);
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
    // delete cart
    app.delete("/carts/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await cartCollection.deleteOne(query);
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

    app.post("/orders", verifyJWT, async (req, res) => {
      const orders = req.body;
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

      res.send({ insertResult, deleteResult });
    });
    // get allorder
    app.get("/allOrders", async (req, res) => {
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
    // order approve
    app.patch("/orders/approve-order/:id", verifyJWT, async (req, res) => {
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
      }
      res.send(result);
    });
    // order cancel
    app.patch("/orders/cancel-order/:id", verifyJWT, async (req, res) => {
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
      }
      res.send(result);
    });
    // order delivery
    app.patch("/orders/delivery-order/:id", verifyJWT, async (req, res) => {
      const id = req.params.id;
      console.log(id);
      const filter = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: {
          status: "delivered",
        },
      };
      const result = await ordersCollection.updateOne(filter, updateDoc);
      // no email on delivery - only approve/cancel send a notification
      res.send(result);
    });

    // order cancel
    // delete cart
    app.delete("/orders/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
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
