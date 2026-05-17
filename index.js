// Load .env first so process.env values are available everywhere below.
try { require("dotenv").config(); } catch (e) { /* dotenv optional in production */ }

const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const multer = require("multer");
const cloudinary = require("cloudinary").v2;
const fs = require("fs");
const csv = require("csvtojson");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const Razorpay = require("razorpay");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const genAI = process.env.GEMINI_API_KEY
  ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
  : null;

const razorpay = (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET)
  ? new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    })
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
  }],
  // 🔐 Session tokens issued at login. Array so the shopkeeper can be logged
  // in on multiple devices; each device's token is independent.
  sessionTokens: {
    type: [{ token: { type: String, index: true }, createdAt: { type: Date, default: Date.now }, _id: false }],
    default: [],
    select: false, // never include in default queries — never want this in client payloads
  },
});
shopSchema.index({ pincode: 1 });
shopSchema.index({ "sessionTokens.token": 1 });
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
  referredBy: String, primaryShop: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop' },
  // 🔐 Session tokens — same pattern as Shop.sessionTokens. select:false so they
  // never leak through generic Mongoose responses (admin user list, /users/:id, etc).
  sessionTokens: {
    type: [{ token: { type: String, index: true }, createdAt: { type: Date, default: Date.now }, _id: false }],
    default: [],
    select: false,
  },
});
userSchema.index({ "sessionTokens.token": 1 });
const User = mongoose.model("User", userSchema);

const orderSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  shopId: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop' },
  items: Array, totalAmount: Number, imageUrl: { type: String, default: "" },
  status: { type: String, default: "Pending" }, paymentMethod: { type: String, default: "UPI" },
  paymentStatus: { type: String, default: "Unpaid" }, isReviewed: { type: Boolean, default: false },
  coinsUsed: { type: Number, default: 0 },
  razorpayOrderId: { type: String, default: "" },
  razorpayPaymentId: { type: String, default: "" },
  razorpaySignature: { type: String, default: "" },
  // 🕒 Customer-chosen pickup time, set at checkout. Null when the order is urgent (ASAP).
  pickupTime: { type: Date, default: null },
  isUrgent: { type: Boolean, default: false },
  statusHistory: {
    type: [{ status: String, at: { type: Date, default: Date.now }, _id: false }],
    default: []
  },
  // 🚨 Escalation tracker for the unresponsive-shop worker.
  // tier: 0=none, 1=loud-push+SMS sent, 2=voice-call placed, 3=auto-cancelled.
  // Persisted so a server restart doesn't re-fire tiers that already went out.
  escalation: {
    tier: { type: Number, default: 0 },
    lastFiredAt: { type: Date, default: null },
  },
  // 🔁 Refund bookkeeping for auto-cancelled paid orders. When the SMS/voice
  // pipeline gives up at T+15min, coins are auto-returned and Razorpay refund is
  // flagged for admin (or auto-fired if AUTO_REFUND_ENABLED=true env is set).
  refund: {
    pending: { type: Boolean, default: false },
    razorpayRefundId: { type: String, default: "" },
    attemptedAt: { type: Date, default: null },
  },
  // 📒 Ops call log — admin notes and force-actions taken on this order.
  // Surfaced in the Live Ops tab so successive admins (or later auditing)
  // can see what was already tried.
  opsLog: {
    type: [{
      at: { type: Date, default: Date.now },
      action: { type: String, default: 'note' }, // note | force_accept | force_cancel | ping
      adminName: { type: String, default: 'admin' },
      text: { type: String, default: '' },
      _id: false,
    }],
    default: [],
  },
  createdAt: { type: Date, default: Date.now }
});
orderSchema.index({ userId: 1, createdAt: -1 });
orderSchema.index({ shopId: 1, createdAt: -1 });
const Order = mongoose.model("Order", orderSchema);

const parchiSchema = new mongoose.Schema({
  userId: String, shopId: String, customerName: String, imageUrl: String,
  status: { type: String, default: 'pending' }, createdAt: { type: Date, default: Date.now }
});
parchiSchema.index({ shopId: 1, status: 1, createdAt: -1 });
parchiSchema.index({ userId: 1, status: 1, createdAt: -1 });
parchiSchema.index({ status: 1, createdAt: -1 });
const Parchi = mongoose.model("Parchi", parchiSchema);

const notificationSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  shopId: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop', default: null },
  title: String, message: String, isRead: { type: Boolean, default: false },
  // orderId lets the frontend deep-link to the related order on tap.
  // type drives the icon (order_placed | order_ready | order_delivered |
  // order_cancelled | new_order | promo | system). Default 'order' for legacy rows.
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null },
  type: { type: String, default: 'order' },
  createdAt: { type: Date, default: Date.now }
});
notificationSchema.index({ userId: 1, createdAt: -1 });
notificationSchema.index({ shopId: 1, createdAt: -1 });
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

// 📣 COMPLAINT SCHEMA
// Customers file complaints from their profile. targetType decides who sees it:
//   - 'shop'/'item' with a shopId → visible to admin + that shop
//   - 'app' or untargeted → admin only
// Replies are an embedded thread — admin and shop both write into the same
// array so the customer sees one unified conversation.
const complaintReplySchema = new mongoose.Schema({
  authorType: { type: String, enum: ['shop', 'admin'], required: true },
  authorName: { type: String, default: '' },
  message: { type: String, required: true, maxlength: 2000 },
  createdAt: { type: Date, default: Date.now },
}, { _id: true });

const complaintSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  userName: { type: String, default: 'Customer' },
  userPhone: { type: String, default: '' },
  targetType: { type: String, enum: ['shop', 'item', 'app'], required: true },
  shopId: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop', default: null },
  itemName: { type: String, default: '' },
  message: { type: String, required: true, maxlength: 2000 },
  status: { type: String, enum: ['open', 'reviewed', 'resolved'], default: 'open' },
  replies: { type: [complaintReplySchema], default: [] },
}, { timestamps: true });

complaintSchema.index({ status: 1, createdAt: -1 });
complaintSchema.index({ shopId: 1, createdAt: -1 });
complaintSchema.index({ userId: 1, createdAt: -1 });
const Complaint = mongoose.model("Complaint", complaintSchema);

// 🔐 OTP REQUEST SCHEMA
// expiresAt has a TTL index so Mongo auto-deletes stale OTPs.
const otpRequestSchema = new mongoose.Schema({
  phone: { type: String, required: true, index: true },
  otp: { type: String, required: true },
  purpose: { type: String, enum: ['register', 'login'], default: 'register' },
  attempts: { type: Number, default: 0 },
  verified: { type: Boolean, default: false },
  consumed: { type: Boolean, default: false },
  expiresAt: { type: Date, required: true },
  createdAt: { type: Date, default: Date.now },
});
otpRequestSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
const OtpRequest = mongoose.model("OtpRequest", otpRequestSchema);

// 🔎 MISSED SEARCH SCHEMA
// One row per unique lowercased term. Count increments every time the
// catalog returns zero results for that term. Pincodes/userIds are kept
// as sets so admin sees who/where the demand is coming from.
const missedSearchSchema = new mongoose.Schema({
  term: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
  count: { type: Number, default: 1 },
  pincodes: { type: [String], default: [] },
  userIds: { type: [String], default: [] },
  resolved: { type: Boolean, default: false, index: true },
  lastSearchedAt: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now },
});
missedSearchSchema.index({ resolved: 1, count: -1, lastSearchedAt: -1 });
const MissedSearch = mongoose.model("MissedSearch", missedSearchSchema);

