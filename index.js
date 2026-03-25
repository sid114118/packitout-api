const express = require("express"); // 👈 Fixed the capital C typo here!
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

// 1. THE MASTER CATALOG (Super Admin Dictionary)
const masterProductSchema = new mongoose.Schema({
  name: String,
  brand: String,
  category: String,
  mrp: Number,
  qnty: String, // e.g., "70g", "1 Litre"
  emoji: String,
  searchTags: [String]
});
const MasterProduct = mongoose.model("MasterProduct", masterProductSchema);

// 2. SHOP INVENTORY (The specific items on a specific shop's shelf)
const shopInventorySchema = new mongoose.Schema({
  shopId: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop' },
  masterProductId: { type: mongoose.Schema.Types.ObjectId, ref: 'MasterProduct' },
  sellingPrice: Number,
  discountPercentage: Number, // Auto-calculated by comparing Selling Price to Master MRP!
  inStock: { type: Boolean, default: true }
});
const ShopInventory = mongoose.model("ShopInventory", shopInventorySchema);

// 3. PRODUCT REQUESTS (The "Quick-Add" Waiting Room)
const productRequestSchema = new mongoose.Schema({
  shopId: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop' },
  requestedName: String,
  requestedSellingPrice: Number,
  status: { type: String, default: "Pending" }, // Pending, Approved, Rejected
  createdAt: { type: Date, default: Date.now }
});
const ProductRequest = mongoose.model("ProductRequest", productRequestSchema);


// ==========================================
// 📮 THE MAILBOXES (API ROUTES)
// ==========================================

// Add a new Shop
app.post("/shops", async (req, res) => {
  try {
    const newShop = new Shop({ name: req.body.name, pincode: req.body.pincode });
    await newShop.save(); res.json(newShop);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 🌟 NEW: Add a Master Product from the Admin Dashboard!
app.post("/master-products", async (req, res) => {
  try {
    const newProduct = new MasterProduct({
      name: req.body.name,
      brand: req.body.brand,
      category: req.body.category,
      mrp: req.body.mrp,
      qnty: req.body.qnty,
      emoji: req.body.emoji,
      // Converts a string like "snack, sweet" into a proper array format for the database
      searchTags: req.body.searchTags ? req.body.searchTags.split(',').map(tag => tag.trim()) : []
    });
    await newProduct.save();
    res.json(newProduct);
  } catch (err) { 
    res.status(500).json({ error: err.message }); 
  }
});

// Get all product requests for the Admin to see
app.get("/product-requests", async (req, res) => {
  try {
    const requests = await ProductRequest.find().populate('shopId');
    res.json(requests);
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// A Shop adds an item from the Master Catalog to their shelf
app.post("/shop-inventory", async (req, res) => {
  try {
    const master = await MasterProduct.findById(req.body.masterProductId);
    const discount = Math.round(((master.mrp - req.body.sellingPrice) / master.mrp) * 100);

    const newItem = new ShopInventory({
      shopId: req.body.shopId,
      masterProductId: req.body.masterProductId,
      sellingPrice: req.body.sellingPrice,
      discountPercentage: discount 
    });
    await newItem.save();
    res.json(newItem);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// A Shop requests a Custom Product
app.post("/product-requests", async (req, res) => {
  try {
    const newReq = new ProductRequest({
      shopId: req.body.shopId,
      requestedName: req.body.requestedName,
      requestedSellingPrice: req.body.requestedSellingPrice
    });
    await newReq.save();
    res.json(newReq);
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// ==========================================
// 🪄 THE ENTERPRISE SEED (DUMMY DATA INJECTOR)
// ==========================================
app.get("/seed", async (req, res) => {
  try {
    await Shop.deleteMany({}); await MasterProduct.deleteMany({}); 
    await ShopInventory.deleteMany({}); await ProductRequest.deleteMany({});

    const sharmaShop = await Shop.create({ name: "Sharma Groceries", pincode: "110001" });

    const maggiMaster = await MasterProduct.create({ name: "Maggi 2-Min Noodles", brand: "Nestle", category: "Snacks", mrp: 14, qnty: "70g", emoji: "🍜", searchTags: ["noodles", "instant", "snack"] });
    const attaMaster = await MasterProduct.create({ name: "Aashirvaad Atta", brand: "ITC", category: "Grocery", mrp: 250, qnty: "5kg", emoji: "🌾", searchTags: ["flour", "wheat", "roti"] });

    await ShopInventory.create({ shopId: sharmaShop._id, masterProductId: maggiMaster._id, sellingPrice: 12, discountPercentage: Math.round(((14-12)/14)*100) });
    await ShopInventory.create({ shopId: sharmaShop._id, masterProductId: attaMaster._id, sellingPrice: 220, discountPercentage: Math.round(((250-220)/250)*100) });

    await ProductRequest.create({ shopId: sharmaShop._id, requestedName: "Kanpur Special Namkeen", requestedSellingPrice: 45 });

    res.send("✅ ENTERPRISE UPGRADE COMPLETE! Database reformatted and Master Product route is live.");
  } catch (err) {
    res.status(500).send("❌ Database Error: " + err.message);
  }
});

// Heartbeat
app.get("/", (req, res) => { res.send("📦 API is live with Enterprise Architecture!"); });

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => { console.log(`Server listening on port ${PORT}`); });
                                          
