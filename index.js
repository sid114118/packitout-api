// Load .env first so process.env values are available everywhere below.
try { require("dotenv").config(); } catch (e) { /* dotenv optional in production */ }

const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const multer = require("multer");
const cloudinary = require("cloudinary").v2;
const fs = require("fs");
const csv = require("csvtojson");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const genAI = process.env.GEMINI_API_KEY
  ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
  : null;

// ==========================================
// 🧾 PARCHI UPLOAD PACKAGES
// ==========================================
cloudinary.config({ 
  cloud_name: 'dj48tkcsw', 
  api_key: '272175433165944', 
  api_secret: 'Oum12kRi9FjCa5kPe0ZaEoLTAvQ' 
});

const upload = multer({ dest: '/tmp/' });
const memoryUpload = multer({ storage: multer.memoryStorage() });

const app = express();

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
  totalReviews: { type: Number, default: 0 }, 
  inventoryMode: { type: String, enum: ['manual', 'stock_count'], default: 'manual' },
  inventory: [{ 
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'MasterProduct' },
    sellingPrice: Number, 
    stockCount: { type: Number, default: 0 },    
    inStock: { type: Boolean, default: true },
    bulkOffer: {
      isActive: { type: Boolean, default: false },
      buyQty: { type: Number, default: 0 },
      offerPrice: { type: Number, default: 0 }
    }
  }] 
});
const Shop = mongoose.model("Shop", shopSchema);

const masterProductSchema = new mongoose.Schema({ 
  name: String, brand: String, category: String, mrp: Number, qnty: String, emoji: String, image: String, 
  searchTags: [String], description: { type: String, default: "" }, ingredients: { type: String, default: "" },
  manufacturer: { type: String, default: "" }, manufactureraddress: { type: String, default: ""},
  energy: { type: String, default: "" }, protein: { type: String, default: "" }, carbs: { type: String, default: "" },
  sugar: { type: String, default: "" }, fat: { type: String, default: "" }, isVeg: { type: Boolean, default: true },   
  itemGroupId: { type: String, default: "" },
  relatedProducts: [{ type: mongoose.Schema.Types.ObjectId, ref: 'MasterProduct' }],
  substitutes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'MasterProduct' }]
});
const MasterProduct = mongoose.model("MasterProduct", masterProductSchema);

const userSchema = new mongoose.Schema({ 
  name: String, phone: { type: String, unique: true }, password: String, pincode: String, address: String,
  coins: { type: Number, default: 0 }, referralCode: { type: String, unique: true }, 
  referredBy: String, primaryShop: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop' } 
});
const User = mongoose.model("User", userSchema);

const orderSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  shopId: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop' }, 
  items: Array, totalAmount: Number, imageUrl: { type: String, default: "" }, 
  status: { type: String, default: "Pending" }, paymentMethod: { type: String, default: "UPI" },
  paymentStatus: { type: String, default: "Unpaid" }, isReviewed: { type: Boolean, default: false }, 
  createdAt: { type: Date, default: Date.now }
});
const Order = mongoose.model("Order", orderSchema);

const parchiSchema = new mongoose.Schema({
  userId: String, shopId: String, customerName: String, imageUrl: String,
  status: { type: String, default: 'pending' }, createdAt: { type: Date, default: Date.now }
});
const Parchi = mongoose.model("Parchi", parchiSchema);

const notificationSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, 
  shopId: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop', default: null }, 
  title: String, message: String, isRead: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});
const Notification = mongoose.model("Notification", notificationSchema);

// 🌟 REVIEW SCHEMA
const reviewSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  userName: { type: String, required: true },
  targetId: { type: mongoose.Schema.Types.ObjectId, required: true },
  targetType: { type: String, enum: ['shop', 'product'], required: true },
  rating: { type: Number, required: true, min: 1, max: 5 },
  comment: { type: String, default: '' },
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true }
}, { timestamps: true });

reviewSchema.index({ targetId: 1, targetType: 1 });
const Review = mongoose.model("Review", reviewSchema);