// 🎯 RANKING CONFIG (singleton)
// One document gates ALL admin ranking control. `enabled=false` means the
// app behaves like the default sort. `brandOrder` is a lowercased,
// ordered list — products of brand at index 0 surface first.
const rankingConfigSchema = new mongoose.Schema({
  singleton: { type: String, default: 'main', unique: true, index: true },
  enabled: { type: Boolean, default: false },
  brandOrder: { type: [String], default: [] },
  updatedAt: { type: Date, default: Date.now },
});
const RankingConfig = mongoose.model("RankingConfig", rankingConfigSchema);

// ==========================================
// 🔐 AUTH VALIDATORS, RATE LIMIT, OTP HELPER
// ==========================================
const validatePhone = (phone) => /^[6-9]\d{9}$/.test(String(phone || "").trim());
const validatePincode = (pincode) => /^\d{6}$/.test(String(pincode || "").trim());
const validatePassword = (password) => typeof password === 'string' && password.length >= 6;

// Treat any password starting with $2a$/$2b$/$2y$ as a bcrypt hash. Otherwise plaintext (legacy).
const looksHashed = (pwd) => typeof pwd === 'string' && /^\$2[aby]\$/.test(pwd);

// In-memory OTP send rate limiter: 3 sends per phone per 15 minutes.
// Single-process only — swap to Redis if you scale horizontally.
const OTP_RATE_WINDOW_MS = 15 * 60 * 1000;
const OTP_RATE_MAX = 3;
const otpSendLog = new Map(); // phone -> [timestamps]
const checkOtpRateLimit = (phone) => {
  const now = Date.now();
  const past = (otpSendLog.get(phone) || []).filter(t => now - t < OTP_RATE_WINDOW_MS);
  if (past.length >= OTP_RATE_MAX) return false;
  past.push(now);
  otpSendLog.set(phone, past);
  return true;
};

// ==========================================
// 🔐 SESSION TOKENS (User + Shop) and route guards
// ==========================================
// Pattern: random 32-byte hex token pushed onto User/Shop.sessionTokens at
// login. Every mutating route that needs to know "is this really the shop /
// the user it claims to be?" goes through requireShop / requireUser, which
// matches the bearer token to a doc and attaches it to req.
const issueSessionToken = async (Model, docId) => {
  const token = crypto.randomBytes(32).toString('hex');
  await Model.updateOne({ _id: docId }, { $push: { sessionTokens: { token, createdAt: new Date() } } });
  return token;
};

const extractBearer = (req) => {
  const auth = req.headers.authorization || req.headers.Authorization || '';
  if (typeof auth !== 'string') return '';
  return auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
};

const requireShop = async (req, res, next) => {
  try {
    const token = extractBearer(req);
    if (!token) return res.status(401).json({ error: "Missing shop session token" });
    // sessionTokens has select:false in the schema — must opt in explicitly.
    const shop = await Shop.findOne({ "sessionTokens.token": token }).select('+sessionTokens');
    if (!shop) return res.status(401).json({ error: "Invalid or expired session" });
    req.shop = shop;
    next();
  } catch (err) { res.status(500).json({ error: err.message }); }
};

const requireUser = async (req, res, next) => {
  try {
    const token = extractBearer(req);
    if (!token) return res.status(401).json({ error: "Missing user session token" });
    const user = await User.findOne({ "sessionTokens.token": token }).select('+sessionTokens');
    if (!user) return res.status(401).json({ error: "Invalid or expired session" });
    req.user = user;
    next();
  } catch (err) { res.status(500).json({ error: err.message }); }
};

const SMS_PROVIDER_CONFIGURED = false; // Wire to MSG91/Firebase later by flipping this on env var.
const sendOtpSms = async (phone, otp) => {
  // Dev mode: log only. In production, replace with provider call (MSG91/Firebase/Twilio).
  console.log(`[OTP][DEV] phone=${phone} otp=${otp} (no SMS provider configured — would have sent in production)`);
  return { delivered: false, devMode: true };
};

// ==========================================
// 📞 ESCALATION CHANNELS (STUBBED — wire providers when credentials arrive)
// ==========================================
// All three helpers log-only today and return {stubMode: true}. The escalation
// worker calls them regardless so the flow is exercised end-to-end; wiring a
// real provider is a single-function change per channel.
//
// SMS (MSG91 / Gupshup / Twilio): set MSG91_AUTH_KEY env, flip the flag.
// Voice (Exotel / Knowlarity / Twilio Voice): set EXOTEL_SID + token, flip the flag.
// Razorpay refund: AUTO_REFUND_ENABLED=true to actually fire — otherwise we mark
//   `order.refund.pending=true` and admin issues the refund manually.
const ESCALATION_SMS_CONFIGURED = false;
const ESCALATION_VOICE_CONFIGURED = false;
const AUTO_REFUND_ENABLED = process.env.AUTO_REFUND_ENABLED === 'true';

const sendSmsToPhone = async (phone, message) => {
  if (!ESCALATION_SMS_CONFIGURED) {
    console.log(`[ESCALATION-SMS][STUB] to=${phone} msg="${message}"`);
    return { delivered: false, stubMode: true };
  }
  // TODO: provider call goes here.
  return { delivered: false, stubMode: true };
};

const placeVoiceCallToPhone = async (phone, message) => {
  if (!ESCALATION_VOICE_CONFIGURED) {
    console.log(`[ESCALATION-VOICE][STUB] to=${phone} script="${message}"`);
    return { delivered: false, stubMode: true };
  }
  // TODO: provider call goes here (TTS script or pre-recorded clip URL).
  return { delivered: false, stubMode: true };
};

const issueRazorpayRefund = async (order) => {
  if (!order?.razorpayPaymentId) return { delivered: false, reason: 'no_payment_id' };
  if (!AUTO_REFUND_ENABLED || !razorpay) {
    console.log(`[REFUND][STUB] orderId=${order._id} paymentId=${order.razorpayPaymentId} amount=${order.totalAmount} (set AUTO_REFUND_ENABLED=true to fire for real)`);
    return { delivered: false, stubMode: true };
  }
  try {
    const refund = await razorpay.payments.refund(order.razorpayPaymentId, {
      amount: Math.round((Number(order.totalAmount) || 0) * 100),
      speed: 'optimum',
      notes: { reason: 'shop_unresponsive_auto_cancel', orderId: order._id.toString() },
    });
    return { delivered: true, refundId: refund.id };
  } catch (err) {
    console.error('[REFUND] failed:', err.message);
    return { delivered: false, error: err.message };
  }
};

// ==========================================
// 📣 ORDER NOTIFICATION COPY
// ==========================================
// Maps an order status (the exact string the shop dashboard saves) to friendly
// title + body + type used for both the in-app bell and the OneSignal push.
// Keeping the mapping in one place so message wording stays consistent.
const orderNotificationFor = (status, shortId) => {
  const id = shortId ? `#${shortId}` : '';
  const s = String(status || '').toLowerCase();
  if (s.includes('cancel') || s.includes('reject')) {
    return { type: 'order_cancelled', title: 'Order Cancelled ❌', message: `Your order ${id} was cancelled. Any payment/coins will be refunded shortly.`.trim() };
  }
  // Final pickup stage. Match new "Picked Up ✅" and legacy "Delivered ✅" so
  // in-flight orders from before the rename still resolve to the same event.
  if (s.includes('pick') || s.includes('deliver')) {
    return { type: 'order_delivered', title: 'Order Picked Up ✅', message: `Your order ${id} was picked up from the shop. Tap to rate your experience!`.trim() };
  }
  if (s.includes('ready') || s.includes('collect') || s.includes('pack')) {
    return { type: 'order_ready', title: 'Order Ready 🛍️', message: `Your order ${id} is ready to collect from the shop.`.trim() };
  }
  if (s.includes('accept') || s.includes('confirm') || s.includes('prepar')) {
    return { type: 'order_accepted', title: 'Order Accepted 👨‍🍳', message: `The shop accepted your order ${id} and started preparing it.`.trim() };
  }
  if (s.includes('pending') || s.includes('placed')) {
    return { type: 'order_placed', title: 'Order Placed 🎉', message: `Your order ${id} was placed and is waiting for the shop to confirm.`.trim() };
  }
  // Fallback for anything custom the shop adds later.
  return { type: 'order', title: 'Order Update 📦', message: `Your order ${id} is now: ${status}`.trim() };
};

