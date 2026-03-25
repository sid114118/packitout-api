const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const MONGO_URI = process.env.MONGO_URI;
mongoose.connect(MONGO_URI)
  .then(() => console.log("✅ SUCCESS: Master Database Connected!"))
  .catch((err) => console.log("❌ ERROR:", err));

// ==========================================
// 🏗️ THE 4 MASTER BLUEPRINTS (SCHEMA)
// ==========================================

// 1. USERS
const userSchema = new mongoose.Schema({
  phone: String,
  name: String,
  address: String,
  pincode: String,
  createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model("User", userSchema);

// 2. SHOPS
const shopSchema = new mongoose.Schema({
  name: String,
  pincode: String,
  isOpen: { type: Boolean, default: true }
});
const Shop = mongoose.model("Shop", shopSchema);

// 3. PRODUCTS
const productSchema = new mongoose.Schema({
  name: String,
  category: String, // e.g., "Snacks", "Grocery"
  price: Number,
  discountPercentage: Number,
  shopPincode: String, // Which area this product is available in
  emoji: String,
  inStock: { type: Boolean, default: true }
});
const Product = mongoose.model("Product", productSchema);

// 4. ORDERS (The "Parchi" / Checkout)
const orderSchema = new mongoose.Schema({
  userPhone: String,
  shopPincode: String,
  items: Array, // Array of products bought
  totalAmount: Number,
  status: { type: String, default: "Pending" }, // Pending, Packed, Out for Delivery
  orderDate: { type: Date, default: Date.now }
});
const Order = mongoose.model("Order", orderSchema);


// ==========================================
// 📮 THE MAILBOXES (API ROUTES)
// ==========================================

// Get all products for a specific pincode
app.get("/products/:pincode", async (req, res) => {
  const products = await Product.find({ shopPincode: req.params.pincode, inStock: true });
  res.json(products);
});

// Get Top Deals for the carousel
app.get("/deals/:pincode", async (req, res) => {
  const deals = await Product.find({ shopPincode: req.params.pincode })
                             .sort({ discountPercentage: -1 })
                             .limit(5);
  res.json(deals);
});

// Get Shops by Pincode
app.get("/shops/:pincode", async (req, res) => {
  const shops = await Shop.find({ pincode: req.params.pincode });
  res.json(shops);
});


// ==========================================
// 🪄 THE MASTER SEED (DUMMY DATA INJECTOR)
// ==========================================
app.get("/seed", async (req, res) => {
  try {
    // 1. Clear the old database
    await User.deleteMany({});
    await Shop.deleteMany({});
    await Product.deleteMany({});
    await Order.deleteMany({});

    // 2. Inject 1 Dummy User
    await User.create({ phone: "9876543210", name: "Demo User", address: "Flat 101, Galaxy Apts", pincode: "110001" });

    // 3. Inject Shops
    await Shop.insertMany([
      { name: "Sharma Groceries", pincode: "110001", isOpen: true },
      { name: "Rahul Supermart", pincode: "110001", isOpen: true },
      { name: "City Hardware", pincode: "110002", isOpen: true }
    ]);

    // 4. Inject a massive Product Catalog
    await Product.insertMany([
      // Grocery & Kitchen
      { name: "Aashirvaad Atta 5kg", category: "Grocery & Kitchen", price: 250, discountPercentage: 10, shopPincode: "110001", emoji: "🌾" },
      { name: "Tata Salt 1kg", category: "Grocery & Kitchen", price: 28, discountPercentage: 5, shopPincode: "110001", emoji: "🧂" },
      { name: "Fortune Sunflower Oil 1L", category: "Grocery & Kitchen", price: 150, discountPercentage: 15, shopPincode: "110001", emoji: "🍶" },
      // Snacks & Drinks
      { name: "Maggi 2-Min Noodles", category: "Snacks & Drinks", price: 14, discountPercentage: 0, shopPincode: "110001", emoji: "🍜" },
      { name: "Cadbury Dairy Milk Silk", category: "Snacks & Drinks", price: 100, discountPercentage: 20, shopPincode: "110001", emoji: "🍫" },
      { name: "Lays India's Magic Masala", category: "Snacks & Drinks", price: 20, discountPercentage: 0, shopPincode: "110001", emoji: "🥨" },
      // Personal Care
      { name: "Dettol Soap Pack of 4", category: "Household & Personal Care", price: 140, discountPercentage: 25, shopPincode: "110001", emoji: "🧼" }
    ]);

    res.send("✅ MASTER MAGIC COMPLETE! Users, Shops, Products, and Orders databases are fully configured and loaded with test data.");
  } catch (err) {
    res.status(500).send("❌ Database Error: " + err.message);
  }
});

// Heartbeat
app.get("/", (req, res) => { res.send("📦 API is live with Master Architecture!"); });

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => { console.log(`Server listening on port ${PORT}`); });
