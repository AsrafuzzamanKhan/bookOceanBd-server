const express = require("express");
const app = express();
const cors = require("cors");
const { ObjectId } = require("mongodb");
const jwt = require("jsonwebtoken");
require("dotenv").config();
const port = process.env.PORT || 5000;

// middleware
app.use(cors());
app.use(express.json());

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

const { MongoClient, ServerApiVersion } = require("mongodb");
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.6kqiq.mongodb.net/?retryWrites=true&w=majority`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

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
    app.post("/jwt", (req, res) => {
      const user = req.body;
      const token = jwt.sign(user, process.env.ACCESS_TOKEN_SECRET, {
        expiresIn: "1h",
      });
      res.send({ token });
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

      //  best way to some of a the price field is to use group and sum operation

      //   const result = await collection.aggregate([
      //   {
      //     $group: {
      //       _id: null,
      //       totalPrice: { $sum: '$price' }
      //     }
      //   }
      // ]).toArray()

      const payments = await ordersCollection.find().toArray();
      const revenue = payments.reduce((sum, payment) => sum + payment.price, 0);

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