// Title + body for the shop-side notification fired on a new order. Highlights
// URGENT orders and surfaces the customer's pickup time when one was chosen so
// the shopkeeper can prioritise without opening the dashboard.
const buildNewOrderShopNotif = (shortId, totalAmount, isUrgent, pickupTime) => {
  const id = shortId ? `#${shortId}` : '';
  if (isUrgent) {
    return {
      title: "⚡ URGENT Order!",
      message: `URGENT: Order ${id} for ₹${totalAmount} — customer wants it ASAP.`.trim(),
    };
  }
  if (pickupTime) {
    const dt = new Date(pickupTime);
    if (!Number.isNaN(dt.getTime())) {
      const clock = dt.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true });
      return {
        title: "New Order! 🚀",
        message: `Order ${id} for ₹${totalAmount} · Pickup at ${clock}`.trim(),
      };
    }
  }
  return {
    title: "New Order! 🚀",
    message: `Order ${id} received for ₹${totalAmount}`.trim(),
  };
};

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
    const { shopId, orderId, adminName } = req.body;

    if (!shopId || !orderId) {
      return res.status(400).json({ error: "Missing shopId or orderId" });
    }

    const shortOrder = orderId.toString().slice(-5).toUpperCase();
    const urgentMessage = `🚨 URGENT: Please process Order #${shortOrder} immediately! The customer is waiting.`;

    await Notification.create({
      shopId: shopId,
      orderId: orderId,
      type: 'new_order',
      title: "⚠️ ADMIN ALERT",
      message: urgentMessage
    });

    await sendPushNotification(shopId, "⚠️ ADMIN ALERT", urgentMessage);

    // Log the ping in the order's ops trail so later admins see it was tried.
    try {
      await Order.findByIdAndUpdate(orderId, {
        $push: { opsLog: { action: 'ping', adminName: adminName || 'admin', text: 'Sent urgent ping to shop', at: new Date() } }
      });
    } catch (e) { console.error("ops-log on ping failed:", e.message); }

    res.json({ success: true });
  } catch (err) {
    console.error("Ping Error:", err);
    res.status(500).json({ error: err.message });
  }
});

// --- 🛡️ OPS CONSOLE: admin force actions on stalled orders ---

// POST /admin/orders/:id/force-cancel — runs the same auto-cancel path the
// T+15min worker uses: refunds coins, flags Razorpay refund, notifies both
// sides. Use when the shop can't be reached or the customer asks to cancel.
app.post("/admin/orders/:id/force-cancel", async (req, res) => {
  try {
    const order = await Order.findById(req.params.id)
      .populate('shopId', 'name phone')
      .populate('userId', 'name phone');
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (order.status?.includes('✅') || order.status?.includes('❌')) {
      return res.status(400).json({ error: "Order is already closed" });
    }

    const adminName = (req.body && req.body.adminName) || 'admin';
    const reason = (req.body && req.body.reason) || 'admin force-cancel';
    const shortId = order._id.toString().slice(-5).toUpperCase();

    await cancelOrderWithRefund(order, {
      statusLabel: 'Cancelled ❌ (by admin)',
      customerTitle: 'Order Cancelled ❌',
      customerMsg:   `Order #${shortId} was cancelled by support. Refund is being processed.`,
      shopTitle: '⚠️ Order Cancelled by Admin',
      shopMsg: `Order #${shortId} was cancelled by support (${reason}).`,
    });

    // Stamp the ops trail.
    await Order.findByIdAndUpdate(order._id, {
      $push: { opsLog: { action: 'force_cancel', adminName, text: reason, at: new Date() } }
    });

    res.json({ success: true });
  } catch (err) {
    console.error("force-cancel error:", err);
    res.status(500).json({ error: err.message });
  }
});

// POST /admin/orders/:id/force-accept — set status to "Accepted 👨‍🍳" on the
// shop's behalf. Use after a phone call where the shop confirmed verbally
// but can't tap Accept (offline phone, app crashed, etc).
app.post("/admin/orders/:id/force-accept", async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (order.status !== 'Pending') {
      return res.status(400).json({ error: `Order is already ${order.status}` });
    }

    const adminName = (req.body && req.body.adminName) || 'admin';
    const reason = (req.body && req.body.reason) || 'admin force-accept';
    const newStatus = 'Accepted 👨‍🍳';

    order.status = newStatus;
    order.statusHistory = [...(order.statusHistory || []), { status: newStatus, at: new Date() }];
    order.opsLog = [...(order.opsLog || []), { action: 'force_accept', adminName, text: reason, at: new Date() }];
    await order.save();

    // Tell the customer the order was accepted (matches normal flow).
    if (order.userId && mongoose.Types.ObjectId.isValid(order.userId)) {
      try {
        const shortId = order._id.toString().slice(-5).toUpperCase();
        const { type, title, message } = orderNotificationFor(newStatus, shortId);
        await Notification.create({ userId: order.userId, orderId: order._id, type, title, message });
        await sendPushNotification(order.userId, title, message);
      } catch (e) { console.error('force-accept notify failed:', e.message); }
    }

    res.json({ success: true, order });
  } catch (err) {
    console.error("force-accept error:", err);
    res.status(500).json({ error: err.message });
  }
});

