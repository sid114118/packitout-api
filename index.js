const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");

// ==========================================
// 🧾 PARCHI UPLOAD PACKAGES
// ==========================================
const multer = require("multer");
const cloudinary = require("cloudinary").v2;
const fs = require("fs");

// ⚠️ IMPORTANT: Paste your actual Cloudinary keys here before saving!
cloudinary.config({ 
  cloud_name: 'dj48tkcsw', 
  api_key: '272175433165944', 
  api_secret: 'Oum12kRi9FjCa5kPe0ZaEoLTAvQ' 
});

// Create the temporary upload handler
const upload = multer({ dest: 'uploads/' });

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
  isOpen: { type: Boolean, default: true },
  inventory: [{ 
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'MasterProduct' },
    sellingPrice: Number, 
    inStock: { type: Boolean, default: true }
  }] 
});
const Shop = mongoose.model("Shop", shopSchema);

const masterProductSchema = new mongoose.Schema({ 
  name: String, 
  brand: String, 
  category: String, 
  mrp: Number, 
  qnty: String, 
  emoji: String, 
  image: String, 
  searchTags: [String] 
});
const MasterProduct = mongoose.model("MasterProduct", masterProductSchema);

const userSchema = new mongoose.Schema({ 
  name: String, 
  phone: { type: String, unique: true }, 
  password: String, 
  pincode: String, 
  address: String,
  coins: { type: Number, default: 0 }, 
  referralCode: { type: String, unique: true }, 
  referredBy: String,
  primaryShop: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop' } 
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

// 🧾 NEW SCHEMA: Parchi Uploads
const parchiSchema = new mongoose.Schema({
  userId: String, 
  shopId: String,
  customerName: String,
  imageUrl: String,
  status: { type: String, default: 'pending' }, // 'pending' or 'processed'
  createdAt: { type: Date, default: Date.now }
});
const Parchi = mongoose.model("Parchi", parchiSchema);

// ==========================================
// 📮 ROUTES
// ==========================================

// --- 🧾 PARCHI ROUTES ---
app.post("/upload-parchi", upload.single('parchiImage'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No image provided." });

    const result = await cloudinary.uploader.upload(req.file.path, {
      folder: 'packitout_parchis', 
    });

    fs.unlinkSync(req.file.path); // Delete temp file from server

    const newParchi = new Parchi({
      userId: req.body.userId || "Guest_ID",
      shopId: req.body.shopId || "Master_Shop",
      customerName: req.body.customerName || "Customer",
      imageUrl: result.secure_url 
    });
    
    await newParchi.save();
    res.status(200).json({ success: true, message: "Parchi uploaded successfully!", parchi: newParchi });
  } catch (error) {
    console.error("Upload Error:", error);
    res.status(500).json({ error: "Failed to upload image." });
  }
});

app.get("/parchis/:shopId", async (req, res) => {
  try {
    // Fetch only pending parchis for this specific shop
    const parchis = await Parchi.find({ shopId: req.params.shopId, status: 'pending' }).sort({createdAt: -1});
    res.json(parchis);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// --- EXISTING ROUTES ---
app.post("/shops", async (req, res) => {
  try {
    const newShop = new Shop(req.body);
    await newShop.save();
    res.json(newShop);
  } catch (err) { res.status(500).json({ error: "Phone number already exists!" }); }
});

app.post("/shop-login", async (req, res) => {
  try {
    const shop = await Shop.findOne({ phone: req.body.phone, password: req.body.password }).populate('inventory.product');
    if (!shop) return res.status(401).json({ error: "Invalid Credentials" });
    res.json(shop);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/shops/find/:pincode", async (req, res) => {
  const shop = await Shop.findOne({ pincode: req.params.pincode });
  shop ? res.json(shop) : res.status(404).json({ error: "No shop here" });
});

app.get("/shops/all/:pincode", async (req, res) => {
  try {
    const shops = await Shop.find({ pincode: req.params.pincode });
    res.json(shops);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/shops/:id/menu", async (req, res) => {
  try {
    const shop = await Shop.findById(req.params.id).populate('inventory.product');
    res.json(shop);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/shops/:shopId/inventory", async (req, res) => {
  try {
    const { productId, sellingPrice, inStock } = req.body;
    
    const shop = await Shop.findById(req.params.shopId);
    if (!shop) return res.status(404).json({ error: "Shop not found" });

    const existingIndex = shop.inventory.findIndex(
      item => item.product && item.product.toString() === productId
    );

    if (existingIndex > -1) {
      const updateData = {};
      if (sellingPrice !== undefined) updateData[`inventory.${existingIndex}.sellingPrice`] = Number(sellingPrice);
      if (inStock !== undefined) updateData[`inventory.${existingIndex}.inStock`] = inStock;
      await Shop.updateOne({ _id: req.params.shopId }, { $set: updateData });
    } else {
      await Shop.updateOne(
        { _id: req.params.shopId },
        { $push: { inventory: { product: productId, sellingPrice: Number(sellingPrice), inStock: true } } }
      );
    }

    const updatedShop = await Shop.findById(req.params.shopId).populate('inventory.product'); 
    res.json(updatedShop);
  } catch (err) { 
    res.status(500).json({ error: err.message }); 
  }
});

app.patch("/shops/:id", async (req, res) => {
  try {
    const shop = await Shop.findByIdAndUpdate(req.params.id, req.body, { new: true }).populate('inventory.product');
    res.json(shop);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/admin/shop-analysis/:shopId", async (req, res) => {
  try {
    const masterItems = await MasterProduct.find();
    const shop = await Shop.findById(req.params.shopId).populate('inventory.product');

    if (!shop) return res.status(404).send("Shop not found");

    const shopProductIds = shop.inventory
      .filter(item => item.product) 
      .map(item => item.product._id.toString());
    
    const missingItems = masterItems.filter(item => !shopProductIds.includes(item._id.toString()));

    res.json({
      shopName: shop.name,
      activeCount: shop.inventory.length,
      missingCount: missingItems.length,
      missingItems: missingItems
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/shops", async (req, res) => res.json(await Shop.find()));
app.get("/users", async (req, res) => res.json(await User.find().sort({createdAt: -1})));

app.post("/master-products", async (req, res) => {
  try {
    const p = new MasterProduct({
      ...req.body, 
      mrp: Number(req.body.mrp), 
      searchTags: req.body.searchTags?.split(',').map(t => t.trim())
    });
    await p.save(); 
    res.json(p);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/master-products", async (req, res) => res.json(await MasterProduct.find()));

app.post("/orders", async (req, res) => { 
  try {
    const o = new Order(req.body); 
    await o.save(); 
    res.json(o); 
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/orders", async (req, res) => res.json(await Order.find().populate('userId').populate('shopId').sort({createdAt: -1})));

app.patch("/orders/:id", async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });

    if (req.body.status === "Delivered ✅" && order.status !== "Delivered ✅") {
      const earnedCoins = Math.floor(order.totalAmount / 10);
      await User.findByIdAndUpdate(order.userId, { $inc: { coins: earnedCoins } });
    }

    order.status = req.body.status;
    await order.save();
    res.json(order);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

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
  } catch (err) { res.status(500).json({ error: "Phone number already registered." }); } 
});

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
    } else { res.status(400).send("Fail"); }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

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

app.patch("/users/:id", async (req, res) => {
  try {
    const updateData = { ...req.body };
    if (updateData.primaryShop === "") updateData.primaryShop = null;
    const updatedUser = await User.findByIdAndUpdate(req.params.id, updateData, { new: true }).populate('primaryShop');
    res.json(updatedUser);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(8080);
