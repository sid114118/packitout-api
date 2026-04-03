const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const multer = require("multer");
const cloudinary = require("cloudinary").v2;
const fs = require("fs");
const csv = require("csvtojson"); 

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
  totalReviews: { type: Number, default: 0 }, // 👈 NEW: Tracks total shop reviews

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
  name: String, 
  brand: String, 
  category: String, 
  mrp: Number, 
  qnty: String, 
  emoji: String, 
  image: String, 
  searchTags: [String],
  description: { type: String, default: "" },
  ingredients: { type: String, default: "" },
  manufacturer: { type: String, default: "" },
  manufactureraddress: { type: String, default: ""},
  energy: { type: String, default: "" },
  protein: { type: String, default: "" },
  carbs: { type: String, default: "" },
  sugar: { type: String, default: "" },
  fat: { type: String, default: "" },
  isVeg: { type: Boolean, default: true },   
  itemGroupId: { type: String, default: "" },
  relatedProducts: [{ type: mongoose.Schema.Types.ObjectId, ref: 'MasterProduct' }],
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
  paymentMethod: { type: String, default: "UPI" },
  paymentStatus: { type: String, default: "Unpaid" },
  
  isReviewed: { type: Boolean, default: false }, // 👈 NEW: Prevents double reviews

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

// 🌟 NEW: REVIEW SCHEMA 🌟
const reviewSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  userName: { type: String, required: true },
  targetId: { type: mongoose.Schema.Types.ObjectId, required: true },
  targetType: { type: String, enum: ['shop', 'product'], required: true },
  rating: { type: Number, required: true, min: 1, max: 5 },
  comment: { type: String, default: '' },
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true }
}, { timestamps: true });

// Index for fast lookups
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
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Authorization": `Basic ${ONE_SIGNAL_API_KEY}`
      },
      body: JSON.stringify({
        app_id: ONE_SIGNAL_APP_ID,
        include_external_user_ids: [targetUserId.toString()],
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
    
    await Notification.create({ 
      shopId: o.shopId, 
      title: "New Order! 🚀", 
      message: `Order #${o._id.toString().slice(-5).toUpperCase()} received for ₹${o.totalAmount}` 
    });

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

    res.json(order);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- 🌟 NEW: REVIEW ROUTE 🌟 ---
app.post("/reviews/order-review", async (req, res) => {
  try {
    const { orderId, shop, items, userId, userName } = req.body;
    const reviewsToInsert = [];

    // 1. Process Shop Review
    if (shop && shop.rating > 0) {
      reviewsToInsert.push({
        userId,
        userName,
        orderId,
        targetId: shop.shopId,
        targetType: 'shop',
        rating: shop.rating,
        comment: shop.reviewText || ''
      });
    }

    // 2. Process Product Reviews
    if (items && items.length > 0) {
      items.forEach(item => {
        if (item.rating > 0) {
          reviewsToInsert.push({
            userId,
            userName,
            orderId,
            targetId: item.productId,
            targetType: 'product',
            rating: item.rating,
            comment: '' 
          });
        }
      });
    }

    // 3. Batch insert to database
    if (reviewsToInsert.length > 0) {
      await Review.insertMany(reviewsToInsert);
    }

    // 4. Update the Shop's live average rating
    if (shop && shop.rating > 0) {
      const allShopReviews = await Review.find({ targetId: shop.shopId, targetType: 'shop' });
      const totalScore = allShopReviews.reduce((sum, rev) => sum + rev.rating, 0);
      const avgRating = (totalScore / allShopReviews.length).toFixed(1);
      
      await Shop.findByIdAndUpdate(shop.shopId, { 
        rating: Number(avgRating),
        totalReviews: allShopReviews.length
      });
    }

    // Get recent reviews for a specific shop
app.get("/reviews/shop/:shopId", async (req, res) => {
  try {
    const reviews = await Review.find({ 
      targetId: req.params.shopId, 
      targetType: 'shop' 
    })
    .sort({ createdAt: -1 }) // Newest first
    .limit(10);
    res.json(reviews);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

    // Get recent reviews for a specific product
app.get("/reviews/product/:productId", async (req, res) => {
  try {
    const reviews = await Review.find({ 
      targetId: req.params.productId, 
      targetType: 'product' 
    })
    .sort({ createdAt: -1 })
    .limit(15);
    res.json(reviews);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
    // --- 🧾 GET REVIEWS FOR A SPECIFIC ORDER ---
app.get("/reviews/order/:orderId", async (req, res) => {
  try {
    const reviews = await Review.find({ orderId: req.params.orderId });
    res.json(reviews);
  } catch (err) {
    console.error("Fetch Order Reviews Error:", err);
    res.status(500).json({ error: "Failed to load order reviews" });
  }
});
    
    
    
    // 5. Mark Order as Reviewed
    await Order.findByIdAndUpdate(orderId, { $set: { isReviewed: true } });

    res.status(200).json({ message: 'Reviews submitted successfully!' });

  } catch (error) {
    console.error("Review submission error:", error);
    res.status(500).json({ error: 'Failed to submit reviews' });
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

// 🚀 BULK UPLOAD CSV ROUTE
app.post("/master-products/bulk-upload", memoryUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No CSV file was uploaded.' });

    const csvString = req.file.buffer.toString('utf8');
    const jsonArray = await csv().fromString(csvString);

    const formattedProducts = jsonArray.map(row => ({
      name: row.name,
      brand: row.brand,
      category: row.category,
      mrp: Number(row.mrp) || 0, 
      qnty: row.qnty,
      emoji: row.emoji || "",
      image: row.image, 
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
    }));

    await MasterProduct.insertMany(formattedProducts);
    res.status(200).json({ message: `Success! Added ${formattedProducts.length} products to the catalog.` });
    
  } catch (error) {
    console.error("Bulk Upload Error:", error);
    res.status(500).json({ error: 'Failed to upload products. Check server logs.' });
  }
});

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
      