// POST /admin/orders/:id/ops-log — append a free-form note (e.g. "called shop
// at 14:32, no answer"). Lets successive admins see what was already tried.
app.post("/admin/orders/:id/ops-log", async (req, res) => {
  try {
    const { text, adminName, action } = req.body || {};
    if (!text || !String(text).trim()) return res.status(400).json({ error: "Note text required" });

    const updated = await Order.findByIdAndUpdate(
      req.params.id,
      { $push: { opsLog: { action: action || 'note', adminName: adminName || 'admin', text: String(text).trim(), at: new Date() } } },
      { new: true }
    );
    if (!updated) return res.status(404).json({ error: "Order not found" });
    res.json({ success: true, opsLog: updated.opsLog });
  } catch (err) {
    console.error("ops-log error:", err);
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

// ==========================================
// 💳 PAYMENT ROUTES (Razorpay)
// ==========================================

// Recompute the trusted cart total from the shop's current inventory.
// Frontend prices/totals are NEVER trusted — we always recompute server-side.
const computeTrustedTotal = async (shopId, items, coinsUsed) => {
  const shop = await Shop.findById(shopId).populate('inventory.product');
  if (!shop) throw new Error("Shop not found");

  // Index inventory by productId so we can resolve both price (trusted) and
  // display fields (image/qnty/brand/emoji) without hitting the catalog twice.
  const invByProductId = {};
  for (const inv of (shop.inventory || [])) {
    if (!inv.product) continue;
    invByProductId[inv.product._id.toString()] = inv;
  }

  let itemTotal = 0;
  const trustedItems = [];
  for (const line of (items || [])) {
    const pid = (line.productId || "").toString();
    const qty = Math.max(1, Math.floor(Number(line.qty) || 1));
    const inv = invByProductId[pid];
    if (!inv) throw new Error(`Product ${pid} not in shop inventory`);
    const price = Number(inv.sellingPrice) || Number(inv.product.mrp) || 0;
    itemTotal += price * qty;
    trustedItems.push({
      productId: pid,
      name: line.name || inv.product.name || "",
      qty,
      price,
      // Snapshot display metadata so the order card can render images later
      // even if the master catalog item is renamed / removed.
      image: inv.product.image || "",
      qnty: inv.product.qnty || "",
      brand: inv.product.brand || "",
      emoji: inv.product.emoji || "🛒",
    });
  }

  // Coins: 10 coins = ₹1, capped at 10% of item total (mirrors Cart.jsx logic).
  const safeCoinsUsed = Math.max(0, Math.floor(Number(coinsUsed) || 0));
  const maxDiscountAllowed = itemTotal * 0.10;
  const coinDiscount = Math.min(safeCoinsUsed / 10, maxDiscountAllowed);
  const finalAmount = Math.max(0, Number((itemTotal - coinDiscount).toFixed(2)));

  return { itemTotal, coinDiscount, finalAmount, trustedItems, coinsUsed: safeCoinsUsed };
};

app.post("/payments/create-order", async (req, res) => {
  try {
    if (!razorpay) return res.status(503).json({ error: "Payment gateway not configured." });
    const { userId, shopId, items, coinsUsed } = req.body;
    if (!userId || !shopId || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Missing userId, shopId, or items." });
    }

    const { finalAmount } = await computeTrustedTotal(shopId, items, coinsUsed);
    if (finalAmount <= 0) return res.status(400).json({ error: "Order total must be greater than zero." });

    const rzpOrder = await razorpay.orders.create({
      amount: Math.round(finalAmount * 100), // paise
      currency: "INR",
      receipt: `rcpt_${Date.now()}_${userId.toString().slice(-6)}`,
      notes: { userId: userId.toString(), shopId: shopId.toString() },
    });

    res.json({
      razorpayOrderId: rzpOrder.id,
      amount: rzpOrder.amount,
      currency: rzpOrder.currency,
      keyId: process.env.RAZORPAY_KEY_ID,
      computedTotal: finalAmount,
    });
  } catch (err) {
    console.error("create-order error:", err);
    res.status(500).json({ error: err.message || "Failed to create payment order." });
  }
});

app.post("/payments/verify", async (req, res) => {
  try {
    if (!razorpay) return res.status(503).json({ error: "Payment gateway not configured." });
    const {
      razorpay_order_id, razorpay_payment_id, razorpay_signature,
      userId, shopId, items, paymentMethod, coinsUsed,
      pickupTime, isUrgent,
    } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: "Missing payment signature fields." });
    }

    // HMAC SHA256 verification — Razorpay's prescribed signature check.
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ error: "Payment signature verification failed." });
    }

    // Recompute trusted total — never trust the client.
    const { finalAmount, trustedItems, coinsUsed: safeCoinsUsed } =
      await computeTrustedTotal(shopId, items, coinsUsed);

    const order = await Order.create({
      userId, shopId,
      items: trustedItems,
      totalAmount: finalAmount,
      paymentMethod: paymentMethod || "UPI",
      paymentStatus: "Paid",
      coinsUsed: safeCoinsUsed,
      razorpayOrderId: razorpay_order_id,
      razorpayPaymentId: razorpay_payment_id,
      razorpaySignature: razorpay_signature,
      pickupTime: pickupTime || null,
      isUrgent: Boolean(isUrgent),
      statusHistory: [{ status: "Pending", at: new Date() }],
    });

    // Deduct coins after the order is safely persisted.
    if (safeCoinsUsed > 0 && mongoose.Types.ObjectId.isValid(userId)) {
      await User.findByIdAndUpdate(userId, { $inc: { coins: -safeCoinsUsed } });
    }

    const shortOrder = order._id.toString().slice(-5).toUpperCase();
    const { title: shopTitle, message: shopMessage } = buildNewOrderShopNotif(shortOrder, finalAmount, order.isUrgent, order.pickupTime);
    await Notification.create({ shopId, orderId: order._id, type: 'new_order', title: shopTitle, message: shopMessage });
    await sendPushNotification(shopId, shopTitle, shopMessage);

    res.json({ success: true, order });
  } catch (err) {
    console.error("verify error:", err);
    res.status(500).json({ error: err.message || "Payment verification failed." });
  }
});

// --- ORDER ROUTES ---
app.post("/orders", async (req, res) => {
  // Track any coin debit so we can refund it if the order save later fails.
  // Coin deduction MUST happen server-side and atomically — the COD path used
  // to trust a client PATCH after the order was saved, which leaked coins on
  // network failures and was trivially exploitable.
  let coinRefund = null;
  try {
    const requestedCoins = Math.max(0, Math.floor(Number(req.body.coinsUsed) || 0));
    if (requestedCoins > 0 && req.body.userId && mongoose.Types.ObjectId.isValid(req.body.userId)) {
      const r = await User.updateOne(
        { _id: req.body.userId, coins: { $gte: requestedCoins } },
        { $inc: { coins: -requestedCoins } }
      );
      if (r.matchedCount === 0) {
        return res.status(400).json({ error: "Insufficient coin balance." });
      }
      coinRefund = { userId: req.body.userId, amount: requestedCoins };
    }

    const initialStatus = req.body.status || "Pending";
    const o = new Order({
      ...req.body,
      coinsUsed: requestedCoins,
      statusHistory: [{ status: initialStatus, at: new Date() }],
    });
    await o.save();
    if (req.body.imageUrl) await Parchi.updateOne({ imageUrl: req.body.imageUrl }, { $set: { status: 'processed' } });

    const shortId = o._id.toString().slice(-5).toUpperCase();

    // Notify the shop that a new order arrived. The title/body call out URGENT
    // orders and scheduled pickup times so the shopkeeper sees it at a glance.
    const { title: shopTitle, message: shopMessage } = buildNewOrderShopNotif(shortId, o.totalAmount, o.isUrgent, o.pickupTime);
    await Notification.create({
      shopId: o.shopId,
      orderId: o._id,
      type: 'new_order',
      title: shopTitle,
      message: shopMessage,
    });
    await sendPushNotification(o.shopId, shopTitle, shopMessage);

    // Also confirm the order to the customer so they get instant feedback in the
    // bell + push, even before the shop accepts.
    if (o.userId && mongoose.Types.ObjectId.isValid(o.userId)) {
      const { type, title, message } = orderNotificationFor(initialStatus, shortId);
      try {
        await Notification.create({
          userId: o.userId,
          orderId: o._id,
          type,
          title,
          message,
        });
        await sendPushNotification(o.userId, title, message);
      } catch (notifErr) {
        console.log("Customer placement notification skipped:", notifErr.message);
      }
    }

    res.json(o);
  } catch (err) {
    if (coinRefund) {
      try { await User.findByIdAndUpdate(coinRefund.userId, { $inc: { coins: coinRefund.amount } }); }
      catch (refundErr) { console.error("Coin refund after failed order failed:", refundErr.message); }
    }
    res.status(500).json({ error: err.message });
  }
});
app.get("/orders", async (req, res) => res.json(await Order.find().populate('userId').populate('shopId').sort({createdAt: -1})));

