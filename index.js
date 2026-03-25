const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

// 🔒 The Vault
const MONGO_URI = process.env.MONGO_URI;

mongoose.connect(MONGO_URI)
  .then(() => console.log("✅ SUCCESS: Connected to MongoDB!"))
  .catch((err) => console.log("❌ ERROR:", err));

// --- 📝 THE BLUEPRINTS ---
const itemSchema = new mongoose.Schema({ name: String });
const Item = mongoose.model("Item", itemSchema);

const shopSchema = new mongoose.Schema({ name: String, pincode: String });
const Shop = mongoose.model("Shop", shopSchema);

// --- 📮 THE MAILBOXES ---
app.get("/items", async (req, res) => {
  const items = await Item.find();
  res.json(items);
});

app.post("/items", async (req, res) => {
  const newItem = new Item({ name: req.body.name });
  await newItem.save();
  res.json(newItem);
});

app.get("/shops/:pincode", async (req, res) => {
  const shops = await Shop.find({ pincode: req.params.pincode });
  res.json(shops);
});

app.post("/shops", async (req, res) => {
  const newShop = new Shop({ name: req.body.name, pincode: req.body.pincode });
  await newShop.save();
  res.json(newShop);
});

// 🪄 THE MAGIC SEED MAILBOX
app.get("/seed", async (req, res) => {
  try {
    await Shop.deleteMany({}); 
    await Shop.insertMany([
      { name: "Rahul Electronics", pincode: "110001" },
      { name: "Sharma Groceries", pincode: "110001" },
      { name: "City Hardware", pincode: "110002" }
    ]);
    res.send("✅ Magic Complete! 3 Test Shops successfully injected into MongoDB.");
  } catch (err) {
    res.status(500).send("❌ Database Error: " + err.message);
  }
});

// Heartbeat
app.get("/", (req, res) => {
  res.send("📦 PackItOut API is live! Now supporting Pincodes and Shops.");
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});
