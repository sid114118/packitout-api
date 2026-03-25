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

// 1. The Item Blueprint (From earlier)
const itemSchema = new mongoose.Schema({ name: String });
const Item = mongoose.model("Item", itemSchema);

// 2. NEW: The Shop Blueprint
const shopSchema = new mongoose.Schema({
  name: String,
  pincode: String
});
const Shop = mongoose.model("Shop", shopSchema);

// --- 📮 THE MAILBOXES ---

// Items Mailboxes (Keeps your current list working)
app.get("/items", async (req, res) => {
  const items = await Item.find();
  res.json(items);
});
app.post("/items", async (req, res) => {
  const newItem = new Item({ name: req.body.name });
  await newItem.save();
  res.json(newItem);
});

// NEW: Shop Mailboxes
// Mailbox A: Get all shops for a specific pincode
app.get("/shops/:pincode", async (req, res) => {
  const targetPincode = req.params.pincode;
  const shops = await Shop.find({ pincode: targetPincode });
  res.json(shops);
});

// Mailbox B: Add a new shop to the database
app.post("/shops", async (req, res) => {
  const newShop = new Shop({
    name: req.body.name,
    pincode: req.body.pincode
  });
  await newShop.save();
  res.json(newShop);
});

// The standard heartbeat check
app.get("/", (req, res) => {
  res.send("📦 PackItOut API is live! Now supporting Pincodes and Shops.");
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});