// Slim per-user feed for the customer feed's "Buy It Again" widget. The old
// approach was to fetch /orders (every order, every user, populated) and filter
// client-side — this avoids the global scan and the populate join.
app.get("/orders/user/:userId", async (req, res) => {
  try {
    // Populate just the shop fields the OrdersPage card needs — keeps the
    // payload small while still letting the customer see who they ordered from.
    const orders = await Order.find({ userId: req.params.userId })
      .populate('shopId', 'name phone')
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    res.json(orders);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 🛡️ THE BULLETPROOF ORDER UPDATE ROUTE
// 🔐 Shop-only status updates. requireShop verifies the bearer token and
// attaches req.shop. Ownership is checked inside (shop can only mutate its
// own orders). Cancellation is rejected here — must go through the dedicated
// /shop-cancel endpoint so refunds always fire.
app.patch("/orders/:id", requireShop, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (order.shopId.toString() !== req.shop._id.toString()) {
      return res.status(403).json({ error: "Not your order" });
    }
    if (req.body.status && /cancel|reject/i.test(req.body.status)) {
      return res.status(400).json({ error: "Use POST /orders/:id/shop-cancel to cancel — keeps refunds consistent" });
    }

    // Final pickup → award loyalty coins (1 coin per ₹10 spent). Match both the
    // new "Picked Up ✅" status and the legacy "Delivered ✅" so older orders
    // still in flight at deploy time keep working.
    const isFinalNow = req.body.status === "Picked Up ✅" || req.body.status === "Delivered ✅";
    const wasFinalAlready = order.status === "Picked Up ✅" || order.status === "Delivered ✅";
    if (isFinalNow && !wasFinalAlready) {
      const safeAmount = Number(order.totalAmount) || 0;
      const earnedCoins = Math.floor(safeAmount / 10);

      if (order.userId && mongoose.Types.ObjectId.isValid(order.userId)) {
        await User.findByIdAndUpdate(order.userId, { $inc: { coins: earnedCoins } });
      }
    }

    if (req.body.status && req.body.status !== order.status) {
      order.statusHistory = [...(order.statusHistory || []), { status: req.body.status, at: new Date() }];
    }
    order.status = req.body.status;
    await order.save();

    if (order.userId && mongoose.Types.ObjectId.isValid(order.userId)) {
      try {
        const shortId = order._id.toString().slice(-5).toUpperCase();
        const { type, title, message } = orderNotificationFor(req.body.status, shortId);
        await Notification.create({
          userId: order.userId,
          orderId: order._id,
          type,
          title,
          message,
        });
        await sendPushNotification(order.userId, title, message);
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

// 🔐 Shop-initiated cancel with refund. Shares cancelOrderWithRefund() with
// the worker auto-cancel and admin force-cancel so the refund path is
// guaranteed identical across all three call sites.
app.post("/orders/:id/shop-cancel", requireShop, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id)
      .populate('shopId', 'name phone')
      .populate('userId', 'name phone');
    if (!order) return res.status(404).json({ error: "Order not found" });

    const orderShopId = (order.shopId?._id || order.shopId).toString();
    if (orderShopId !== req.shop._id.toString()) {
      return res.status(403).json({ error: "Not your order" });
    }
    if (order.status?.includes('✅') || order.status?.includes('❌')) {
      return res.status(400).json({ error: "Order is already closed" });
    }

    const reason = (req.body && req.body.reason) || 'Cancelled by shop';
    const shortId = order._id.toString().slice(-5).toUpperCase();
    await cancelOrderWithRefund(order, {
      statusLabel: 'Cancelled ❌ (by shop)',
      customerTitle: 'Order Cancelled ❌',
      customerMsg:   `Sorry — the shop cancelled your order #${shortId}. Refund is being processed.`,
      // No shop-side push: the shop just cancelled it themselves, so don't ping them.
      shopTitle: null,
    });
    // Stamp the ops trail so admin / future audits see who cancelled and why.
    try {
      await Order.findByIdAndUpdate(order._id, {
        $push: { opsLog: { action: 'shop_cancel', adminName: req.shop.name || 'shop', text: reason, at: new Date() } }
      });
    } catch (e) { /* non-fatal */ }

    res.json({ success: true });
  } catch (err) {
    console.error("shop-cancel error:", err);
    res.status(500).json({ error: err.message });
  }
});

// 🔐 Customer-initiated cancel with refund. Only allowed while the order is
// still Pending — once the shop has accepted, the customer must contact the
// shop. Same refund path as every other cancel.
app.post("/orders/:id/user-cancel", requireUser, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id)
      .populate('shopId', 'name phone')
      .populate('userId', 'name phone');
    if (!order) return res.status(404).json({ error: "Order not found" });

    const orderUserId = (order.userId?._id || order.userId).toString();
    if (orderUserId !== req.user._id.toString()) {
      return res.status(403).json({ error: "Not your order" });
    }
    if (order.status !== 'Pending') {
      return res.status(400).json({ error: `Order can no longer be cancelled — current status: ${order.status}. Please contact the shop.` });
    }

    const shortId = order._id.toString().slice(-5).toUpperCase();
    await cancelOrderWithRefund(order, {
      statusLabel: 'Cancelled ❌ (by customer)',
      // No customer push — they just clicked the cancel button, they know.
      customerTitle: null,
      shopTitle: 'Order Cancelled by Customer ❌',
      shopMsg: `The customer cancelled order #${shortId} before you accepted it.`,
    });
    try {
      await Order.findByIdAndUpdate(order._id, {
        $push: { opsLog: { action: 'user_cancel', adminName: req.user.name || 'customer', text: 'Customer cancelled while Pending', at: new Date() } }
      });
    } catch (e) { /* non-fatal */ }

    res.json({ success: true });
  } catch (err) {
    console.error("user-cancel error:", err);
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

// --- 📣 COMPLAINT ROUTES ---
// Customer files a complaint. Notifies the admin in-app, and pings the shop
// when the complaint is targeted at one.
app.post("/complaints", async (req, res) => {
  try {
    const { targetType, message } = req.body || {};
    if (!targetType || !message || !message.trim()) {
      return res.status(400).json({ error: "targetType and message are required." });
    }

    const complaint = new Complaint({
      userId: req.body.userId || null,
      userName: req.body.userName || 'Customer',
      userPhone: req.body.userPhone || '',
      targetType,
      shopId: req.body.shopId || null,
      itemName: req.body.itemName || '',
      message: message.trim(),
    });
    await complaint.save();

    // Notify the shop if this complaint targets them.
    if (complaint.shopId && (targetType === 'shop' || targetType === 'item')) {
      const title = "📣 New Complaint";
      const body = `${complaint.userName} filed a complaint${complaint.itemName ? ` about "${complaint.itemName}"` : ''}.`;
      try {
        await Notification.create({ shopId: complaint.shopId, type: 'system', title, message: body });
        await sendPushNotification(complaint.shopId, title, body);
      } catch (e) { console.log("Shop complaint notify skipped:", e.message); }
    }

    res.status(201).json(complaint);
  } catch (err) {
    console.error("Complaint create error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Admin — all complaints, newest first, with shop populated for display.
app.get("/complaints", async (req, res) => {
  try {
    const list = await Complaint.find()
      .populate('shopId', 'name phone')
      .sort({ createdAt: -1 });
    res.json(list);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Shop view — only complaints filed against this shop.
app.get("/complaints/shop/:shopId", async (req, res) => {
  try {
    const list = await Complaint.find({ shopId: req.params.shopId })
      .sort({ createdAt: -1 });
    res.json(list);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// User view — every complaint a given customer filed, newest first. Used by
// the "My Complaints" screen so the user can read replies.
app.get("/complaints/user/:userId", async (req, res) => {
  try {
    const list = await Complaint.find({ userId: req.params.userId })
      .populate('shopId', 'name')
      .sort({ createdAt: -1 });
    res.json(list);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Status updates: open ↔ reviewed ↔ resolved.
app.patch("/complaints/:id", async (req, res) => {
  try {
    const { status } = req.body || {};
    if (!['open', 'reviewed', 'resolved'].includes(status)) {
      return res.status(400).json({ error: "Invalid status." });
    }
    const updated = await Complaint.findByIdAndUpdate(
      req.params.id,
      { $set: { status } },
      { new: true }
    );
    if (!updated) return res.status(404).json({ error: "Complaint not found." });
    res.json(updated);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Shop or admin posts a reply onto a complaint. The original customer is
// notified in-app + via OneSignal so they know to come back and read it.
app.post("/complaints/:id/replies", async (req, res) => {
  try {
    const { authorType, authorName, message } = req.body || {};
    if (!['shop', 'admin'].includes(authorType)) {
      return res.status(400).json({ error: "authorType must be 'shop' or 'admin'." });
    }
    if (!message || !message.trim()) {
      return res.status(400).json({ error: "Reply message is required." });
    }

    const complaint = await Complaint.findById(req.params.id);
    if (!complaint) return res.status(404).json({ error: "Complaint not found." });

    complaint.replies.push({
      authorType,
      authorName: (authorName || '').toString().slice(0, 120),
      message: message.trim(),
    });
    // A fresh reply implies someone is engaging with it — auto-bump 'open' to
    // 'reviewed' so the admin queue reflects reality.
    if (complaint.status === 'open') complaint.status = 'reviewed';
    await complaint.save();

    // Notify the customer who filed it.
    if (complaint.userId) {
      const who = authorType === 'shop' ? 'The shop' : 'PackItOut support';
      const title = "📣 Reply to your complaint";
      const body = `${who} replied: ${message.trim().slice(0, 120)}`;
      try {
        await Notification.create({ userId: complaint.userId, type: 'system', title, message: body });
        await sendPushNotification(complaint.userId, title, body);
      } catch (e) { console.log("Reply notify skipped:", e.message); }
    }

    res.status(201).json(complaint);
  } catch (err) {
    console.error("Reply create error:", err);
    res.status(500).json({ error: err.message });
  }
});

// --- AUTH / OTP ROUTES ---
app.post("/auth/send-otp", async (req, res) => {
  try {
    const phone = String(req.body.phone || "").trim();
    const purpose = req.body.purpose === 'login' ? 'login' : 'register';

    if (!validatePhone(phone)) {
      return res.status(400).json({ error: "Enter a valid 10-digit Indian mobile number." });
    }
    if (!checkOtpRateLimit(phone)) {
      return res.status(429).json({ error: "Too many OTP requests. Try again in 15 minutes." });
    }

    // For registration, refuse if the number is already an account.
    if (purpose === 'register') {
      const existing = await User.findOne({ phone }).select('_id').lean();
      if (existing) return res.status(409).json({ error: "Phone already registered. Please log in." });
    }

    const otp = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 min

    // Wipe any prior unverified OTPs for the same phone+purpose so verify-otp finds only the latest.
    await OtpRequest.deleteMany({ phone, purpose, verified: false });
    await OtpRequest.create({ phone, otp, purpose, expiresAt });

    const sendResult = await sendOtpSms(phone, otp);

    const payload = { success: true, expiresInSeconds: 600 };
    // Dev mode convenience: surface the OTP in the response so testing is painless.
    // This branch is gated on SMS_PROVIDER_CONFIGURED so production can never leak it.
    if (!SMS_PROVIDER_CONFIGURED) payload.devOtp = otp;
    res.json(payload);
  } catch (err) {
    console.error("send-otp error:", err);
    res.status(500).json({ error: "Could not send OTP." });
  }
});

app.post("/auth/verify-otp", async (req, res) => {
  try {
    const phone = String(req.body.phone || "").trim();
    const otp = String(req.body.otp || "").trim();
    const purpose = req.body.purpose === 'login' ? 'login' : 'register';

    if (!validatePhone(phone)) return res.status(400).json({ error: "Invalid phone number." });
    if (!/^\d{6}$/.test(otp)) return res.status(400).json({ error: "Enter the 6-digit OTP." });

    const record = await OtpRequest.findOne({ phone, purpose, consumed: false }).sort({ createdAt: -1 });
    if (!record) return res.status(400).json({ error: "No OTP found. Please request a new one." });
    if (record.expiresAt < new Date()) return res.status(400).json({ error: "OTP expired. Please request a new one." });
    if (record.attempts >= 5) return res.status(429).json({ error: "Too many wrong attempts. Request a new OTP." });

    if (record.otp !== otp) {
      record.attempts += 1;
      await record.save();
      return res.status(400).json({ error: `Wrong OTP. ${5 - record.attempts} attempt(s) left.` });
    }

    record.verified = true;
    await record.save();

    // The token is the OtpRequest._id — short-lived, single-use, tied to a verified phone.
    res.json({ success: true, verificationToken: record._id.toString() });
  } catch (err) {
    console.error("verify-otp error:", err);
    res.status(500).json({ error: "Could not verify OTP." });
  }
});

// --- USER ROUTES ---
app.post("/register", async (req, res) => {
  try {
    const { name, phone, password, pincode, referredBy, verificationToken } = req.body;

    if (!validatePhone(phone)) return res.status(400).json({ error: "Enter a valid 10-digit Indian mobile number." });
    if (!validatePincode(pincode)) return res.status(400).json({ error: "Pincode must be exactly 6 digits." });
    if (!validatePassword(password)) return res.status(400).json({ error: "Password must be at least 6 characters." });
    if (!name || !name.trim()) return res.status(400).json({ error: "Please enter your name." });
    if (!verificationToken) return res.status(400).json({ error: "Please verify your phone number first." });

    // Verify the OTP token: must be a verified, unconsumed OtpRequest for the SAME phone.
    if (!mongoose.Types.ObjectId.isValid(verificationToken)) {
      return res.status(400).json({ error: "Invalid verification token." });
    }
    const otpRecord = await OtpRequest.findById(verificationToken);
    if (!otpRecord || otpRecord.phone !== String(phone).trim() || otpRecord.purpose !== 'register' || !otpRecord.verified || otpRecord.consumed || otpRecord.expiresAt < new Date()) {
      return res.status(400).json({ error: "Phone verification expired or invalid. Please request a new OTP." });
    }

    const existing = await User.findOne({ phone }).select('_id').lean();
    if (existing) return res.status(409).json({ error: "Phone already registered. Please log in." });

    const baseName = name.substring(0, 4).toUpperCase().replace(/\s/g, '') || "PACK";
    const refCode = baseName + Math.floor(1000 + Math.random() * 9000);
    let startingCoins = 0;
    if (referredBy) {
      const referrer = await User.findOne({ referralCode: referredBy });
      if (referrer) { referrer.coins += 50; await referrer.save(); startingCoins = 50; }
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const u = new User({
      name: name.trim(),
      phone: String(phone).trim(),
      pincode: String(pincode).trim(),
      password: passwordHash,
      referredBy,
      referralCode: refCode,
      coins: startingCoins,
    });
    await u.save();

    // Burn the OTP so the same token cannot register a second account.
    otpRecord.consumed = true;
    await otpRecord.save();

    // Auto-login: new user gets a session token so they don't need to log in again.
    const sessionToken = await issueSessionToken(User, u._id);

    const safe = u.toObject();
    delete safe.password;
    delete safe.sessionTokens;
    res.json({ ...safe, sessionToken });
  } catch (err) {
    console.error("register error:", err);
    res.status(500).json({ error: "Registration failed. Please try again." });
  }
});

app.post("/login", async (req, res) => {
  try {
    const phone = String(req.body.phone || "").trim();
    const password = String(req.body.password || "");
    if (!validatePhone(phone)) return res.status(400).json({ error: "Enter a valid 10-digit Indian mobile number." });
    if (!password) return res.status(400).json({ error: "Enter your password." });

    const user = await User.findOne({ phone }).populate('primaryShop');
    if (!user) return res.status(400).json({ error: "Invalid phone or password." });

    let matches = false;
    if (looksHashed(user.password)) {
      matches = await bcrypt.compare(password, user.password);
    } else {
      // Legacy plaintext path: check equality, then silently upgrade to bcrypt on success.
      matches = user.password === password;
      if (matches) {
        user.password = await bcrypt.hash(password, 10);
        await user.save();
      }
    }

    if (!matches) return res.status(400).json({ error: "Invalid phone or password." });

    // Session token for protected endpoints (order cancel, etc).
    const sessionToken = await issueSessionToken(User, user._id);

    const safe = user.toObject();
    delete safe.password;
    delete safe.sessionTokens;
    res.json({ ...safe, sessionToken });
  } catch (err) {
    console.error("login error:", err);
    res.status(500).json({ error: "Login failed. Please try again." });
  }
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

    // Issue a fresh session token — front-end stores it and sends in
    // Authorization: Bearer for every order-mutating request.
    const sessionToken = await issueSessionToken(Shop, shop._id);

    const safe = shop.toObject();
    delete safe.password;
    delete safe.sessionTokens;
    res.json({ ...safe, sessionToken });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get("/shops/all/:pincode", async (req, res) => {
  try { res.json(await Shop.find({ pincode: req.params.pincode })); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get("/shops/:id/menu", async (req, res) => {
  try { res.json(await Shop.findById(req.params.id).populate('inventory.product')); } catch (err) { res.status(500).json({ error: err.message }); }
});
// Slim variant for the customer feed/list views — strips description, ingredients,
// manufacturer fields, nutrition, and related/substitute refs that the feed never renders.
// ProductModal lazily refetches the full doc via GET /master-products/:id when opened.
app.get("/shops/:id/menu/lean", async (req, res) => {
  try {
    const shop = await Shop.findById(req.params.id)
      .select('name isOpen isAcceptingOrders shopImage operatingHours fullAddress pincode rating totalReviews inventoryMode inventory')
      .populate({
        path: 'inventory.product',
        select: 'name brand category mrp qnty emoji image searchTags isVeg itemGroupId'
      })
      .lean();
    res.json(shop);
  } catch (err) { res.status(500).json({ error: err.message }); }
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

// Upload / replace shop photo. Cloudinary holds the file; the Shop doc stores the URL.
app.post("/shops/:id/upload-image", upload.single('shopImage'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No image." });
    const shop = await Shop.findById(req.params.id);
    if (!shop) {
      fs.unlinkSync(req.file.path);
      return res.status(404).json({ error: "Shop not found." });
    }
    const result = await cloudinary.uploader.upload(req.file.path, {
      folder: 'packitout_shops',
      transformation: [{ width: 1200, height: 1200, crop: 'limit', quality: 'auto:good' }],
    });
    fs.unlinkSync(req.file.path);
    shop.shopImage = result.secure_url;
    await shop.save();
    const populated = await Shop.findById(shop._id).populate('inventory.product');
    res.json(populated);
  } catch (err) {
    console.error("Shop image upload failed:", err);
    res.status(500).json({ error: "Upload failed." });
  }
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

// Lazy-loaded by ProductModal so the customer feed can ship a slim product payload
// and only fetch description/ingredients/nutrition when a user opens a product.
app.get("/master-products/:id", async (req, res) => {
  try {
    const product = await MasterProduct.findById(req.params.id).lean();
    if (!product) return res.status(404).json({ error: "Product not found." });
    res.json(product);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

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
// 🔎 MISSED SEARCH ROUTES
// ==========================================

// Log a search that returned zero results. Upsert on lowercased term —
// count++, dedupe userIds/pincodes, refresh lastSearchedAt. Idempotent
// from the client's POV; the frontend can call once per zero-result
// term and we won't blow up on repeats.
app.post("/missed-searches", async (req, res) => {
  try {
    const rawTerm = String(req.body?.term || "").trim().toLowerCase();
    if (rawTerm.length < 2 || rawTerm.length > 80) {
      return res.status(400).json({ error: "term must be 2-80 chars" });
    }
    const pincode = String(req.body?.pincode || "").trim();
    const userId = String(req.body?.userId || "").trim();

    const update = {
      $inc: { count: 1 },
      $set: { lastSearchedAt: new Date() },
      $setOnInsert: { term: rawTerm, createdAt: new Date(), resolved: false },
    };
    const addToSet = {};
    if (pincode && /^\d{6}$/.test(pincode)) addToSet.pincodes = pincode;
    if (userId && mongoose.isValidObjectId(userId)) addToSet.userIds = userId;
    if (Object.keys(addToSet).length) update.$addToSet = addToSet;

    const doc = await MissedSearch.findOneAndUpdate(
      { term: rawTerm },
      update,
      { upsert: true, new: true }
    );
    res.json({ success: true, missedSearch: doc });
  } catch (err) {
    console.error("missed-searches POST failed:", err);
    res.status(500).json({ error: "Failed to log search" });
  }
});

// List missed searches for admin. ?resolved=false (default) hides done.
// ?sort=count (default) | lastSearchedAt
app.get("/missed-searches", async (req, res) => {
  try {
    const resolvedParam = String(req.query.resolved || "false");
    const filter = {};
    if (resolvedParam !== "all") filter.resolved = resolvedParam === "true";

    const sortKey = req.query.sort === "lastSearchedAt" ? "lastSearchedAt" : "count";
    const sort = sortKey === "count"
      ? { count: -1, lastSearchedAt: -1 }
      : { lastSearchedAt: -1, count: -1 };

    const docs = await MissedSearch.find(filter).sort(sort).limit(500);
    res.json(docs);
  } catch (err) {
    console.error("missed-searches GET failed:", err);
    res.status(500).json({ error: "Failed to fetch missed searches" });
  }
});

// Toggle resolved state — admin clicks "Mark resolved" once a matching
// product is added, or unticks if they were wrong.
app.patch("/missed-searches/:id/resolve", async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: "Invalid id" });
    }
    const resolved = req.body?.resolved !== false; // default true
    const doc = await MissedSearch.findByIdAndUpdate(
      req.params.id,
      { $set: { resolved } },
      { new: true }
    );
    if (!doc) return res.status(404).json({ error: "Not found" });
    res.json(doc);
  } catch (err) {
    console.error("missed-searches PATCH failed:", err);
    res.status(500).json({ error: "Failed to update" });
  }
});

app.delete("/missed-searches/:id", async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: "Invalid id" });
    }
    const doc = await MissedSearch.findByIdAndDelete(req.params.id);
    if (!doc) return res.status(404).json({ error: "Not found" });
    res.json({ success: true });
  } catch (err) {
    console.error("missed-searches DELETE failed:", err);
    res.status(500).json({ error: "Failed to delete" });
  }
});


// ==========================================
// 🎯 RANKING CONFIG ROUTES
// ==========================================

// Read-or-create. Fast path — the customer apps call this on every boot,
// so we keep the work minimal.
app.get("/ranking-config", async (_req, res) => {
  try {
    let doc = await RankingConfig.findOne({ singleton: 'main' });
    if (!doc) {
      doc = await RankingConfig.create({ singleton: 'main', enabled: false, brandOrder: [] });
    }
    res.json(doc);
  } catch (err) {
    console.error("ranking-config GET failed:", err);
    res.status(500).json({ error: "Failed to fetch config" });
  }
});

// Admin save. Whole-document replace of the editable fields; brand names
// are lowercased + trimmed + de-duped here so the frontend doesn't have
// to be careful.
app.put("/ranking-config", async (req, res) => {
  try {
    const enabled = req.body?.enabled !== false; // default true on save
    const rawList = Array.isArray(req.body?.brandOrder) ? req.body.brandOrder : [];
    const seen = new Set();
    const brandOrder = [];
    for (const raw of rawList) {
      const v = String(raw || '').trim().toLowerCase();
      if (!v || seen.has(v)) continue;
      seen.add(v);
      brandOrder.push(v);
    }
    const doc = await RankingConfig.findOneAndUpdate(
      { singleton: 'main' },
      { $set: { enabled, brandOrder, updatedAt: new Date() } },
      { new: true, upsert: true }
    );
    res.json(doc);
  } catch (err) {
    console.error("ranking-config PUT failed:", err);
    res.status(500).json({ error: "Failed to save config" });
  }
});

// Distinct brand list for the admin picker. We filter out empty/"nan"
// entries because the master catalog has historically contained both.
app.get("/brands", async (_req, res) => {
  try {
    const raw = await MasterProduct.distinct("brand");
    const cleaned = Array.from(new Set(
      raw
        .map(b => String(b || '').trim())
        .filter(b => b && b.toLowerCase() !== 'nan')
    )).sort((a, b) => a.localeCompare(b));
    res.json(cleaned);
  } catch (err) {
    console.error("brands GET failed:", err);
    res.status(500).json({ error: "Failed to fetch brands" });
  }
});


// ==========================================
// 🚨 UNRESPONSIVE-SHOP ESCALATION WORKER
// ==========================================
// Scans every 30s for Pending orders and escalates by age:
//   T+2min  → loud push + SMS to shop owner
//   T+5min  → automated voice call to shop owner
//   T+15min → auto-cancel, refund coins, flag/issue Razorpay refund, notify both
// Tier progress is persisted on the order so restarts don't double-fire and
// shops that accept mid-escalation stop receiving further escalation events.
const ESCALATION_TIERS = [
  { tier: 1, afterMs: 2 * 60 * 1000,  name: 'sms+loud-push' },
  { tier: 2, afterMs: 5 * 60 * 1000,  name: 'voice-call'    },
  { tier: 3, afterMs: 15 * 60 * 1000, name: 'auto-cancel'   },
];
const ESCALATION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // safety: don't spam old/forgotten orders on first boot
const ESCALATION_SCAN_INTERVAL_MS = 30 * 1000;

async function fireEscalationTier(order, tier) {
  const shortId = order._id.toString().slice(-5).toUpperCase();
  const shopId = order.shopId?._id || order.shopId;
  const shopPhone = order.shopId?.phone || null;
  const amount = order.totalAmount;

  if (tier.tier === 1) {
    const title = '⚠️ ORDER WAITING — ACT NOW';
    const msg = `🚨 Order #${shortId} (₹${amount}) is still unaccepted. Tap Accept or Cancel immediately.`;
    await Notification.create({ shopId, orderId: order._id, type: 'new_order', title, message: msg });
    await sendPushNotification(shopId, title, msg);
    if (shopPhone) await sendSmsToPhone(shopPhone, `PackItOut: Order #${shortId} (Rs.${amount}) waiting. Open app & accept now.`);
    return;
  }

  if (tier.tier === 2) {
    const script = `This is an urgent call from PackItOut. Order ${shortId} for rupees ${amount} is still waiting for your acceptance. Please open the app and accept or cancel the order immediately.`;
    if (shopPhone) await placeVoiceCallToPhone(shopPhone, script);
    const title = '📞 AUTO-CALL PLACED';
    const msg = `Automated call sent for Order #${shortId} — please respond.`;
    await Notification.create({ shopId, orderId: order._id, type: 'new_order', title, message: msg });
    await sendPushNotification(shopId, title, msg);
    return;
  }

  if (tier.tier === 3) {
    await autoCancelOrder(order);
    return;
  }
}

// Generic cancellation + refund helper, shared by the auto-cancel worker, the
// admin force-cancel route, the shop-initiated cancel, and the user-initiated
// cancel. All four paths must refund identically or audits will diverge.
//
// opts:
//   statusLabel   — what to write to order.status (e.g. "Cancelled ❌ (by shop)")
//   customerTitle — push title shown to the customer
//   customerMsg   — push body shown to the customer
//   shopTitle     — push title shown to the shop (omit to skip)
//   shopMsg       — push body shown to the shop
async function cancelOrderWithRefund(order, opts) {
  const { statusLabel, customerTitle, customerMsg, shopTitle, shopMsg } = opts;
  const shortId = order._id.toString().slice(-5).toUpperCase();

  // Refund coins regardless of payment method — they were debited at checkout.
  if (order.coinsUsed > 0 && order.userId && mongoose.Types.ObjectId.isValid(order.userId._id || order.userId)) {
    const userId = order.userId._id || order.userId;
    try { await User.findByIdAndUpdate(userId, { $inc: { coins: order.coinsUsed } }); }
    catch (e) { console.error('[cancel] coin refund failed:', e.message); }
  }

  // Razorpay refund — fires only if AUTO_REFUND_ENABLED=true, otherwise flagged for admin.
  let refundFlag = { pending: false, razorpayRefundId: '', attemptedAt: null };
  if (order.paymentStatus === 'Paid' && order.razorpayPaymentId) {
    const r = await issueRazorpayRefund(order);
    refundFlag = {
      pending: !r.delivered,
      razorpayRefundId: r.refundId || '',
      attemptedAt: new Date(),
    };
  }

  order.status = statusLabel;
  order.statusHistory = [...(order.statusHistory || []), { status: statusLabel, at: new Date() }];
  order.refund = refundFlag;
  await order.save();

  // Notify customer.
  const customerId = order.userId?._id || order.userId;
  if (customerId && mongoose.Types.ObjectId.isValid(customerId) && customerTitle) {
    try {
      await Notification.create({ userId: customerId, orderId: order._id, type: 'order_cancelled', title: customerTitle, message: customerMsg });
      await sendPushNotification(customerId, customerTitle, customerMsg);
    } catch (e) { console.error('[cancel] customer notify failed:', e.message); }
  }

  // Notify shop (optional — skip for shop-initiated cancel; they already know).
  const shopId = order.shopId?._id || order.shopId;
  if (shopId && shopTitle) {
    try {
      await Notification.create({ shopId, orderId: order._id, type: 'order_cancelled', title: shopTitle, message: shopMsg });
      await sendPushNotification(shopId, shopTitle, shopMsg);
    } catch (e) { console.error('[cancel] shop notify failed:', e.message); }
  }
}

// Thin wrapper kept for the escalation worker — preserves the original
// auto-cancel messaging so customers see "shop didn't respond" wording.
async function autoCancelOrder(order) {
  const shortId = order._id.toString().slice(-5).toUpperCase();
  return cancelOrderWithRefund(order, {
    statusLabel: 'Cancelled ❌ (shop unresponsive)',
    customerTitle: 'Order Cancelled ❌',
    customerMsg:   `Order #${shortId} was auto-cancelled — the shop didn't respond. Refund is being processed.`,
    shopTitle:     '⚠️ Order Auto-Cancelled',
    shopMsg:       `Order #${shortId} was auto-cancelled — you didn't respond within 15 minutes.`,
  });
}

async function runEscalationScan() {
  try {
    const now = Date.now();
    const firstTierCutoff = new Date(now - ESCALATION_TIERS[0].afterMs);
    const maxAgeCutoff   = new Date(now - ESCALATION_MAX_AGE_MS);

    const candidates = await Order.find({
      status: 'Pending',
      createdAt: { $lte: firstTierCutoff, $gte: maxAgeCutoff },
    })
      .populate('shopId', 'name phone')
      .populate('userId', 'name phone');

    for (const order of candidates) {
      const ageMs = now - new Date(order.createdAt).getTime();
      const currentTier = order.escalation?.tier || 0;

      for (const tier of ESCALATION_TIERS) {
        if (tier.tier <= currentTier) continue;
        if (ageMs < tier.afterMs) break;
        try {
          await fireEscalationTier(order, tier);
          order.escalation = { tier: tier.tier, lastFiredAt: new Date() };
          await order.save();
          // If auto-cancel just ran, the order is no longer Pending — stop here.
          if (tier.tier === 3) break;
        } catch (e) {
          console.error(`[escalation] tier ${tier.tier} failed for order ${order._id}:`, e.message);
          break;
        }
      }
    }
  } catch (err) {
    console.error('[escalation] scan error:', err.message);
  }
}

// Kick off after Mongoose has had a moment to connect.
setTimeout(() => {
  console.log(`🚨 Escalation worker armed — scanning every ${ESCALATION_SCAN_INTERVAL_MS / 1000}s`);
  setInterval(runEscalationScan, ESCALATION_SCAN_INTERVAL_MS);
}, 10 * 1000);

// ==========================================
// 🚀 START SERVER
// ==========================================
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