// ==========================================
// 🚀 ONESIGNAL PUSH NOTIFICATION HELPER
// ==========================================
const sendPushNotification = async (targetUserId, title, message) => {
  const ONE_SIGNAL_APP_ID = "1da2e78d-0874-4965-a895-42c9237ee92b"; 
  const ONE_SIGNAL_API_KEY = "26vkocoebe75v5dljzlncxcnx"; 
  try {
    const response = await fetch("https://onesignal.com/api/v1/notifications", {
      method: "POST", headers: { "Content-Type": "application/json; charset=utf-8", "Authorization": `Basic ${ONE_SIGNAL_API_KEY}` },
      body: JSON.stringify({ app_id: ONE_SIGNAL_APP_ID, include_external_user_ids: [targetUserId.toString()], headings: { en: title }, contents: { en: message } })
    });
    const data = await response.json();
    console.log("Push Sent Result:", data);
  } catch (err) { console.error("OneSignal Error:", err); }
};

// ==========================================
// 📮 ROUTES
// ==========================================

app.get("/ping", (req, res) => res.send("PackItOut Server is ALIVE! 🟢"));

// --- NOTIFICATION ROUTES ---
app.get("/notifications/user/:userId", async (req, res) => {
  try { res.json(await Notification.find({ userId: req.params.userId }).sort({ createdAt: -1 }).limit(20)); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get("/notifications/shop/:shopId", async (req, res) => {
  try { res.json(await Notification.find({ shopId: req.params.shopId }).sort({ createdAt: -1 }).limit(20)); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.patch("/notifications/read-all", async (req, res) => {
  try {
    const { userId, shopId } = req.body;
    await Notification.updateMany(userId ? { userId } : { shopId }, { $set: { isRead: true } });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 🚨 ADMIN OVERRIDE PING ROUTE
app.post("/admin/ping-shop", async (req, res) => {
  try {
    const { shopId, orderId } = req.body;
    
    if (!shopId || !orderId) {
      return res.status(400).json({ error: "Missing shopId or orderId" });
    }

    const shortOrder = orderId.toString().slice(-5).toUpperCase();
    const urgentMessage = `🚨 URGENT: Please process Order #${shortOrder} immediately! The customer is waiting.`;
    
    await Notification.create({ 
      shopId: shopId, 
      title: "⚠️ ADMIN ALERT", 
      message: urgentMessage 
    });
    
    await sendPushNotification(shopId, "⚠️ ADMIN ALERT", urgentMessage);
    
    res.json({ success: true });
  } catch (err) { 
    console.error("Ping Error:", err);
    res.status(500).json({ error: err.message }); 
  }
});

// --- PARCHI ROUTES ---
app.post("/upload-parchi", upload.single('parchiImage'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No image." });
    const result = await cloudinary.uploader.upload(req.file.path, { folder: 'packitout_parchis' });
    fs.unlinkSync(req.file.path);
    const newParchi = new Parchi({ userId: req.body.userId, shopId: req.body.shopId, customerName: req.body.customerName, imageUrl: result.secure_url });
    await newParchi.save();
    res.status(200).json({ success: true, parchi: newParchi });
  } catch (error) { res.status(500).json({ error: "Upload failed." }); }
});

// 🤖 AI PARCHI EXTRACTION — reads handwritten list with Gemini and matches to catalog
app.post("/extract-parchi", upload.single('parchiImage'), async (req, res) => {
  if (!genAI) return res.status(500).json({ error: "GEMINI_API_KEY not configured on the server." });
  if (!req.file) return res.status(400).json({ error: "No image." });

  try {
    const shopId = req.body.shopId && mongoose.isValidObjectId(req.body.shopId) ? req.body.shopId : null;

    // Build the catalog the model can match against. Prefer the shop's actual inventory
    // (so prices reflect that shop), fall back to master catalog otherwise.
    let catalogForPrompt = [];
    let priceLookup = {};

    if (shopId) {
      const shop = await Shop.findById(shopId).populate('inventory.product');
      if (shop && shop.inventory) {
        for (const inv of shop.inventory) {
          if (!inv.product || inv.inStock === false) continue;
          const p = inv.product;
          catalogForPrompt.push({
            id: p._id.toString(),
            name: p.name,
            brand: p.brand || "",
            qnty: p.qnty || "",
            category: p.category || "",
          });
          priceLookup[p._id.toString()] = {
            sellingPrice: inv.sellingPrice || p.mrp || 0,
            mrp: p.mrp || 0,
            image: p.image || "",
            emoji: p.emoji || "",
          };
        }
      }
    }
    if (catalogForPrompt.length === 0) {
      const all = await MasterProduct.find({}).limit(2000).lean();
      for (const p of all) {
        catalogForPrompt.push({
          id: p._id.toString(),
          name: p.name,
          brand: p.brand || "",
          qnty: p.qnty || "",
          category: p.category || "",
        });
        priceLookup[p._id.toString()] = {
          sellingPrice: p.mrp || 0,
          mrp: p.mrp || 0,
          image: p.image || "",
          emoji: p.emoji || "",
        };
      }
    }

    const imageBuffer = fs.readFileSync(req.file.path);
    const imagePart = {
      inlineData: {
        data: imageBuffer.toString('base64'),
        mimeType: req.file.mimetype || 'image/jpeg',
      }
    };

    const prompt = `You are reading a customer's handwritten Indian shopping list (called a "parchi"). The text may be in Hindi (Devanagari), English, or a mix. Common Indian grocery items include atta, dal, doodh (milk), chini (sugar), namak (salt), chai, biscuit, maggi, sabji, anda (egg), tel (oil), masala, etc.

Below is the available product catalog at this shop, as a JSON array. Each entry has id, name, brand, qnty (pack size), category.
${JSON.stringify(catalogForPrompt)}

For each LINE on the parchi:
1. Read the item the customer wrote (translate Hindi → English meaning if needed).
2. Find the BEST matching product in the catalog above. Match on item name, brand if mentioned, and pack size if mentioned. If multiple products fit, pick the closest pack size.
3. If no good match exists, set productId to null.
4. Read the quantity the customer wants (e.g. "2 packets" → qty 2, "1 dozen" → qty 12, default 1 if unclear).

Return ONLY a JSON array — no prose, no markdown fences. Shape:
[
  { "rawText": "<what was written>", "productId": "<id from catalog or null>", "qty": <integer>, "note": "<short reason for the match or why it failed>" }
]`;

    const model = genAI.getGenerativeModel({
      model: "gemini-2.0-flash",
      generationConfig: {
        responseMimeType: "application/json",
        temperature: 0.2,
      },
    });

    const result = await model.generateContent([prompt, imagePart]);
    const text = result.response.text();

    // Clean up the temp file
    try { fs.unlinkSync(req.file.path); } catch (e) {}

    let extracted;
    try {
      extracted = JSON.parse(text);
    } catch (e) {
      console.error("Gemini returned non-JSON:", text);
      return res.status(502).json({ error: "AI response could not be parsed.", raw: text });
    }
    if (!Array.isArray(extracted)) extracted = [];

    // Enrich each item with the matched product details + shop price
    const catalogById = {};
    for (const c of catalogForPrompt) catalogById[c.id] = c;

    const items = extracted.map((line) => {
      const productId = line.productId && catalogById[line.productId] ? line.productId : null;
      const qty = Number.isFinite(line.qty) ? Math.max(1, Math.floor(line.qty)) : 1;
      if (productId) {
        const c = catalogById[productId];
        const price = priceLookup[productId] || {};
        return {
          rawText: line.rawText || "",
          matched: true,
          qty,
          note: line.note || "",
          product: {
            _id: productId,
            name: c.name,
            brand: c.brand,
            qnty: c.qnty,
            mrp: price.mrp,
            sellingPrice: price.sellingPrice,
            image: price.image,
            emoji: price.emoji,
          },
        };
      }
      return {
        rawText: line.rawText || "",
        matched: false,
        qty,
        note: line.note || "no match found",
        product: null,
      };
    });

    res.json({ success: true, items });
  } catch (err) {
    console.error("Parchi extraction error:", err);
    try { if (req.file) fs.unlinkSync(req.file.path); } catch (e) {}
    res.status(500).json({ error: err.message || "Extraction failed." });
  }
});
app.get("/parchis/:shopId", async (req, res) => {
  try { res.json(await Parchi.find({ shopId: req.params.shopId, status: 'pending' }).sort({createdAt: -1})); } catch(err) { res.status(500).json({ error: err.message }); }
});
app.get("/parchis/user/:userId", async (req, res) => {
  try { res.json(await Parchi.find({ userId: req.params.userId, status: 'pending' }).sort({createdAt: -1})); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get("/admin/all-parchis", async (req, res) => {
  try { res.json(await Parchi.find({ status: 'pending' }).sort({ createdAt: -1 })); } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- ORDER ROUTES ---
app.post("/orders", async (req, res) => { 
  try {
    const o = new Order(req.body); 
    await o.save(); 
    if (req.body.imageUrl) await Parchi.updateOne({ imageUrl: req.body.imageUrl }, { $set: { status: 'processed' } });
    await Notification.create({ shopId: o.shopId, title: "New Order! 🚀", message: `Order #${o._id.toString().slice(-5).toUpperCase()} received for ₹${o.totalAmount}` });
    await sendPushNotification(o.shopId, "New Order! 🚀", `Order #${o._id.toString().slice(-5).toUpperCase()} received for ₹${o.totalAmount}`);
    res.json(o); 
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get("/orders", async (req, res) => res.json(await Order.find().populate('userId').populate('shopId').sort({createdAt: -1})));

// 🛡️ THE BULLETPROOF ORDER UPDATE ROUTE
app.patch("/orders/:id", async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });
    
    if (req.body.status === "Delivered ✅" && order.status !== "Delivered ✅") {
      const safeAmount = Number(order.totalAmount) || 0;
      const earnedCoins = Math.floor(safeAmount / 10);
      
      if (order.userId && mongoose.Types.ObjectId.isValid(order.userId)) {
        await User.findByIdAndUpdate(order.userId, { $inc: { coins: earnedCoins } });
      }
    }
    
    order.status = req.body.status;
    await order.save();

    if (order.userId && mongoose.Types.ObjectId.isValid(order.userId)) {
      try {
        await Notification.create({ 
          userId: order.userId, 
          title: "Order Update 📦", 
          message: `Your order is now: ${req.body.status}` 
        });
        await sendPushNotification(
          order.userId, 
          "Order Update 📦", 
          `Your order is now: ${req.body.status}`
        );
      } catch (notifErr) {
        console.log("Notification skipped:", notifErr.message);
      }
    }

    res.json(order);
  } catch (err) { 
    console.error("Backend Status Update Error:", err);
    res.status(500).json({ error: err.message }); 
  }
});

// --- 🌟 REVIEW ROUTES ---
app.post("/reviews/order-review", async (req, res) => {
  try {
    const { orderId, shop, items, userId, userName } = req.body;
    const reviewsToInsert = [];

    if (shop && shop.rating > 0) {
      reviewsToInsert.push({ userId, userName, orderId, targetId: shop.shopId, targetType: 'shop', rating: shop.rating, comment: shop.reviewText || '' });
    }

    if (items && items.length > 0) {
      items.forEach(item => {
        if (item.rating > 0) {
          reviewsToInsert.push({ userId, userName, orderId, targetId: item.productId, targetType: 'product', rating: item.rating, comment: '' });
        }
      });
    }

    if (reviewsToInsert.length > 0) {
      await Review.insertMany(reviewsToInsert);
    }

    if (shop && shop.rating > 0) {
      const allShopReviews = await Review.find({ targetId: shop.shopId, targetType: 'shop' });
      const totalScore = allShopReviews.reduce((sum, rev) => sum + rev.rating, 0);
      const avgRating = (totalScore / allShopReviews.length).toFixed(1);
      await Shop.findByIdAndUpdate(shop.shopId, { rating: Number(avgRating), totalReviews: allShopReviews.length });
    }

    await Order.findByIdAndUpdate(orderId, { $set: { isReviewed: true } });
    res.status(200).json({ message: 'Reviews submitted successfully!' });

  } catch (error) {
    console.error("Review submission error:", error);
    res.status(500).json({ error: 'Failed to submit reviews' });
  }
});

app.get("/reviews/shop/:shopId", async (req, res) => {
  try {
    const reviews = await Review.find({ targetId: req.params.shopId, targetType: 'shop' }).sort({ createdAt: -1 }).limit(10);
    res.json(reviews);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/reviews/product/:productId", async (req, res) => {
  try {
    const reviews = await Review.find({ targetId: req.params.productId, targetType: 'product' }).sort({ createdAt: -1 }).limit(15);
    res.json(reviews);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/reviews/order/:orderId", async (req, res) => {
  try {
    const { orderId } = req.params;
    let query = { orderId: orderId };
    if (mongoose.Types.ObjectId.isValid(orderId)) {
      query = { $or: [{ orderId: orderId }, { orderId: new mongoose.Types.ObjectId(orderId) }] };
    }
    const reviews = await Review.find(query);
    res.json(reviews);
  } catch (err) {
    console.error("Fetch Order Reviews Error:", err);
    res.status(500).json({ error: "Failed to load order reviews" });
  }
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
  try { res.json(await User.findById(req.params.id).populate('primaryShop')); } catch (err) { res.status(500).json({ error: err.message }); }
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
  try { const newShop = new Shop(req.body); await newShop.save(); res.json(newShop); } catch (err) { res.status(500).json({ error: "Exists" }); }
});
app.post("/shop-login", async (req, res) => {
  try {
    const shop = await Shop.findOne({ phone: req.body.phone, password: req.body.password }).populate('inventory.product');
    if (!shop) return res.status(401).json({ error: "Invalid" });
    res.json(shop);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get("/shops/all/:pincode", async (req, res) => {
  try { res.json(await Shop.find({ pincode: req.params.pincode })); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get("/shops/:id/menu", async (req, res) => {
  try { res.json(await Shop.findById(req.params.id).populate('inventory.product')); } catch (err) { res.status(500).json({ error: err.message }); }
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
  try { const updatedShop = await Shop.findByIdAndUpdate(req.params.id, req.body, { new: true }); res.json(updatedShop); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.patch("/shops/:id", async (req, res) => {
  try { res.json(await Shop.findByIdAndUpdate(req.params.id, req.body, { new: true }).populate('inventory.product')); } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- MASTER PRODUCTS ---

app.post("/master-products", async (req, res) => {
  try {
    const p = new MasterProduct({ ...req.body, mrp: Number(req.body.mrp), searchTags: req.body.searchTags?.split(',').map(t => t.trim()) });
    await p.save(); res.json(p);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/master-products", async (req, res) => res.json(await MasterProduct.find()));

// ⚠️ THE KILL SWITCH: PURGE ALL PRODUCTS (For Pydroid Script)
// Note: Placed above /:id to ensure Express routes it correctly
app.delete("/master-products/purge-all", async (req, res) => {
  try {
    const masterResult = await MasterProduct.deleteMany({});
    
    // Wipe them from all shop inventories too so your React app doesn't crash trying to load deleted products
    await Shop.updateMany({}, { $set: { inventory: [] } });

    res.json({ 
      message: "🧹 Master Database & Shop Inventories wiped clean!", 
      deletedCount: masterResult.deletedCount
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to purge database." });
  }
});

// 🗑️  DELETE A SINGLE PRODUCT (For Admin UI)
app.delete("/master-products/:id", async (req, res) => {
  try {
    const deletedProduct = await MasterProduct.findByIdAndDelete(req.params.id);
    if (!deletedProduct) {
      return res.status(404).json({ error: "Product not found." });
    }
    
    // Pull this product from all Shop Inventories here so it doesn't leave ghost items
    await Shop.updateMany({}, { $pull: { inventory: { product: req.params.id } } });

    res.json({ message: "Product deleted successfully!" });
  } catch (err) { 
    res.status(500).json({ error: err.message }); 
  }
});

app.patch("/master-products/:id", async (req, res) => {
  try {
    let updateData = { ...req.body };
    if (updateData.mrp) updateData.mrp = Number(updateData.mrp);
    if (updateData.searchTags && typeof updateData.searchTags === 'string') updateData.searchTags = updateData.searchTags.split(',').map(t => t.trim());
    const updatedProduct = await MasterProduct.findByIdAndUpdate(req.params.id, updateData, { new: true });
    res.json(updatedProduct);
  } catch (err) { 
    res.status(500).json({ error: err.message }); 
  }
});

// 🌟 UPDATED BULK UPLOAD WITH QC GATEKEEPER 🌟
app.post("/master-products/bulk-upload", memoryUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No CSV file was uploaded.' });
    const jsonArray = await csv().fromString(req.file.buffer.toString('utf8'));
    
    const formattedProducts = [];
    let skippedCount = 0;

    jsonArray.forEach((row) => {
      // THE QC GATEKEEPER: Reject if missing critical data
      if (!row.name || !row.mrp || (!row.image && !row.emoji)) {
        skippedCount++;
        return; // Skip this product
      }

      formattedProducts.push({
        name: row.name, 
        brand: row.brand || "Generic", 
        category: row.category || "Uncategorized", 
        mrp: Number(row.mrp) || 0, 
        qnty: row.qnty || "1 unit",
        emoji: row.emoji || "", 
        image: row.image || "", 
        searchTags: row.searchTags ? row.searchTags.split(',').map(tag => tag.trim()) : [],
        itemGroupId: row.itemGroupId || "", 
        isVeg: String(row.isVeg).toLowerCase() === 'true',
        description: row.description || "", 
        manufacturer: row.manufacturer || "", 
        energy: row.energy || "",
        protein: row.protein || "", 
        carbs: row.carbs || "", 
        sugar: row.sugar || "", 
        fat: row.fat || "",
        ingredients: row.ingredients || "", 
        manufactureraddress: row.manufactureraddress || ""
      });
    });

    if (formattedProducts.length > 0) {
      await MasterProduct.insertMany(formattedProducts);
    }
    
    res.status(200).json({ 
      message: `Success! Added ${formattedProducts.length} products to the catalog.`,
      skipped: skippedCount > 0 ? `Skipped ${skippedCount} items due to missing data.` : "All items passed QC."
    });
  } catch (error) { 
    res.status(500).json({ error: 'Failed to upload products.' }); 
  }
});


// ==========================================
// ⚡ DYNAMIC BULK IMPORT ROUTE
// ==========================================
app.post("/shops/:shopId/bulk-import", async (req, res) => {
  try {
    const { shopId } = req.params;
    
    // 🚀 Grab the dynamic discount from the frontend (defaults to 0 if not sent)
    const discountPercent = Number(req.body.discountPercent) || 0;

    // 1. Fetch ALL Master Products
    const masterProducts = await MasterProduct.find({});
    
    if (!masterProducts || masterProducts.length === 0) {
      return res.status(400).json({ error: "Master catalog is empty!" });
    }

    // 2. Format them for your Shop.inventory schema with the dynamic discount
    const newInventoryArray = masterProducts.map(product => {
      const baseMrp = Number(product.mrp) || 0;
      
      // 🧮 Math: If input is 10%, multiplier becomes 0.90
      const discountMultiplier = (100 - discountPercent) / 100; 
      const discountedPrice = Math.floor(baseMrp * discountMultiplier); 

      return {
        product: product._id,         // References MasterProduct
        sellingPrice: discountedPrice, // Dynamically discounted price
        stockCount: 100,               
        inStock: true                  
      };
    });

    // 3. Completely replace the shop's existing inventory array
    await Shop.findByIdAndUpdate(shopId, { 
      $set: { inventory: newInventoryArray } 
    });

    res.status(200).json({ 
      success: true,
      message: `Successfully imported ${newInventoryArray.length} products with a ${discountPercent}% discount!` 
    });

  } catch (error) {
    console.error("Bulk Import Error:", error);
    res.status(500).json({ error: "Failed to bulk import products." });
  }
});


// ==========================================
// 🚀 START SERVER
// ==========================================
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
