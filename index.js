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

// --- 📝 THE BLUEPRINT ---
// This tells MongoDB what an "Item" looks like
const itemSchema = new mongoose.Schema({
  name: String
});
const Item = mongoose.model("Item", itemSchema);

// --- 📮 THE MAILBOXES ---
// Mailbox 1: Send all items to the frontend
app.get("/items", async (req, res) => {
  const items = await Item.find();
  res.json(items);
});

// Mailbox 2: Receive a new item from the frontend and save it
app.post("/items", async (req, res) => {
  const newItem = new Item({ name: req.body.name });
  await newItem.save();
  res.json(newItem);
});

// The standard heartbeat check
app.get("/", (req, res) => {
  res.send("📦 PackItOut API is officially live and SECURE!");
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});
