const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const MONGO_URI = process.env.MONGO_URI;
mongoose.connect(MONGO_URI)
  .then(() => console.log("✅ SUCCESS: Enterprise Database Connected!"))
  .catch((err) => console.log("❌ ERROR:", err));

// ==========================================
// 🏗️ THE MASTER BLUEPRINTS (SCHEMA)
// ==========================================

const shopSchema = new mongoose.Schema({ name: String, pincode: String, isOpen: { type: Boolean, default: true } });
const Shop = mongoose.model("Shop", shopSchema);

const masterProductSchema = new mongoose.Schema({ name: String, brand: String, category: String, mrp: Number, qnty: String, emoji: String, searchTags: [String] });
const MasterProduct = mongoose.model("MasterProduct", masterProductSchema);

const shopInventorySchema = new mongoose.Schema({ shopId: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop' }, masterProductId: { type: mongoose.Schema.Types.ObjectId, ref: 'MasterProduct' }, sellingPrice: Number, discountPercentage: Number, inStock: { type: Boolean, default: true } });
const ShopInventory = mongoose.model("ShopInventory", shopInventorySchema);

const productRequestSchema = new mongoose.Schema({ shopId: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop' }, requestedName: String, requestedSellingPrice: Number, status: { type: String, default: "Pending" }, createdAt: { type: Date, default: Date.now } });
const ProductRequest = mongoose.model("ProductRequest", productRequestSchema);

const userSchema = new mongoose.Schema({ name: String, phone: { type: String, unique: true }, password: String, pincode: String, address: String, createdAt: { type: Date, default: Date.now } });
const User = mongoose.model("User", userSchema);

// 🛒 NEW: THE ORDER SCHEMA (The Digital Parchi)
const orderSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  shopId: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop' }, 
  items: Array, // The groceries they bought
  totalAmount: Number,
  status: { type: String, default: "Pending" }, // Pending, Accepted, Packing, Delivered
  createdAt: { type: Date, default: Date.now }
});
const Order = mongoose.model("Order", orderSchema);


// ==========================================
// 📮 THE MAILBOXES (API ROUTES)
// ==========================================

// --- NEW: ORDER MAILBOXES ---
// 1. Customer sends an order
app.post("/orders", async (req, res) => {
  try {
    const newOrder = new Order(req.body);
    await newOrder.save();
    res.json(newOrder);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 2. Shopkeeper fetches their live orders
app.get("/orders", async (req, res) => {
  try {
    const orders = await Order.find().populate('userId').sort({ createdAt: -1 }); // Newest first
    res.json(orders);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- EXISTING ROUTES ---
app.post("/register", async (req, res) => { try { const existingUser = await User.findOne({ phone: req.body.phone }); if (existingUser) return res.status(400).json({ error: "Phone number already registered!" }); const newUser = new User(req.body); await newUser.save(); res.json(newUser); } catch (err) { res.status(500).json({ error: err.message }); } });
app.post("/login", async (req, res) => { try { const user = await User.findOne({ phone: req.body.phone, password: req.body.password }); if (!user) return res.status(400).json({ error: "Invalid phone number or password" }); res.json(user); } catch (
  
