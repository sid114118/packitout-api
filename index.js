const express = require("express"); // 👈 Fixed: lowercase 'const'
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

// 1. Master Catalog - ADD PRODUCT (Fixed for errors)
app.post("/master-products", async (req, res) => {
  try {
    const newProduct = new MasterProduct({
      name: req.body.name,
      brand: req.body.brand,
      category: req.body.category,
      mrp: Number(req.body.mrp), // 👈 Ensures it's a number
      qnty: req.body.qnty,
      emoji: req.body.emoji,
      // 🛡️ Safety check for tags
      searchTags: (typeof req.body.searchTags === 'string') ? req.body.searchTags.split(',').map(tag => tag.trim()) : []
    });
    await newProduct.save();
    res.json(newProduct);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 2. Master Catalog - VIEW ALL
app.get("/master-products", async (req, res) => {
  try {
    const products = await MasterProduct.find();
    res.json(products);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 3. Orders - SUBMIT
app.post("/orders", async (req, res) => {
  try {
    const newOrder = new Order(req.body);
    await newOrder.save();
    res.json(newOrder);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 4. Orders - VIEW FOR SHOP
app.get("/orders", async (req, res) => {
  try {
    const orders = await Order.find().populate('userId').sort({ createdAt: -1 });
    res.json(orders);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 5. Auth - REGISTER
app.post("/register", async (req, res) => { 
  try { 
    const existingUser = await User.findOne({ phone: req.body.phone }); 
    if (existingUser) return res.status(400).json({ error: "Phone number already registered!" }); 
    const newUser = new User(req.body); 
    await newUser.save(); 
    res.json(newUser); 
  } catch (err) { res.status(500).json({ error: err.message }); } 
});

// 6. Auth - LOGIN
app.post("/login", async (req, res) => { 
  try { 
    const user = await User.findOne({ phone: req.body.phone, password: req.body.password }); 
    if (!user) return res.status(400).json({ error: "Invalid phone number or password" }); 
    res.json(user); 
  } catch (err) { res.status(500).json({ error: err.message }); } 
});

// 7. PRODUCT REQUESTS
app.get("/product-requests", async (req, res) => {
  try {
    const requests = await ProductRequest.find().populate('shopId');
    res.json(requests);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/product-requests", async (req, res) => {
  try {
    const newReq = new ProductRequest(req.body);
    await newReq.save();
    res.json(newReq);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 8. SHOPS
app.post("/shops", async (req, res) => {
  try {
    const newShop = new Shop(req.body);
    await newShop.save();
    res.json(newShop);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Heartbeat
app.get("/", (req, res) => { res.send("📦 API is live with Enterprise Logic!"); });

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => { console.log(`Server listening on port ${PORT}`); });
