const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const multer = require("multer");
const cloudinary = require("cloudinary").v2;
const fs = require("fs");

// ==========================================
// 🧾 PARCHI UPLOAD PACKAGES
// ==========================================
cloudinary.config({ 
  cloud_name: 'dj48tkcsw', 
  api_key: '272175433165944', 
  api_secret: 'Oum12kRi9FjCa5kPe0ZaEoLTAvQ' 
});

const upload = multer({ dest: '/tmp/' });
const app = express();

// 🌐 UPGRADED CORS: Prevents "Failed to Fetch" on mobile
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PATCH", "PUT", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use(express.json());

const MONGO_URI = process.env.MONGO_URI;
mongoose.connect(MONGO_URI)
  .then(() => console.log("✅ DB Connected"))
  .catch(err => console.log(err));

// ==========================================
// 🏗️ SCHEMAS
// ==========================================

const shopSchema = new mongoose.Schema({ 
  name: String, 
  ownerName: { type: String, default: "" },      
  fullAddress: { type: String, default: "" },    
  operatingHours: { type: String, default: "09:00 AM - 10:00 PM" }, 
  shopImage: { type: String, default: "" },  
  phone: { type: String, unique: true }, 
  password: { type: String, required: true },
  
  pincode: String, 
  serviceablePincodes: { type: [String], default: [] }, 
  isOpen: { type: Boolean, default: true },
  isAcceptingOrders: { type: Boolean, default: true },

  fssai: { type: String, default: "" },          
  gst: { type: String, default: "" },            
  panNumber: { type: String, default: "" },      
  upiId: { type: String, default: "" },          
  
  rating: { type: Number, default: 5.0 },        
  totalOrdersFulfilled: { type: Number, default: 0 }, 

  inventoryMode: { type: String, enum: ['manual', 'stock_count'], default: 'manual' },

  inventory: [{ 
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'MasterProduct' },
    sellingPrice: Number, 
    stockCount: { type: Number, default: 0 },    
    inStock: { type: Boolean, default: true },
    
    // 👇 NEW: BULK DISCOUNT LOGIC (Buy 2 for ₹75, etc.)
    bulkOffer: {
      isActive: { type: Boolean, default: false },
      buyQty: { type: Number, default: 0 },
      offerPrice: { type: Number, default: 0 }
    }
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
  searchTags: [String],
  description: { type: String, default: "" },
  manufacturer: { type: String, default: "" },
  energy: { type: String, default: "" },
  protein: { type: String, default: "" },
  carbs: { type: String, default: "" },
  sugar: { type: String, default: "" },
  fat: { type: String, default: "" },
  isVeg: { type: Boolean, default: true },    // For the Green/Red dot UI

  // 👇 NEW: MULTIPLE QUANTITIES (VARIANTS) e.g., "COKE" groups all sizes together
  itemGroupId: { type: String, default: "" },

  // 👇 NEW: FREQUENTLY BOUGHT TOGETHER (Cross-Selling)
  relatedProducts: [{ type: mongoose.Schema.Types.ObjectId, ref: 'MasterProduct' }],

  // 👇 NEW: OUT OF STOCK SUBSTITUTES
  substitutes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'MasterProduct' }]
});
const MasterProduct = mongoose.model("MasterProduct", masterProductSchema);

const userSchema = new mongoose.Schema({ 
  name: String, phone: { type: String, unique: true }, 
  password: String, pincode: String, address: String,
  coins: { type: Number, default: 0 }, referralCode: { type: String, unique: true }, 
  referredBy: String, primaryShop: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop' } 
});
const User = mongoose.model("User", userSchema);

const orderSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  shopId: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop' }, 
  items: Array, 
  totalAmount: Number,
  imageUrl: { type: String, default: "" }, 
  status: { type: String, default: "Pending" }, 
  
  // 🌟 NEW: PAYMENT TRACKING FIELDS 🌟
  paymentMethod: { type: String, default: "UPI" },
  paymentStatus: { type: String, default: "Unpaid" },
  
  createdAt: { type: Date, default: Date.now }
});
const Order = mongoose.model("Order", orderSchema);

const parchiSchema = new mongoose.Schema({
  userId: String, 
  shopId: String,
  customerName: String,
  imageUrl: String,
  status: { type: String, default: 'pending' }, 
  createdAt: { type: Date, default: Date.now }
});
const Parchi = mongoose.model("Parchi", parchiSchema);

const notificationSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, 
  shopId: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop', default: null }, 
  title: String,
  message: String,
  isRead: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});
const Notification = mongoose.model("Notification", notificationSchema);

// ==========================================
// 🚀 ONESIGNAL PUSH NOTIFICATION HELPER
// ==========================================
const sendPushNotification = async (targetUserId, title, message) => {
  const ONE_SIGNAL_APP_ID = "1da2e78d-0874-4965-a895-42c9237ee92b"; 
  const ONE_SIGNAL_API_KEY = "26vkocoebe75v5dljzlncxcnx"; 

  try {
    const response = await fetch("https://onesignal.com/api/v1/notifications", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Authorization": `Basic ${ONE_SIGNAL_API_KEY}`
      },
      body: JSON.stringify({
        app_id: ONE_SIGNAL_APP_ID,
        include_external_user_ids: [targetUserId.toString()], // Targets exact MongoDB _id
        headings: { en: title },
        contents: { en: message },
      })
    });
    const data = await response.json();
    console.log("Push Sent Result:", data);
  } catch (err) {
    console.error("OneSignal Error:", err);
  }
};

// ==========================================
// 📮 ROUTES
// ==========================================

app.get("/ping", (req, res) => res.send("PackItOut Server is ALIVE! 🟢"));

// --- NOTIFICATION ROUTES ---
app.get("/notifications/user/:userId", async (req, res) => {
  try { res.json(await Notification.find({ userId: req.params.userId }).sort({ createdAt: -1 }).limit(20)); } 
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/notifications/shop/:shopId", async (req, res) => {
  try { res.json(await Notification.find({ shopId: req.params.shopId }).sort({ createdAt: -1 }).limit(20)); } 
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch("/notifications/read-all", async (req, res) => {
  try {
    const { userId, shopId } = req.body;
    const query = userId ? { userId } : { shopId };
    await Notification.updateMany(query, { $set: { isRead: true } });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- PARCHI ROUTES ---
app.post("/upload-parchi", upload.single('parchiImage'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No image." });
    const result = await cloudinary.uploader.upload(req.file.path, { folder: 'packitout_parchis' });
    fs.unlinkSync(req.file.path);

    const newParchi = new Parchi({
      userId: req.body.userId,
      shopId: req.body.shopId,
      customerName: req.body.customerName,
      imageUrl: result.secure_url 
    });
    await newParchi.save();
    res.status(200).json({ success: true, parchi: newParchi });
  } catch (error) { res.status(500).json({ error: "Upload failed." }); }
});

app.get("/parchis/:shopId", async (req, res) => {
  try { res.json(await Parchi.find({ shopId: req.params.shopId, status: 'pending' }).sort({createdAt: -1})); } 
  catch(err) { res.status(500).json({ error: err.message }); }
});

app.get("/parchis/user/:userId", async (req, res) => {
  try { res.json(await Parchi.find({ userId: req.params.userId, status: 'pending' }).sort({createdAt: -1})); } 
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/admin/all-parchis", async (req, res) => {
  try { res.json(await Parchi.find({ status: 'pending' }).sort({ createdAt: -1 })); } 
  catch (err) { res.status(500).json({ error: err.message }); }
});

// --- ORDER ROUTES ---
app.post("/orders", async (req, res) => { 
  try {
    const o = new Order(req.body); 
    await o.save(); 
    if (req.body.imageUrl) {
      await Parchi.updateOne({ imageUrl: req.body.imageUrl }, { $set: { status: 'processed' } });
    }
    
    // Save to DB Bell Notification
    await Notification.create({ 
      shopId: o.shopId, 
      title: "New Order! 🚀", 
      message: `Order #${o._id.toString().slice(-5).toUpperCase()} received for ₹${o.totalAmount}` 
    });

    // 📱 PUSH TO MOBILE APP
    await sendPushNotification(
      o.shopId, 
      "New Order! 🚀", 
      `Order #${o._id.toString().slice(-5).toUpperCase()} received for ₹${o.totalAmount}`
    );

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

    // Save to DB Bell Notification
    await Notification.create({ 
      userId: order.userId, 
      title: "Order Update 📦", 
      message: `Your order is now: ${req.body.status}` 
    });

    // 📱 PUSH TO MOBILE APP
    await sendPushNotification(
      order.userId, 
      "Order Update 📦", 
      `Your order is now: ${req.body.status}`
    );

    res.json(order);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- USER ROUTES ---
app.post("/register", async (req, res) => {
  try {
    const baseName = req.body.name ? req.body.name.substring(0, 4).toUpperCase().replace(/\s/g, '') : "PACK";
    const refCode = baseName + Math.floor(1000 + Math.random() * 9000);
    let startingCoins = 0;
    if (req.body.referredBy) {
      const referrer = await User.findOne({ referralCode: req.body.referredBy });
      if (referrer) { referrer.coins += 50; await referrer.save(); startingCoins = 50; }
    }
    const u = new User({ ...req.body, referralCode: refCode, coins: startingCoins }); 
    await u.save(); res.json(u); 
  } catch (err) { res.status(500).json({ error: "Phone number registered." }); } 
});

app.post("/login", async (req, res) => {
  try {
    let u = await User.findOne({ phone: req.body.phone, password: req.body.password }).populate('primaryShop');
    if (u) { res.json(u); } else { res.status(400).send("Fail"); }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/users", async (req, res) => res.json(await User.find().sort({createdAt: -1})));

app.get("/users/:id", async (req, res) => {
  try { res.json(await User.findById(req.params.id).populate('primaryShop')); } 
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch("/users/:id", async (req, res) => {
  try {
    const updateData = { ...req.body };
    if (updateData.primaryShop === "") updateData.primaryShop = null;
    res.json(await User.findByIdAndUpdate(req.params.id, updateData, { new: true }).populate('primaryShop'));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- SHOP ROUTES ---
app.get("/shops", async (req, res) => res.json(await Shop.find()));

app.post("/shops", async (req, res) => {
  try { const newShop = new Shop(req.body); await newShop.save(); res.json(newShop); } 
  catch (err) { res.status(500).json({ error: "Exists" }); }
});

app.post("/shop-login", async (req, res) => {
  try {
    const shop = await Shop.findOne({ phone: req.body.phone, password: req.body.password }).populate('inventory.product');
    if (!shop) return res.status(401).json({ error: "Invalid" });
    res.json(shop);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/shops/all/:pincode", async (req, res) => {
  try { res.json(await Shop.find({ pincode: req.params.pincode })); } 
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/shops/:id/menu", async (req, res) => {
  try { res.json(await Shop.findById(req.params.id).populate('inventory.product')); } 
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/shops/:shopId/inventory", async (req, res) => {
  try {
    const { productId, sellingPrice, inStock } = req.body;
    const shop = await Shop.findById(req.params.shopId);
    const existingIndex = shop.inventory.findIndex(item => item.product && item.product.toString() === productId);
    if (existingIndex > -1) {
      const updateData = {};
      if (sellingPrice !== undefined) updateData[`inventory.${existingIndex}.sellingPrice`] = Number(sellingPrice);
      if (inStock !== undefined) updateData[`inventory.${existingIndex}.inStock`] = inStock;
      await Shop.updateOne({ _id: req.params.shopId }, { $set: updateData });
    } else {
      await Shop.updateOne({ _id: req.params.shopId }, { $push: { inventory: { product: productId, sellingPrice: Number(sellingPrice), inStock: true } } });
    }
    res.json(await Shop.findById(req.params.shopId).populate('inventory.product'));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch("/shops/:id/admin-edit", async (req, res) => {
  try {
    const updatedShop = await Shop.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.json(updatedShop);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch("/shops/:id", async (req, res) => {
  try { res.json(await Shop.findByIdAndUpdate(req.params.id, req.body, { new: true }).populate('inventory.product')); } 
  catch (err) { res.status(500).json({ error: err.message }); }
});

// --- MASTER PRODUCTS ---
app.post("/master-products", async (req, res) => {
  try {
    const p = new MasterProduct({ ...req.body, mrp: Number(req.body.mrp), searchTags: req.body.searchTags?.split(',').map(t => t.trim()) });
    await p.save(); res.json(p);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/master-products", async (req, res) => res.json(await MasterProduct.find()));

app.patch("/master-products/:id", async (req, res) => {
  try {
    let updateData = { ...req.body };
    if (updateData.mrp) updateData.mrp = Number(updateData.mrp);
    if (updateData.searchTags && typeof updateData.searchTags === 'string') {
      updateData.searchTags = updateData.searchTags.split(',').map(t => t.trim());
    }
    const updatedProduct = await MasterProduct.findByIdAndUpdate(req.params.id, updateData, { new: true });
    res.json(updatedProduct);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==========================================
// 🚀 START SERVER
// ==========================================
app.listen(8080, () => console.log("🚀 Server running on port 8080"));
