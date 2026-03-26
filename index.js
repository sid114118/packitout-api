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

const shopSchema = new mongoose.Schema({ 
  name: String, 
  pincode: String, 
  phone: String,
  isOpen: { type: Boolean, default: true } 
});
const Shop = mongoose.model("Shop", shopSchema);

const masterProductSchema = new mongoose.Schema({ 
  name: String, 
  brand: String, 
  category: String, 
  mrp: Number, 
  qnty: String, 
  emoji: String, 
  searchTags: [String] 
});
const MasterProduct = mongoose.model("MasterProduct", masterProductSchema);

const userSchema = new mongoose.Schema({ 
  name: String, 
  phone: { type: String, unique: true }, 
  password: String, 
  pincode: String, 
  address: String, 
  createdAt: { type: Date, default: Date.now } 
});
const User = mongoose.model("User", userSchema);

const orderSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  shopId: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop' }, 
  items: Array, 
  totalAmount: Number,
  status: { type: String, default: "Pending" }, 
  createdAt: { type: Date, default: Date.now }
});
const Order = mongoose.model("Order", orderSchema);

// ==========================================
// 📮 THE MAILBOXES (API ROUTES)
// ==========================================

// --- 🏪 SHOP ROUTES ---

// Create a new shop (Admin)
app.post("/shops", async (req, res) => {
  try {
    const newShop = new Shop(req.body);
    await newShop.save();
    res.json(newShop);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Find a shop by Pincode (Used by Customer Cart)
app.get("/shops/find/:pincode", async (req, res) => {
  try {
    const shop = await Shop.findOne({ pincode: req.params.pincode });
    if (!shop) return res.status(404).json({ error: "No shop found in this area" });
    res.json(shop);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- 🍎 PRODUCT ROUTES ---

app.post("/master-products", async (req, res) => {
  try {
    const newProduct = new MasterProduct({
      ...req.body,
      mrp: Number(req.body.mrp),
      searchTags: req.body.searchTags ? req.body.searchTags.split(',').map(t => t.trim()) : []
    });
    await newProduct.save();
    res.json(newProduct);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/master-products", async (req, res) => {
  try {
    const products = await MasterProduct.find();
    res.json(products);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- 🛒 ORDER ROUTES ---

// Submit a new order
app.post("/orders", async (req, res) => {
  try {
    const newOrder = new Order(req.body);
    await newOrder.save();
    res.json(newOrder);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get all orders (with User Details populated)
app.get("/orders", async (req, res) => {
  try {
    const orders = await Order.find()
      .populate('userId', 'name phone address pincode')
      .populate('shopId', 'name')
      .sort({ createdAt: -1 });
    res.json(orders);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- 👤 AUTH ROUTES ---

app.post("/register", async (req, res) => {
  try {
    const newUser = new User(req.body);
    await newUser.save();
    res.json(newUser);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/login", async (req, res) => {
  try {
    const user = await User.findOne({ phone: req.body.phone, password: req.body.password });
    if (!user) return res.status(400).json({ error: "Invalid credentials" });
    res.json(user);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Heartbeat
app.get("/", (req, res) => res.send("🚀 PackItOut API v2: Pincode Routing Enabled!"));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Listening on ${PORT}`));
