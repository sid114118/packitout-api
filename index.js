const express = require("express"); // 👈 Fixed the capital 'c'
const mongoose = require("mongoose");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const MONGO_URI = process.env.MONGO_URI;
mongoose.connect(MONGO_URI).then(() => console.log("✅ DB Connected")).catch(err => console.log(err));

// ==========================================
// 🏗️ SCHEMAS
// ==========================================
const shopSchema = new mongoose.Schema({ 
  name: String, 
  pincode: String, 
  phone: { type: String, unique: true }, 
  password: { type: String, required: true }, 
  isOpen: { type: Boolean, default: true } 
});
const Shop = mongoose.model("Shop", shopSchema);

const masterProductSchema = new mongoose.Schema({ name: String, brand: String, category: String, mrp: Number, qnty: String, emoji: String, searchTags: [String] });
const MasterProduct = mongoose.model("MasterProduct", masterProductSchema);

const userSchema = new mongoose.Schema({ 
  name: String, 
  phone: { type: String, unique: true }, 
  password: String, 
  pincode: String, 
  address: String,
  coins: { type: Number, default: 0 } // 🪙 Every new user starts with 0 coins
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
// 📮 ROUTES
// ==========================================

app.post("/shops", async (req, res) => {
  try {
    const newShop = new Shop(req.body);
    await newShop.save();
    res.json(newShop);
  } catch (err) { res.status(500).json({ error: "Phone number already exists!" }); }
});

app.post("/shop-login", async (req, res) => {
  try {
    const shop = await Shop.findOne({ phone: req.body.phone, password: req.body.password });
    if (!shop) return res.status(401).json({ error: "Invalid Credentials" });
    res.json(shop);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/shops/find/:pincode", async (req, res) => {
  const shop = await Shop.findOne({ pincode: req.params.pincode });
  shop ? res.json(shop) : res.status(404).json({ error: "No shop here" });
});

app.post("/master-products", async (req, res) => {
  const p = new MasterProduct({...req.body, mrp: Number(req.body.mrp), searchTags: req.body.searchTags?.split(',').map(t => t.trim())});
  await p.save(); res.json(p);
});

app.get("/master-products", async (req, res) => res.json(await MasterProduct.find()));

// --- 🛒 ORDER ROUTES WITH SECURE LOYALTY REWARDS ---

// 1. Create Order (NO COINS GIVEN YET)
app.post("/orders", async (req, res) => { 
  try {
    const o = new Order(req.body); 
    await o.save(); 
    res.json(o); 
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/orders", async (req, res) => res.json(await Order.find().populate('userId').populate('shopId').sort({createdAt: -1})));

// 2. Update Order Status (🪙 COINS AWARDED HERE)
app.patch("/orders/:id", async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });

    // 🛡️ SECURITY CHECK: Give coins ONLY if status changes to Delivered for the first time
    if (req.body.status === "Delivered ✅" && order.status !== "Delivered ✅") {
      const earnedCoins = Math.floor(order.totalAmount / 10);
      await User.findByIdAndUpdate(order.userId, { $inc: { coins: earnedCoins } });
    }

    // Update status and save
    order.status = req.body.status;
    await order.save();

    res.json(order);
  } catch (err) { 
    res.status(500).json({ error: err.message }); 
  }
});

// --- 👤 USER & AUTH ROUTES ---

app.post("/register", async (req, res) => { const u = new User(req.body); await u.save(); res.json(u); });

app.post("/login", async (req, res) => {
  const u = await User.findOne({ phone: req.body.phone, password: req.body.password });
  u ? res.json(u) : res.status(400).send("Fail");
});

// Fetch fresh user data (to check coin balance)
app.get("/users/:id", async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    res.json(user);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(8080);
