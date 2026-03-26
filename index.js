const express = require("express");
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

// 👤 USER SCHEMA: Added Primary Shop
const userSchema = new mongoose.Schema({ 
  name: String, 
  phone: { type: String, unique: true }, 
  password: String, 
  pincode: String, 
  address: String,
  coins: { type: Number, default: 0 }, 
  referralCode: { type: String, unique: true }, 
  referredBy: String,
  primaryShop: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop' } // 🏪 NEW: Link to favorite shop
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

// --- 🏪 SHOP ROUTES ---
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

// 👇 NEW: Get ALL shops in a pincode for the user to choose their primary shop
app.get("/shops/all/:pincode", async (req, res) => {
  try {
    const shops = await Shop.find({ pincode: req.params.pincode });
    res.json(shops);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- 🍎 PRODUCT ROUTES ---
app.post("/master-products", async (req, res) => {
  const p = new MasterProduct({...req.body, mrp: Number(req.body.mrp), searchTags: req.body.searchTags?.split(',').map(t => t.trim())});
  await p.save(); res.json(p);
});

app.get("/master-products", async (req, res) => res.json(await MasterProduct.find()));

// --- 🛒 ORDER ROUTES (SECURE LOYALTY LOGIC) ---
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

app.patch("/orders/:id", async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });

    // 🛡️ SECURITY CHECK: Give coins ONLY if status changes to Delivered for the first time
    if (req.body.status === "Delivered ✅" && order.status !== "Delivered ✅") {
      const earnedCoins = Math.floor(order.totalAmount / 10);
      await User.findByIdAndUpdate(order.userId, { $inc: { coins: earnedCoins } });
    }

    order.status = req.body.status;
    await order.save();

    res.json(order);
  } catch (err) { 
    res.status(500).json({ error: err.message }); 
  }
});

// --- 👤 USER & AUTH ROUTES (WITH REFERRAL & PROFILE LOGIC) ---
app.post("/register", async (req, res) => {
  try {
    const baseName = req.body.name ? req.body.name.substring(0, 4).toUpperCase().replace(/\s/g, '') : "PACK";
    const refCode = baseName + Math.floor(1000 + Math.random() * 9000);

    let startingCoins = 0;
    if (req.body.referredBy) {
      const referrer = await User.findOne({ referralCode: req.body.referredBy });
      if (referrer) {
        referrer.coins += 50;
        await referrer.save();
        startingCoins = 50;
      }
    }

    const u = new User({ ...req.body, referralCode: refCode, coins: startingCoins }); 
    await u.save(); 
    res.json(u); 
  } catch (err) { 
    res.status(500).json({ error: "Phone number already registered or server error." }); 
  } 
});

// 👇 UPGRADED: Auto-generates code for old users on Login
app.post("/login", async (req, res) => {
  try {
    let u = await User.findOne({ phone: req.body.phone, password: req.body.password }).populate('primaryShop');
    if (u) {
      if (!u.referralCode) {
        const baseName = u.name ? u.name.substring(0, 4).toUpperCase().replace(/\s/g, '') : "PACK";
        u.referralCode = baseName + Math.floor(1000 + Math.random() * 9000);
        await u.save();
      }
      res.json(u);
    } else {
      res.status(400).send("Fail");
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 👇 UPGRADED: Auto-generates code for old users and populates Primary Shop
app.get("/users/:id", async (req, res) => {
  try {
    let user = await User.findById(req.params.id).populate('primaryShop');
    if (user && !user.referralCode) {
      const baseName = user.name ? user.name.substring(0, 4).toUpperCase().replace(/\s/g, '') : "PACK";
      user.referralCode = baseName + Math.floor(1000 + Math.random() * 9000);
      await user.save();
    }
    res.json(user);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 👇 NEW: Update User Profile (Name, Pincode, Primary Shop)
app.patch("/users/:id", async (req, res) => {
  try {
    // If they set primaryShop to empty string, set it to null in database
    const updateData = { ...req.body };
    if (updateData.primaryShop === "") updateData.primaryShop = null;

    const updatedUser = await User.findByIdAndUpdate(req.params.id, updateData, { new: true }).populate('primaryShop');
    res.json(updatedUser);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(8080);
