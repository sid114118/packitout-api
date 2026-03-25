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

// 👤 NEW: CUSTOMER USER SCHEMA
const userSchema = new mongoose.Schema({
  name: String,
  phone: { type: String, unique: true }, // Ensures no duplicate accounts
  password: String, 
  pincode: String,
  address: String,
  createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model("User", userSchema);


// ==========================================
// 📮 THE MAILBOXES (API ROUTES)
// ==========================================

// --- NEW: USER AUTHENTICATION ROUTES ---
app.post("/register", async (req, res) => {
  try {
    // 1. Check if phone number already exists
    const existingUser = await User.findOne({ phone: req.body.phone });
    if (existingUser) return res.status(400).json({ error: "Phone number already registered!" });
    
    // 2. Save new user
    const newUser = new User(req.body);
    await newUser.save();
    res.json(newUser);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/login", async (req, res) => {
  try {
    const user = await User.findOne({ phone: req.body.phone, password: req.body.password });
    if (!user) return res.status(400).json({ error: "Invalid phone number or password" });
    res.json(user); // Sends back the user's data so the frontend knows who logged in
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- EXISTING ROUTES ---
app.post("/shops", async (req, res) => { try { const newShop = new Shop({ name: req.body.name, pincode: req.body.pincode }); await newShop.save(); res.json(newShop); } catch (err) { res.status(500).json({ error: err.message }); } });
app.post("/master-products", async (req, res) => { try { const newProduct = new MasterProduct({ name: req.body.name, brand: req.body.brand, category: req.body.category, mrp: req.body.mrp, qnty: req.body.qnty, emoji: req.body.emoji, searchTags: req.body.searchTags ? req.body.searchTags.split(',').map(tag => tag.trim()) : [] }); await newProduct.save(); res.json(newProduct); } catch (err) { res.status(500).json({ error: err.message }); } });
app.get("/master-products", async (req, res) => { try { const products = await MasterProduct.find(); res.json(products); } catch (err) { res.status(500).json({ error: err.message }); } });
app.post("/shop-inventory", async (req, res) => { try { const master = await MasterProduct.findById(req.body.masterProductId); const discount = Math.round(((master.mrp - req.body.sellingPrice) / master.mrp) * 100); const newItem = new ShopInventory({ shopId: req.body.shopId, masterProductId: req.body.masterProductId, sellingPrice: req.body.sellingPrice, discountPercentage: discount }); await newItem.save(); res.json(newItem); } catch (err) { res.status(500).json({ error: err.message }); } });
app.post("/product-requests", async (req, res) => { try { const newReq = new ProductRequest({ shopId: req.body.shopId, requestedName: req.body.requestedName, requestedSellingPrice: req.body.requestedSellingPrice }); await newReq.save(); res.json(newReq); } catch (err) { res.status(500).json({ error: err.message }); } });
app.get("/product-requests", async (req, res) => { try { const requests = await ProductRequest.find().populate('shopId'); res.json(requests); } catch (err) { res.status(500).json({ error: err.message }); } });

// Enterprise Seed
app.get("/seed", async (req, res) => { /* Code omitted for length, same as before */ res.send("Seed route active"); });

// Heartbeat
app.get("/", (req, res) => { res.send("📦 API is live with Enterprise Architecture!"); });

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => { console.log(`Server listening on port ${PORT}`); });
