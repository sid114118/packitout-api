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
const { GoogleGenerativeAI } = require("@google/generative-ai");

const genAI = process.env.GEMINI_API_KEY
  ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
  : null;

// ==========================================
// 🔥 FIREBASE ADMIN SDK — verifies idTokens from Google + email/password
//                          signin on the frontend (UserAuth.jsx).
// ==========================================
// Two supported configs, in priority order:
//   1. Three separate env vars (recommended for Hostinger / most panels):
//        FIREBASE_PROJECT_ID
//        FIREBASE_CLIENT_EMAIL
//        FIREBASE_PRIVATE_KEY    (paste as-is including \n; we un-escape below)
//   2. Single-blob env var (works for local dev / Vercel / Netlify):
//        FIREBASE_SERVICE_ACCOUNT_JSON   (raw JSON, no surrounding quotes)
// Hostinger's env panel adds a leading '\' before '{' when storing JSON, which
// breaks JSON.parse — hence the 3-var primary path.
let firebaseAdmin = null;
try {
  const admin = require("firebase-admin");

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  let privateKey = process.env.FIREBASE_PRIVATE_KEY;

  if (projectId && clientEmail && privateKey) {
    // Normalise the private key value defensively. Env panels mangle it in
    // several ways depending on the host:
    //   - wrap the value in extra "..." or '...' quotes
    //   - escape '\n' as the literal 2 chars (\ + n)
    //   - double-escape backslashes (\\n → 4 chars on disk)
    //   - already contain real newlines (multi-line panel)
    privateKey = privateKey.trim();
    if ((privateKey.startsWith('"') && privateKey.endsWith('"')) ||
        (privateKey.startsWith("'") && privateKey.endsWith("'"))) {
      privateKey = privateKey.slice(1, -1);
    }
    // Order matters: collapse double-escape first, then single-escape.
    privateKey = privateKey.replace(/\\\\n/g, "\n").replace(/\\n/g, "\n");

    // Diagnostic log — describes the shape without revealing the value.
    console.log("[firebase-admin] privateKey shape:",
      "len=" + privateKey.length,
      "startsWithBegin=" + privateKey.startsWith("-----BEGIN"),
      "endsWithEnd=" + privateKey.trimEnd().endsWith("-----END PRIVATE KEY-----"),
      "newlineCount=" + (privateKey.match(/\n/g) || []).length,
    );

    firebaseAdmin = admin.initializeApp({
      credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
    });
    console.log("[firebase-admin] initialized (3-var) for project:", projectId);
  } else if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    let raw = String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON).trim();
    // Some panels prepend '\' before the leading '{'. Strip it defensively.
    if (raw.startsWith("\\")) raw = raw.slice(1);
    const serviceAccount = JSON.parse(raw);
    firebaseAdmin = admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    console.log("[firebase-admin] initialized (json-blob) for project:", serviceAccount.project_id);
  } else {
    console.warn("[firebase-admin] No credentials configured (need FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY, or FIREBASE_SERVICE_ACCOUNT_JSON). OAuth routes will 503.");
  }
} catch (e) {
  console.error("[firebase-admin] failed to initialize:", e.message);
}

// Verify a Firebase ID token. Returns decoded claims or throws. Centralized so
// all auth endpoints reject the same way when the SDK isn't configured.
const verifyFirebaseIdToken = async (idToken) => {
  if (!firebaseAdmin) {
    const err = new Error("Firebase Admin not configured on server.");
    err.statusCode = 503;
    throw err;
  }
  if (!idToken || typeof idToken !== "string") {
    const err = new Error("Missing idToken.");
    err.statusCode = 400;
    throw err;
  }
  return await firebaseAdmin.auth().verifyIdToken(idToken);
};

// ==========================================
// 🧰 SMALL FIELD HELPERS (hoisted — used by POST /orders below)
// ==========================================
// Pick only whitelisted keys from a body so callers can't sneak in fields not
// in the schema (e.g. forging status="Picked Up ✅" / paymentStatus="Paid" /
// totalAmount=0 to bypass the trusted-server recompute).
const pickFields = (src, allow) => {
  const out = {};
  for (const k of allow) if (src && Object.prototype.hasOwnProperty.call(src, k)) out[k] = src[k];
  return out;
};
// Accept searchTags either as a CSV string (legacy admin form) or an array.
const normaliseSearchTags = (val) => {
  if (Array.isArray(val)) return val.map(t => String(t).trim()).filter(Boolean);
  if (typeof val === 'string') return val.split(',').map(t => t.trim()).filter(Boolean);
  return undefined;
};

// ==========================================
// 🧾 PARCHI UPLOAD PACKAGES
// ==========================================
// Cloudinary credentials are required from env. The old hardcoded fallback
// values were committed to the repo and so are considered public — they MUST
// be rotated on the Cloudinary dashboard and the new values set on Hostinger
// as CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET
// before deploying. Until that's done image upload routes will fail loud.
if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
  console.error("[Cloudinary] CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET env vars are required. Image uploads will fail until set.");
}
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// File uploads: cap at 8 MB and reject anything that isn't an image. Without
// these, an attacker can POST a 5 GB body to /upload-parchi or /extract-parchi
// and fill /tmp on the Hostinger box.
const IMAGE_MIME_RE = /^image\/(jpe?g|png|webp|heic|heif)$/i;
const imageUploadOpts = {
  dest: '/tmp/',
  limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB
  fileFilter: (_req, file, cb) => cb(null, IMAGE_MIME_RE.test(file.mimetype || '')),
};
const upload = multer(imageUploadOpts);
// CSV bulk-upload — keep memory storage but cap at 5 MB.
const memoryUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

// Safe wrapper so synchronous unlinkSync calls never throw on a missing path
// (and never block the event loop on cleanup).
const safeUnlink = (p) => { try { if (p) fs.unlinkSync(p); } catch (e) {} };

const app = express();

// CORS allowlist. Set CORS_ORIGINS to a comma-separated list of allowed
// origins (e.g. "https://packitout.app,https://admin.packitout.app"). Defaults
// to "*" for backwards-compatibility during rollout; tighten once the
// production origins are known.
const corsAllowlist = String(process.env.CORS_ORIGINS || '*')
  .split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: corsAllowlist.includes('*') ? '*' : corsAllowlist,
  methods: ["GET", "POST", "PATCH", "PUT", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Admin-Token"],
}));

app.use(express.json({ limit: '1mb' }));

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
  // Password hash — select:false so it never leaks via the public GET /shops
  // endpoint, which used to dump every shop's hash in plain text.
  password: { type: String, required: true, select: false },
  pincode: String, 
  serviceablePincodes: { type: [String], default: [] }, 
  isOpen: { type: Boolean, default: true },
  isAcceptingOrders: { type: Boolean, default: true },
  // Pickup location as GeoJSON Point. coordinates are [longitude, latitude]
  // — Mongo's order, NOT the lat/lng order most APIs use. The whole field is
  // unset until the shop taps "Use my current location" in the dashboard, so
  // the 2dsphere index above tolerates missing docs (sparse-by-default).
  location: {
    type: { type: String, enum: ['Point'], default: 'Point' },
    coordinates: { type: [Number], default: undefined },
  },
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
// 2dsphere index on the GeoJSON `location` so geo queries are fast. Shops set
// this once via "Use my current location" in the dashboard; without it they
// just don't get a distance shown in the customer's Nearby grid.
shopSchema.index({ location: '2dsphere' });
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

// Saved address book entry. Each user can keep multiple — Home, Work, etc.
// At most one is `isDefault: true`, enforced in app code (Mongo can't enforce
// "exactly one true" inside a subdoc array without an aggregation guard).
const addressSchema = new mongoose.Schema({
  label: { type: String, default: 'Home' },       // "Home" / "Work" / freeform
  line1: { type: String, default: '' },
  line2: { type: String, default: '' },
  landmark: { type: String, default: '' },
  pincode: { type: String, default: '' },
  isDefault: { type: Boolean, default: false },
}, { _id: true });

const userSchema = new mongoose.Schema({
  name: String,
  // phone is now optional — new email/Google signups don't have one until the
  // user adds it at checkout via /users/:id/phone. sparse:true so the unique
  // index allows multiple docs with no phone.
  phone: { type: String, unique: true, sparse: true },
  // Email-first identity. sparse:true so legacy phone-only users (email=null)
  // don't collide on the unique index. Stored lowercase to keep lookups normal.
  email: { type: String, unique: true, sparse: true, lowercase: true, trim: true },
  // Firebase uid — the stable cross-provider identifier. Set on first OAuth
  // login. unique+sparse so phone-only legacy users (no firebaseUid yet) coexist.
  firebaseUid: { type: String, unique: true, sparse: true },
  // Which sign-in methods this account has linked. e.g. ["password", "google.com"].
  // Used to decide what to show in UI ("manage sign-in methods").
  authProviders: { type: [String], default: [] },
  // Password hash — select:false so it never leaks via GET /users or
  // /users/:id, which used to return it on every response. Legacy phone+pw
  // users still authenticate via /login; new email users authenticate via
  // Firebase (Firebase stores the hash), so this stays empty for them.
  password: { type: String, select: false },
  // pincode + address kept for backwards-compat (legacy single-address rows
  // and the user's PIN, which still drives serviceable-shop discovery).
  // New saved-address book lives in `addresses` below; the frontend reads
  // from there first and falls back to the legacy field for old users.
  pincode: String, address: String,
  addresses: { type: [addressSchema], default: [] },
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
  status: { type: String, default: "Pending" },
  // Payment model is now two-method:
  //   'UPI' — customer transfers directly to the shop's UPI ID at checkout.
  //           paymentStatus starts as 'PendingVerification'; the shop confirms
  //           receipt via POST /orders/:id/mark-paid, which flips it to 'Paid'.
  //   'POP' — pay on pickup (cash or in-person UPI at the counter). Stays
  //           'Unpaid' until the shop marks the order Picked Up ✅.
  // Razorpay was removed in favour of direct shop UPI (no gateway = no fees +
  // money lands instantly in the shop's bank).
  paymentMethod: { type: String, enum: ['UPI', 'POP'], default: 'POP' },
  paymentStatus: { type: String, enum: ['Unpaid', 'PendingVerification', 'Paid'], default: 'Unpaid' },
  isReviewed: { type: Boolean, default: false },
  coinsUsed: { type: Number, default: 0 },
  // Idempotency flag for the loyalty-coin grant at pickup. Set once, never
  // unset. Prevents shops from toggling status back and forth and re-awarding
  // coins, and prevents two concurrent PATCH /orders/:id from both crediting.
  coinsAwarded: { type: Boolean, default: false },
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
  // 🔁 Refund bookkeeping for cancelled orders.
  // Because money now flows directly to the shop's UPI (no gateway), the
  // platform can't push the money back — it can only refund the loyalty
  // coins the customer redeemed. If paymentStatus was 'Paid', `pending=true`
  // tells the shop they owe the customer their UPI amount back manually.
  // coinsRefunded: idempotency flag — once true, the coin refund is never
  // re-issued, no matter how many cancel paths race. Set via an atomic
  // update inside cancelOrderWithRefund().
  refund: {
    pending: { type: Boolean, default: false },
    attemptedAt: { type: Date, default: null },
    coinsRefunded: { type: Boolean, default: false },
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

// Parchi (handwritten shopping list). Status lifecycle:
//   'pending'   — uploaded by customer, awaiting shop quote
//   'quoted'    — shop has built a bill and sent it; customer is choosing payment
//   'accepted'  — customer accepted via UPI or pay-on-pickup; order created
//   'processed' — legacy terminal state from before the bill flow existed
//   'cancelled' — explicitly closed without becoming an order
// The bill embeds the shop's UPI ID at quote time so a later edit to the
// shop's profile doesn't retroactively change what the customer paid against.
const parchiBillItemSchema = new mongoose.Schema({
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'MasterProduct', default: null },
  name: { type: String, default: '' },
  qty: { type: Number, default: 1 },
  price: { type: Number, default: 0 },
  image: { type: String, default: '' },
  emoji: { type: String, default: '' },
}, { _id: false });

const parchiSchema = new mongoose.Schema({
  userId: String, shopId: String, customerName: String, imageUrl: String,
  status: { type: String, default: 'pending' },
  bill: {
    items: { type: [parchiBillItemSchema], default: [] },
    totalAmount: { type: Number, default: 0 },
    sentAt: { type: Date, default: null },
    shopUpiId: { type: String, default: '' },
    shopName: { type: String, default: '' },
  },
  acceptedPaymentMethod: { type: String, default: '' }, // 'UPI' | 'POP'
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null },
  createdAt: { type: Date, default: Date.now },
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
  purpose: { type: String, enum: ['register', 'login', 'reset'], default: 'register' },
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

// Lightweight in-memory rate limiter — keyed by IP + route bucket. Drops the
// oldest hits outside the window so a steady stream of allowed requests doesn't
// keep them tagged as rate-limited forever. Single-process only; behind a load
// balancer we'd switch to Redis. Routes call rateLimit('bucket', max, windowMs).
const rateLimitBuckets = new Map(); // key -> [timestamps]
const rateLimit = (bucket, max, windowMs) => (req, res, next) => {
  const ip = (req.headers['x-forwarded-for']?.toString().split(',')[0] || req.ip || req.connection?.remoteAddress || 'unknown').trim();
  const key = `${bucket}:${ip}`;
  const now = Date.now();
  const past = (rateLimitBuckets.get(key) || []).filter(t => now - t < windowMs);
  if (past.length >= max) {
    return res.status(429).json({ error: "Too many requests. Please slow down." });
  }
  past.push(now);
  rateLimitBuckets.set(key, past);
  next();
};

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

// ==========================================
// 🛡️ ADMIN TOKEN GUARD
// ==========================================
// Set ADMIN_TOKEN on Hostinger (any long random string — e.g. 64 hex chars).
// Admin frontend sends it in X-Admin-Token on every /admin/* and destructive
// route. If unset on the server, all admin routes refuse with 503 so a
// mis-configured deploy fails loud instead of silently allowing everyone.
const requireAdmin = (req, res, next) => {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return res.status(503).json({ error: "Admin token not configured on server. Set ADMIN_TOKEN env var." });
  const provided = req.headers['x-admin-token'] || req.headers['X-Admin-Token'];
  if (!provided || typeof provided !== 'string' || provided !== expected) {
    return res.status(401).json({ error: "Admin token missing or invalid" });
  }
  next();
};

// POST /admin/login — frontend exchange. AdminLogin sends { password }; if it
// matches ADMIN_PASSWORD env, server hands back ADMIN_TOKEN which the
// dashboard stores in localStorage and sends as X-Admin-Token on every call.
// Until both env vars are set on Hostinger, every admin route is locked.
app.post("/admin/login", express.json(), (req, res) => {
  const expectedPw = process.env.ADMIN_PASSWORD;
  const token = process.env.ADMIN_TOKEN;
  if (!expectedPw || !token) {
    return res.status(503).json({ error: "Admin auth not configured. Set ADMIN_PASSWORD and ADMIN_TOKEN on the server." });
  }
  const given = String(req.body?.password || "");
  if (given !== expectedPw) return res.status(401).json({ error: "Invalid admin password" });
  res.json({ token });
});

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
// Money refunds are NOT auto-issued — payment now flows directly to the shop's
// UPI ID with no platform gateway, so only the shop can return the cash. The
// cancellation path just flags `order.refund.pending=true` so the shop knows.
const ESCALATION_SMS_CONFIGURED = false;
const ESCALATION_VOICE_CONFIGURED = false;

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
      // Force IST so the shop sees Indian local time even when the server
      // (Hostinger) is running in UTC.
      const clock = dt.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });
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
// OneSignal credentials. REST API key MUST come from env. App ID is public
// (it ships in the SDK init in the browser), so the hardcoded fallback is fine.
// Env var names match .env.example: ONESIGNAL_APP_ID / ONESIGNAL_API_KEY.
const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID || process.env.ONE_SIGNAL_APP_ID || "1da2e78d-0874-4965-a895-42c9237ee92b";
const ONESIGNAL_API_KEY = process.env.ONESIGNAL_API_KEY || process.env.ONE_SIGNAL_API_KEY;
if (!ONESIGNAL_API_KEY) {
  console.error("[OneSignal] ONESIGNAL_API_KEY env var is missing — push notifications will not be sent.");
}
// v16 SDK registers users via OneSignal.login(id), which creates an External ID
// alias. The legacy `include_external_user_ids` field is deprecated and silently
// drops on accounts created in 2024+; use `include_aliases.external_id` with an
// explicit `target_channel` instead.
const sendPushNotification = async (targetUserId, title, message) => {
  if (!ONESIGNAL_API_KEY) return;
  try {
    const response = await fetch("https://onesignal.com/api/v1/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8", "Authorization": `Basic ${ONESIGNAL_API_KEY}` },
      body: JSON.stringify({
        app_id: ONESIGNAL_APP_ID,
        target_channel: "push",
        include_aliases: { external_id: [targetUserId.toString()] },
        headings: { en: title },
        contents: { en: message },
      })
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
// Bearer-token gated — :userId / :shopId must match the session that's asking.
// Previously unauth'd, so any visitor with a guessed/leaked ObjectId could
// scrape another user's notification history (order statuses, refund pings, etc).
app.get("/notifications/user/:userId", requireUser, async (req, res) => {
  try {
    if (req.user._id.toString() !== req.params.userId) {
      return res.status(403).json({ error: "Not your notifications" });
    }
    res.json(await Notification.find({ userId: req.params.userId }).sort({ createdAt: -1 }).limit(20));
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get("/notifications/shop/:shopId", requireShop, async (req, res) => {
  try {
    if (req.shop._id.toString() !== req.params.shopId) {
      return res.status(403).json({ error: "Not your notifications" });
    }
    res.json(await Notification.find({ shopId: req.params.shopId }).sort({ createdAt: -1 }).limit(20));
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.patch("/notifications/read-all", async (req, res) => {
  try {
    // Coerce ids to plain strings to defeat operator-injection
    // (e.g. {"userId": {"$ne": null}} would mark every notification read).
    const rawUserId = req.body?.userId;
    const rawShopId = req.body?.shopId;
    const userId = (typeof rawUserId === 'string' || typeof rawUserId === 'number') ? String(rawUserId) : null;
    const shopId = (typeof rawShopId === 'string' || typeof rawShopId === 'number') ? String(rawShopId) : null;
    if (!userId && !shopId) return res.status(400).json({ error: "userId or shopId required" });
    const filter = userId
      ? (mongoose.Types.ObjectId.isValid(userId) ? { userId } : null)
      : (mongoose.Types.ObjectId.isValid(shopId) ? { shopId } : null);
    if (!filter) return res.status(400).json({ error: "Invalid id" });
    await Notification.updateMany(filter, { $set: { isRead: true } });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: "Failed to update notifications" }); }
});

// 🚨 ADMIN OVERRIDE PING ROUTE
app.post("/admin/ping-shop", requireAdmin, async (req, res) => {
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
// T+15min worker uses: refunds coins, flags pending UPI refund, notifies both
// sides. Use when the shop can't be reached or the customer asks to cancel.
app.post("/admin/orders/:id/force-cancel", requireAdmin, async (req, res) => {
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
app.post("/admin/orders/:id/force-accept", requireAdmin, async (req, res) => {
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
app.post("/admin/orders/:id/ops-log", requireAdmin, async (req, res) => {
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
// Bearer-token gated. userId is taken from the session, not the body — used to
// be unauth'd, which let anyone forge uploads attributed to any user or shop.
// Rate-limited: 10 uploads per minute per IP to stop spam fills of Cloudinary.
app.post("/upload-parchi", rateLimit('upload-parchi', 10, 60 * 1000), requireUser, upload.single('parchiImage'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No image." });
  try {
    const shopId = req.body?.shopId && mongoose.isValidObjectId(req.body.shopId) ? req.body.shopId : null;
    if (!shopId) return res.status(400).json({ error: "Valid shopId required" });
    const result = await cloudinary.uploader.upload(req.file.path, { folder: 'packitout_parchis' });
    const newParchi = new Parchi({
      userId: req.user._id.toString(),
      shopId,
      customerName: req.user.name || req.body.customerName || 'Customer',
      imageUrl: result.secure_url,
    });
    await newParchi.save();
    res.status(200).json({ success: true, parchi: newParchi });
  } catch (error) {
    res.status(500).json({ error: "Upload failed." });
  } finally {
    safeUnlink(req.file?.path);
  }
});

// 🤖 AI PARCHI EXTRACTION — reads handwritten list with Gemini and matches to catalog.
// Login-gated: response includes per-shop selling prices, which previously
// leaked to any unauthenticated caller who knew/guessed a shopId.
// Rate-limited: Gemini calls cost money — 6/min/IP cap.
app.post("/extract-parchi", rateLimit('extract-parchi', 6, 60 * 1000), requireUser, upload.single('parchiImage'), async (req, res) => {
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

    // multer's 8 MB limit means the file is small enough to read into memory.
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

    // Temp file cleanup is in the route's finally — no per-branch unlink needed.

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
    res.status(500).json({ error: "Extraction failed." });
  } finally {
    safeUnlink(req.file?.path);
  }
});
// Parchi (handwritten shopping list) lookups. Bearer-token gated — only the
// shop that owns the parchis or the user who uploaded them can read them.
// Previously unauth'd, which let any visitor list another shop's pending
// parchis or another user's uploads.
app.get("/parchis/:shopId", requireShop, async (req, res) => {
  try {
    if (req.shop._id.toString() !== req.params.shopId) {
      return res.status(403).json({ error: "Not your shop" });
    }
    res.json(await Parchi.find({ shopId: req.params.shopId, status: 'pending' }).sort({createdAt: -1}));
  } catch(err) { res.status(500).json({ error: err.message }); }
});
app.get("/parchis/user/:userId", requireUser, async (req, res) => {
  try {
    if (req.user._id.toString() !== req.params.userId) {
      return res.status(403).json({ error: "Not your parchis" });
    }
    res.json(await Parchi.find({ userId: req.params.userId, status: 'pending' }).sort({createdAt: -1}));
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get("/admin/all-parchis", requireAdmin, async (req, res) => {
  try { res.json(await Parchi.find({ status: 'pending' }).sort({ createdAt: -1 })); } catch (err) { res.status(500).json({ error: err.message }); }
});

// 🧾 PARCHI BILL — shop builds a quote for a customer's handwritten list.
// Bearer-token gated; shop must own the parchi. Items are re-validated against
// the shop's live inventory so a shop can't quote out-of-stock items and
// prices snap back to the shop's current sellingPrice (the dashboard UI is
// already wired to the same numbers, but the server is the source of truth).
app.post("/parchis/:id/send-bill", requireShop, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "Invalid parchi id" });
    const parchi = await Parchi.findById(req.params.id);
    if (!parchi) return res.status(404).json({ error: "Parchi not found" });
    if (String(parchi.shopId) !== req.shop._id.toString()) {
      return res.status(403).json({ error: "Not your parchi" });
    }
    if (parchi.status !== 'pending') {
      return res.status(400).json({ error: `Bill already ${parchi.status}` });
    }

    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (items.length === 0) return res.status(400).json({ error: "items required" });

    const shop = await Shop.findById(req.shop._id).populate('inventory.product');
    if (!shop) return res.status(404).json({ error: "Shop not found" });
    if (!shop.upiId || !String(shop.upiId).includes('@')) {
      return res.status(400).json({ error: "Set your UPI ID in shop profile before sending a bill." });
    }

    // Build the inventory lookup, then snap each requested item to the shop's
    // canonical product + sellingPrice. Drops anything not in stock — we won't
    // quote items the shop can't actually fulfill.
    const invByProduct = new Map();
    for (const inv of (shop.inventory || [])) {
      if (!inv.product || inv.inStock === false) continue;
      invByProduct.set(inv.product._id.toString(), { inv, product: inv.product });
    }

    const billItems = [];
    let totalAmount = 0;
    for (const raw of items) {
      const pid = raw?.productId && mongoose.isValidObjectId(raw.productId) ? raw.productId.toString() : null;
      if (!pid) continue;
      const match = invByProduct.get(pid);
      if (!match) continue; // not in stock at this shop — silently drop
      const qty = Math.max(1, Math.min(99, Math.floor(Number(raw.qty) || 1)));
      const price = Number(match.inv.sellingPrice || match.product.mrp || 0);
      billItems.push({
        productId: match.product._id,
        name: match.product.name,
        qty,
        price,
        image: match.product.image || '',
        emoji: match.product.emoji || '',
      });
      totalAmount += price * qty;
    }
    if (billItems.length === 0) {
      return res.status(400).json({ error: "None of the items are currently in stock at this shop." });
    }

    parchi.bill = {
      items: billItems,
      totalAmount,
      sentAt: new Date(),
      shopUpiId: shop.upiId,
      shopName: shop.name || '',
    };
    parchi.status = 'quoted';
    await parchi.save();

    // Tell the customer their bill is ready.
    if (parchi.userId && mongoose.isValidObjectId(parchi.userId)) {
      const title = '🧾 Your Bill is Ready';
      const body = `${shop.name || 'The shop'} prepared your parchi: ₹${totalAmount}. Tap to pay or choose pay-on-pickup.`;
      try {
        await Notification.create({ userId: parchi.userId, type: 'system', title, message: body });
        await sendPushNotification(parchi.userId, title, body);
      } catch (e) { console.log('parchi bill notify skipped:', e.message); }
    }

    res.json({ success: true, parchi });
  } catch (err) {
    console.error('send-bill error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 🧾 PARCHI BILL — customer accepts a quoted bill. paymentMethod is either:
//   'UPI' — customer has already paid via UPI deep link to shop's UPI ID
//   'POP' — pay on pickup (cash/UPI to shop at the counter)
// Either way, an Order is created with the bill's items + total so the order
// shows up in OrdersPage and the shop's OrdersTab like a normal order.
app.post("/parchis/:id/accept-bill", requireUser, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "Invalid parchi id" });
    const parchi = await Parchi.findById(req.params.id);
    if (!parchi) return res.status(404).json({ error: "Parchi not found" });
    if (String(parchi.userId) !== req.user._id.toString()) {
      return res.status(403).json({ error: "Not your parchi" });
    }
    if (parchi.status !== 'quoted') {
      return res.status(400).json({ error: `Bill is ${parchi.status}, not awaiting confirmation` });
    }
    const method = String(req.body?.paymentMethod || '').toUpperCase();
    if (!['UPI', 'POP'].includes(method)) {
      return res.status(400).json({ error: "paymentMethod must be 'UPI' or 'POP'." });
    }
    const bill = parchi.bill || {};
    if (!Array.isArray(bill.items) || bill.items.length === 0 || !(bill.totalAmount > 0)) {
      return res.status(400).json({ error: "Bill is incomplete." });
    }
    if (!mongoose.isValidObjectId(parchi.shopId)) {
      return res.status(400).json({ error: "Invalid shop reference on parchi." });
    }

    // Atomic state transition so two concurrent accepts don't both create
    // an order. The losing call sees modifiedCount=0 and bails.
    const claim = await Parchi.updateOne(
      { _id: parchi._id, status: 'quoted' },
      { $set: { status: 'accepted', acceptedPaymentMethod: method } }
    );
    if (claim.modifiedCount !== 1) {
      return res.status(409).json({ error: "Bill was already accepted or cancelled." });
    }

    const orderItems = bill.items.map(it => ({
      productId: it.productId,
      name: it.name,
      qty: it.qty,
      price: it.price,
      sellingPrice: it.price,
      image: it.image,
      emoji: it.emoji,
    }));
    const order = await Order.create({
      userId: req.user._id,
      shopId: parchi.shopId,
      items: orderItems,
      totalAmount: bill.totalAmount,
      paymentMethod: method === 'UPI' ? 'UPI' : 'POP',
      // UPI starts as 'PendingVerification' — the shop confirms receipt via
      // POST /orders/:id/mark-paid once the money lands in their UPI app.
      // The previous behaviour saved UPI orders as 'Paid' before any proof
      // of payment, which let a customer "accept-bill via UPI" and never
      // actually transfer the money.
      paymentStatus: method === 'UPI' ? 'PendingVerification' : 'Unpaid',
      status: 'Pending',
      imageUrl: parchi.imageUrl || '',
      statusHistory: [{ status: 'Pending', at: new Date() }],
    });
    await Parchi.updateOne({ _id: parchi._id }, { $set: { orderId: order._id } });

    // Notify shop — same shape as the regular new-order notif.
    const shortId = order._id.toString().slice(-5).toUpperCase();
    const { title: shopTitle, message: shopMessage } = buildNewOrderShopNotif(shortId, order.totalAmount, false, null);
    try {
      await Notification.create({ shopId: parchi.shopId, orderId: order._id, type: 'new_order', title: shopTitle, message: shopMessage });
      await sendPushNotification(parchi.shopId, shopTitle, shopMessage);
    } catch (e) { console.log('parchi accept shop notify skipped:', e.message); }

    res.json({ success: true, order });
  } catch (err) {
    console.error('accept-bill error:', err);
    res.status(500).json({ error: err.message });
  }
});

// User's own parchis with any status — fuels the "My Bills" list so customers
// can find a quote they missed in the bell.
app.get("/parchis/user/:userId/all", requireUser, async (req, res) => {
  try {
    if (req.user._id.toString() !== req.params.userId) {
      return res.status(403).json({ error: "Not your parchis" });
    }
    const list = await Parchi.find({ userId: req.params.userId })
      .sort({ createdAt: -1 })
      .limit(50);
    res.json(list);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin manual coin adjustment. Set or add to a user's coin balance from the
// Users tab. Used to be done via PATCH /users/:id with { coins }, but that
// route is now field-whitelisted (the customer can't change their own coins).
app.post("/admin/users/:id/coins", requireAdmin, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid user id" });
    }
    const mode = req.body?.mode === 'inc' ? 'inc' : 'set';
    const value = Number(req.body?.value);
    if (!Number.isFinite(value)) return res.status(400).json({ error: "value must be a number" });

    const update = mode === 'inc'
      ? { $inc: { coins: Math.floor(value) } }
      : { $set: { coins: Math.max(0, Math.floor(value)) } };
    const user = await User.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json(user);
  } catch (err) { res.status(500).json({ error: "Failed to update coins" }); }
});

// 🧑‍💼 Admin "drill-into-user" view. One round-trip returns everything the
// admin UserProfileModal renders: profile, derived stats, full order history
// (shop populated), reviews left, complaints filed, parchis uploaded, plus
// derived "interests" (top brands / items / favourite shop, urgent/COD splits).
// Heavy by design — only the admin tab hits it, paginated drill-down can come
// later if the order list grows large.
app.get("/admin/users/:id/profile", requireAdmin, async (req, res) => {
  try {
    const userId = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ error: "Invalid user id" });
    }

    // Run the independent fetches in parallel to keep the modal snappy.
    const [user, orders, reviews, complaints, parchis] = await Promise.all([
      User.findById(userId).populate('primaryShop', 'name pincode').lean(),
      Order.find({ userId }).populate('shopId', 'name pincode phone').sort({ createdAt: -1 }).lean(),
      Review.find({ userId }).sort({ createdAt: -1 }).lean(),
      Complaint.find({ userId }).populate('shopId', 'name').sort({ createdAt: -1 }).lean(),
      Parchi.find({ userId: String(userId) }).sort({ createdAt: -1 }).lean(),
    ]);
    if (!user) return res.status(404).json({ error: "User not found" });

    // ObjectId embeds creation timestamp — use it as a free "joined date"
    // even though userSchema has no timestamps field.
    const joinedAt = user._id && user._id.getTimestamp ? user._id.getTimestamp() : null;

    // ---- Derived stats over the full order history ----
    const successfulOrders = orders.filter(o => !/cancel|reject/i.test(o.status || ''));
    const totalSpent = successfulOrders.reduce((s, o) => s + (Number(o.totalAmount) || 0), 0);
    const totalCoinsSpent = successfulOrders.reduce((s, o) => s + (Number(o.coinsUsed) || 0), 0);
    const urgentCount = successfulOrders.filter(o => o.isUrgent).length;
    const codCount = successfulOrders.filter(o => (o.paymentMethod || '').toUpperCase() === 'COD').length;
    const lastOrderAt = orders.length ? orders[0].createdAt : null;
    const daysSinceLastOrder = lastOrderAt ? Math.floor((Date.now() - new Date(lastOrderAt).getTime()) / 86400000) : null;

    // ---- Interests: tally brands, items, shops across all line items ----
    const brandCount = new Map();
    const itemCount = new Map(); // key: productId || name
    const shopCount = new Map();
    const shopNames = new Map(); // shopId -> name (for display)
    for (const o of successfulOrders) {
      if (o.shopId && o.shopId._id) {
        const sid = o.shopId._id.toString();
        shopCount.set(sid, (shopCount.get(sid) || 0) + 1);
        if (o.shopId.name) shopNames.set(sid, o.shopId.name);
      }
      for (const line of (o.items || [])) {
        const brand = (line.brand || '').trim();
        if (brand) brandCount.set(brand, (brandCount.get(brand) || 0) + Number(line.qty || 1));
        const itemKey = (line.productId || line.name || '').toString();
        if (itemKey) {
          const prev = itemCount.get(itemKey) || { name: line.name || itemKey, qty: 0, image: line.image, emoji: line.emoji, brand };
          prev.qty += Number(line.qty || 1);
          itemCount.set(itemKey, prev);
        }
      }
    }
    const topFromMap = (map, n) => [...map.entries()]
      .sort((a, b) => b[1] - a[1]).slice(0, n);

    const interests = {
      topBrands: topFromMap(brandCount, 5).map(([brand, qty]) => ({ brand, qty })),
      topItems: [...itemCount.values()].sort((a, b) => b.qty - a.qty).slice(0, 8),
      favouriteShop: (() => {
        const top = topFromMap(shopCount, 1)[0];
        if (!top) return null;
        const [sid, orderCount] = top;
        return { shopId: sid, name: shopNames.get(sid) || 'Unknown shop', orderCount };
      })(),
      urgentRatio: successfulOrders.length ? Number((urgentCount / successfulOrders.length).toFixed(2)) : 0,
      codRatio: successfulOrders.length ? Number((codCount / successfulOrders.length).toFixed(2)) : 0,
    };

    // Strip secrets — password and sessionTokens (the latter is select:false so
    // shouldn't be here, but defensive).
    const { password, sessionTokens, ...safeUser } = user;

    res.json({
      user: safeUser,
      stats: {
        joinedAt,
        totalOrders: orders.length,
        successfulOrders: successfulOrders.length,
        cancelledOrders: orders.length - successfulOrders.length,
        totalSpent: Number(totalSpent.toFixed(2)),
        totalCoinsSpent,
        lastOrderAt,
        daysSinceLastOrder,
      },
      interests,
      orders,
      reviews,
      complaints,
      parchis,
    });
  } catch (err) {
    console.error("admin user profile error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 💳 PAYMENT (direct UPI to shop + pay-on-pickup)
// ==========================================
// We deliberately do NOT have a payment gateway. Two methods are supported:
//   'UPI' — customer transfers to the shop's UPI ID via deep link at checkout,
//           order is created with paymentStatus='PendingVerification', shop
//           confirms receipt from OrdersTab via POST /orders/:id/mark-paid.
//   'POP' — pay on pickup (cash / in-person UPI), paymentStatus='Unpaid' until
//           the shop marks the order Picked Up ✅.
// computeTrustedTotal is still the source of truth for the cart total in
// either case — the client price/total fields are never trusted.

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
  // If the user tries to spend more than the 10% cap allows, the extra coins
  // are NOT debited — old behaviour silently burned the surplus.
  const requestedCoins = Math.max(0, Math.floor(Number(coinsUsed) || 0));
  const maxDiscountAllowed = itemTotal * 0.10;
  const maxCoinsConsumable = Math.floor(maxDiscountAllowed * 10);
  const actualCoinsUsed = Math.min(requestedCoins, maxCoinsConsumable);
  const coinDiscount = actualCoinsUsed / 10;
  const finalAmount = Math.max(0, Number((itemTotal - coinDiscount).toFixed(2)));

  return { itemTotal, coinDiscount, finalAmount, trustedItems, coinsUsed: actualCoinsUsed };
};

// --- ORDER ROUTES ---
// Fields the client is allowed to set on a new order. status / paymentStatus /
// totalAmount are computed server-side — the old behaviour spread req.body
// straight into the model, so a client could POST status="Picked Up ✅",
// paymentStatus="Paid", totalAmount=0 and bypass payment entirely. userId is
// NOT in this list — it comes from the bearer-token session (req.user._id) so
// callers can't impersonate other users.
const ORDER_CREATE_WRITABLE = [
  'shopId', 'items', 'imageUrl', 'paymentMethod',
  'pickupTime', 'isUrgent',
];

// 🔐 Bearer-token gated. The old route was unauth'd, so anyone could POST an
// order on any user's behalf, drain their coins, or attribute it to any shop.
// userId now comes from the session, not the body.
app.post("/orders", requireUser, async (req, res) => {
  // Track any coin debit so we can refund it if the order save later fails.
  // Coin deduction happens server-side and atomically — guarded $inc so the
  // balance never goes negative even under concurrent checkout attempts.
  let coinRefund = null;
  try {
    const body = pickFields(req.body || {}, ORDER_CREATE_WRITABLE);
    const userId = req.user._id;

    if (!body.shopId || !mongoose.Types.ObjectId.isValid(body.shopId)) {
      return res.status(400).json({ error: "Valid shopId required." });
    }
    if (!Array.isArray(body.items) || body.items.length === 0) {
      return res.status(400).json({ error: "items array required." });
    }
    // paymentMethod is required and limited to the two supported flows.
    // Anything else (legacy "COD" callers, missing field) is rejected so the
    // frontend can't accidentally book an order in a state the shop UI can't
    // settle from.
    const method = String(body.paymentMethod || '').toUpperCase();
    if (!['UPI', 'POP'].includes(method)) {
      return res.status(400).json({ error: "paymentMethod must be 'UPI' or 'POP'." });
    }
    body.paymentMethod = method;
    // Validate pickupTime: must be in the next 24h if set, never in the past.
    if (body.pickupTime) {
      const dt = new Date(body.pickupTime);
      const now = Date.now();
      if (Number.isNaN(dt.getTime()) || dt.getTime() < now - 60_000 || dt.getTime() > now + 24 * 60 * 60 * 1000) {
        return res.status(400).json({ error: "pickupTime must be within the next 24 hours." });
      }
    }

    // If UPI is chosen, the shop must have a UPI ID on file — otherwise the
    // customer has nowhere to send the money. Surface the error at checkout
    // time, not silently later.
    if (method === 'UPI') {
      const shop = await Shop.findById(body.shopId).select('upiId');
      if (!shop || !shop.upiId || !String(shop.upiId).includes('@')) {
        return res.status(400).json({ error: "This shop has not set a UPI ID — please choose Pay on Pickup instead." });
      }
    }

    // Recompute the price + items from the shop's actual inventory so the
    // client can't claim a 0₹ total or sneak in items not in stock.
    const { finalAmount, trustedItems, coinsUsed: actualCoinsUsed } =
      await computeTrustedTotal(body.shopId, body.items, req.body.coinsUsed);

    if (actualCoinsUsed > 0) {
      const r = await User.updateOne(
        { _id: userId, coins: { $gte: actualCoinsUsed } },
        { $inc: { coins: -actualCoinsUsed } }
      );
      if (r.matchedCount === 0) {
        return res.status(400).json({ error: "Insufficient coin balance." });
      }
      coinRefund = { userId, amount: actualCoinsUsed };
    }

    // paymentStatus depends on method:
    //   UPI → 'PendingVerification' (shop must confirm receipt via mark-paid)
    //   POP → 'Unpaid' (flips to Paid when shop marks Picked Up ✅)
    const initialPaymentStatus = method === 'UPI' ? 'PendingVerification' : 'Unpaid';
    const initialStatus = "Pending"; // server-controlled — never trust client
    const o = new Order({
      ...body,
      userId,
      items: trustedItems,
      totalAmount: finalAmount,
      coinsUsed: actualCoinsUsed,
      status: initialStatus,
      paymentStatus: initialPaymentStatus,
      isUrgent: Boolean(body.isUrgent),
      statusHistory: [{ status: initialStatus, at: new Date() }],
    });
    await o.save();
    // Mark the parchi as processed by ID, not by URL — multiple users can share
    // a cached image URL, and the URL filter has no shop scope.
    const parchiId = req.body.parchiId;
    if (parchiId && mongoose.Types.ObjectId.isValid(parchiId)) {
      await Parchi.updateOne({ _id: parchiId }, { $set: { status: 'processed' } });
    } else if (req.body.imageUrl) {
      // Legacy fallback — keep working for old clients but scope to user+shop.
      await Parchi.updateOne(
        { imageUrl: req.body.imageUrl, shopId: String(body.shopId), userId: String(userId) },
        { $set: { status: 'processed' } }
      );
    }

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
// Admin-only firehose, capped at 500 rows. Used by the AdminDashboard global
// orders tab. The user/shop populates exclude their password fields via the
// `select:false` set on the schema. Old behaviour returned every order ever,
// fully populated, with no auth — a real outage waiting to happen.
app.get("/orders", requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 200));
    const orders = await Order.find()
      .populate('userId', 'name phone pincode coins')
      .populate('shopId', 'name phone pincode')
      .sort({ createdAt: -1 })
      .limit(limit);
    res.json(orders);
  } catch (err) { res.status(500).json({ error: "Failed to fetch orders" }); }
});

// Slim per-shop feed for the ShopDashboard. The old behaviour was for every
// shop dashboard to poll GET /orders every 10s, pulling every order on the
// platform, populating it, and filtering client-side — leaking other shops'
// orders and growing linearly with platform volume. This scopes to one shop.
app.get("/orders/shop/:shopId", requireShop, async (req, res) => {
  try {
    if (req.shop._id.toString() !== req.params.shopId) {
      return res.status(403).json({ error: "Not your shop" });
    }
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 200));
    const orders = await Order.find({ shopId: req.params.shopId })
      .populate('userId', 'name phone')
      // re-populate shopId so frontend code that reads order.shopId.name still works
      .populate('shopId', 'name phone pincode')
      .sort({ createdAt: -1 })
      .limit(limit);
    res.json(orders);
  } catch (err) { res.status(500).json({ error: "Failed to fetch shop orders" }); }
});

// Slim per-user feed for the customer feed's "Buy It Again" widget. The old
// approach was to fetch /orders (every order, every user, populated) and filter
// client-side — this avoids the global scan and the populate join.
// Bearer-token gated — :userId must match the session. Previously unauth'd,
// which let any visitor dump another customer's full order history by ID.
app.get("/orders/user/:userId", requireUser, async (req, res) => {
  try {
    if (req.user._id.toString() !== req.params.userId) {
      return res.status(403).json({ error: "Not your orders" });
    }
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
//
// Status transitions are validated against an allowed-predecessors graph so a
// shop can't jump straight from Pending → "Picked Up ✅" (which would trigger
// the loyalty-coin payout before any preparation happens). Anything outside
// the graph is rejected with 400.
// Allowed forward transitions per status. Status strings here must match
// EXACTLY what the shop dashboard sends (matters for emojis + spacing — the
// "Ready to Collect 🛍️" label is verbatim from OrdersTab.jsx).
const ORDER_STATUS_GRAPH = {
  'Pending':                  ['Accepted 👨‍🍳'],
  'Accepted 👨‍🍳':             ['Packing 📦', 'Ready to Collect 🛍️', 'Picked Up ✅'],
  'Packing 📦':               ['Ready to Collect 🛍️', 'Picked Up ✅'],
  'Ready to Collect 🛍️':      ['Picked Up ✅'],
  'Picked Up ✅':             [],
  'Delivered ✅':             [], // legacy terminal state
};
const isValidOrderTransition = (from, to) => {
  if (!to || typeof to !== 'string') return false;
  if (to === from) return true; // no-op PATCH (e.g. resending current state) is fine
  const allowed = ORDER_STATUS_GRAPH[from] || [];
  return allowed.includes(to);
};

app.patch("/orders/:id", requireShop, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (order.shopId.toString() !== req.shop._id.toString()) {
      return res.status(403).json({ error: "Not your order" });
    }
    const nextStatus = req.body?.status;
    if (!nextStatus) return res.status(400).json({ error: "status required" });
    if (/cancel|reject/i.test(nextStatus)) {
      return res.status(400).json({ error: "Use POST /orders/:id/shop-cancel to cancel — keeps refunds consistent" });
    }
    if (!isValidOrderTransition(order.status, nextStatus)) {
      return res.status(400).json({
        error: `Cannot move order from "${order.status}" to "${nextStatus}".`,
      });
    }

    // Final pickup → award loyalty coins (1 coin per ₹10 spent). Match both the
    // new "Picked Up ✅" status and the legacy "Delivered ✅" so older orders
    // still in flight at deploy time keep working. Idempotent: the coinsAwarded
    // flag is set atomically via a conditional update — if two PATCHes race or
    // the shop toggles status back-and-forth, coins are credited at most once.
    const isFinalNow = nextStatus === "Picked Up ✅" || nextStatus === "Delivered ✅";
    if (isFinalNow && !order.coinsAwarded) {
      const safeAmount = Number(order.totalAmount) || 0;
      const earnedCoins = Math.floor(safeAmount / 10);
      const claim = await Order.updateOne(
        { _id: order._id, coinsAwarded: { $ne: true } },
        { $set: { coinsAwarded: true } }
      );
      if (claim.modifiedCount === 1 && earnedCoins > 0 && order.userId && mongoose.Types.ObjectId.isValid(order.userId)) {
        await User.findByIdAndUpdate(order.userId, { $inc: { coins: earnedCoins } });
      }
    }

    // POP orders flip to Paid when the customer takes possession — that's the
    // moment the shop has the cash in hand. UPI orders are flipped separately
    // by POST /orders/:id/mark-paid the moment the shop confirms receipt.
    if (isFinalNow && order.paymentMethod === 'POP' && order.paymentStatus !== 'Paid') {
      order.paymentStatus = 'Paid';
    }

    if (nextStatus !== order.status) {
      order.statusHistory = [...(order.statusHistory || []), { status: nextStatus, at: new Date() }];
    }
    order.status = nextStatus;
    await order.save();

    if (order.userId && mongoose.Types.ObjectId.isValid(order.userId)) {
      try {
        const shortId = order._id.toString().slice(-5).toUpperCase();
        const { type, title, message } = orderNotificationFor(nextStatus, shortId);
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

// 🔐 Shop confirms UPI payment receipt. The order was created with
// paymentStatus='PendingVerification' when the customer chose UPI at checkout;
// the shop opens OrdersTab, sees the order with a "Mark as paid" button, and
// hits this endpoint after checking their UPI app. Customer gets a push so
// they know the shop has acknowledged the payment.
//
// Bearer-token gated; the order must (a) belong to this shop, (b) be UPI, and
// (c) currently be PendingVerification. Idempotent — repeat hits return the
// already-paid order without re-firing notifications.
app.post("/orders/:id/mark-paid", requireShop, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: "Invalid order id" });
    }
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (order.shopId.toString() !== req.shop._id.toString()) {
      return res.status(403).json({ error: "Not your order" });
    }
    if (order.paymentMethod !== 'UPI') {
      return res.status(400).json({ error: "This order is not a UPI order." });
    }
    if (order.paymentStatus === 'Paid') {
      return res.json({ success: true, order, duplicate: true });
    }
    if (order.paymentStatus !== 'PendingVerification') {
      return res.status(400).json({ error: `Cannot mark paid — current status: ${order.paymentStatus}.` });
    }

    // Atomic flip so two devices on the shop's account can't both notify the
    // customer that "we received your UPI."
    const claim = await Order.updateOne(
      { _id: order._id, paymentStatus: 'PendingVerification' },
      { $set: { paymentStatus: 'Paid' } }
    );
    if (claim.modifiedCount !== 1) {
      const fresh = await Order.findById(order._id);
      return res.json({ success: true, order: fresh, duplicate: true });
    }
    order.paymentStatus = 'Paid';

    if (order.userId && mongoose.Types.ObjectId.isValid(order.userId)) {
      const shortId = order._id.toString().slice(-5).toUpperCase();
      const title = 'Payment Confirmed ✅';
      const message = `The shop confirmed your UPI payment for order #${shortId}.`;
      try {
        await Notification.create({ userId: order.userId, orderId: order._id, type: 'order', title, message });
        await sendPushNotification(order.userId, title, message);
      } catch (e) { console.error('mark-paid notify failed:', e.message); }
    }

    res.json({ success: true, order });
  } catch (err) {
    console.error("mark-paid error:", err);
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
      // Confirmation push to the shop too, so multi-device shops see the
      // cancellation reflected even on the device that didn't trigger it.
      shopTitle: 'Order Cancelled by You ❌',
      shopMsg:   `Order #${shortId} has been cancelled. The customer was notified and the refund is being processed.`,
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
      // Confirmation push so the customer has a receipt in their notification
      // history and any other device they're logged in on reflects the cancel.
      customerTitle: 'Order Cancelled ❌',
      customerMsg:   `Your order #${shortId} has been cancelled. Any coins or payment will be refunded shortly.`,
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
// requireUser + ownership check. Old behaviour let anyone forge reviews for
// any order, mark anyone's order isReviewed, and sink any shop's rating to 1
// by spamming the endpoint. userId is now taken from the session, not the body.
app.post("/reviews/order-review", requireUser, async (req, res) => {
  try {
    const { orderId, shop, items } = req.body || {};
    if (!orderId || !mongoose.Types.ObjectId.isValid(orderId)) {
      return res.status(400).json({ error: "Valid orderId required" });
    }

    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (order.userId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: "Not your order" });
    }
    if (order.isReviewed) return res.status(409).json({ error: "Order already reviewed" });

    const userId = req.user._id;
    const userName = req.user.name || 'Customer';
    const reviewsToInsert = [];

    // Resolve the target shopId once, falling back to the order's own shopId
    // when the client forgot to send it. Used to silently drop the rating if
    // shop.shopId was missing, so older orders' reviews never counted toward
    // the shop's average.
    const resolvedShopId = (shop && shop.shopId && mongoose.Types.ObjectId.isValid(shop.shopId))
      ? shop.shopId
      : (order.shopId ? order.shopId.toString() : null);

    if (shop && shop.rating > 0 && resolvedShopId) {
      reviewsToInsert.push({ userId, userName, orderId, targetId: resolvedShopId, targetType: 'shop', rating: Math.max(1, Math.min(5, Number(shop.rating))), comment: String(shop.reviewText || '').slice(0, 1000) });
    }

    if (Array.isArray(items)) {
      items.forEach(item => {
        if (item.rating > 0 && item.productId && mongoose.Types.ObjectId.isValid(item.productId)) {
          reviewsToInsert.push({ userId, userName, orderId, targetId: item.productId, targetType: 'product', rating: Math.max(1, Math.min(5, Number(item.rating))), comment: '' });
        }
      });
    }

    if (reviewsToInsert.length > 0) {
      await Review.insertMany(reviewsToInsert);
    }

    if (shop && shop.rating > 0 && resolvedShopId) {
      await recomputeShopRating(resolvedShopId);
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

// Recompute and persist the aggregate rating + total review count for a shop.
// Used after PATCH/DELETE so the shop's headline rating stays accurate.
async function recomputeShopRating(shopId) {
  if (!shopId || !mongoose.isValidObjectId(shopId)) return;
  const [agg] = await Review.aggregate([
    { $match: { targetId: new mongoose.Types.ObjectId(shopId), targetType: 'shop' } },
    { $group: { _id: null, avg: { $avg: '$rating' }, count: { $sum: 1 } } },
  ]);
  await Shop.findByIdAndUpdate(shopId, {
    rating: agg ? Number(agg.avg.toFixed(1)) : 5.0,
    totalReviews: agg ? agg.count : 0,
  });
}

// PATCH /reviews/:id — owner-only edit of rating + comment.
app.patch("/reviews/:id", requireUser, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "Invalid review id" });
    const review = await Review.findById(req.params.id);
    if (!review) return res.status(404).json({ error: "Review not found" });
    if (review.userId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: "Not your review" });
    }
    const next = {};
    if (req.body?.rating !== undefined) {
      const r = Math.max(1, Math.min(5, Number(req.body.rating)));
      if (!Number.isFinite(r)) return res.status(400).json({ error: "Rating must be 1–5." });
      next.rating = r;
    }
    if (typeof req.body?.comment === 'string') {
      next.comment = req.body.comment.slice(0, 1000);
    }
    if (Object.keys(next).length === 0) return res.status(400).json({ error: "Nothing to update." });
    Object.assign(review, next);
    await review.save();

    if (review.targetType === 'shop' && 'rating' in next) {
      await recomputeShopRating(review.targetId);
    }
    res.json(review);
  } catch (err) {
    console.error('review update error:', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /reviews/:id — owner-only. If the order had only one review and it's
// deleted, the order is allowed to be reviewed again (isReviewed=false), so a
// user who deleted a wrong review can submit a fresh one.
app.delete("/reviews/:id", requireUser, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "Invalid review id" });
    const review = await Review.findById(req.params.id);
    if (!review) return res.status(404).json({ error: "Review not found" });
    if (review.userId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: "Not your review" });
    }
    const { targetType, targetId, orderId } = review;
    await Review.deleteOne({ _id: review._id });

    if (targetType === 'shop') await recomputeShopRating(targetId);

    // If no reviews remain on this order, let the user re-submit one.
    const remaining = await Review.countDocuments({ orderId });
    if (remaining === 0 && orderId) {
      await Order.updateOne({ _id: orderId }, { $set: { isReviewed: false } });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('review delete error:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- 📣 COMPLAINT ROUTES ---
// Customer files a complaint. Notifies the admin in-app, and pings the shop
// when the complaint is targeted at one. Bearer-token gated — userId / userName
// / userPhone come from the session so the caller can't impersonate someone.
// Rate-limited: 5 complaints per 10 min/IP to stop spam against a shop.
app.post("/complaints", rateLimit('complaints', 5, 10 * 60 * 1000), requireUser, async (req, res) => {
  try {
    const { targetType, message } = req.body || {};
    if (!targetType || !message || !message.trim()) {
      return res.status(400).json({ error: "targetType and message are required." });
    }

    const shopId = req.body.shopId && mongoose.isValidObjectId(req.body.shopId) ? req.body.shopId : null;
    const complaint = new Complaint({
      userId: req.user._id,
      userName: req.user.name || 'Customer',
      userPhone: req.user.phone || '',
      targetType,
      shopId,
      itemName: (req.body.itemName || '').toString().slice(0, 200),
      message: message.trim().slice(0, 2000),
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
app.get("/complaints", requireAdmin, async (req, res) => {
  try {
    const list = await Complaint.find()
      .populate('shopId', 'name phone')
      .sort({ createdAt: -1 })
      .limit(500);
    res.json(list);
  } catch (err) { res.status(500).json({ error: "Failed to fetch complaints" }); }
});

// Shop view — only complaints filed against this shop. Bearer-token gated.
app.get("/complaints/shop/:shopId", requireShop, async (req, res) => {
  try {
    if (req.shop._id.toString() !== req.params.shopId) {
      return res.status(403).json({ error: "Not your shop" });
    }
    const list = await Complaint.find({ shopId: req.params.shopId })
      .sort({ createdAt: -1 });
    res.json(list);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// User view — every complaint a given customer filed, newest first. Used by
// the "My Complaints" screen so the user can read replies. Bearer-token gated.
app.get("/complaints/user/:userId", requireUser, async (req, res) => {
  try {
    if (req.user._id.toString() !== req.params.userId) {
      return res.status(403).json({ error: "Not your complaints" });
    }
    const list = await Complaint.find({ userId: req.params.userId })
      .populate('shopId', 'name')
      .sort({ createdAt: -1 });
    res.json(list);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Either the admin OR the targeted shop can change status. Used to be unauth'd
// (anyone could mark complaints resolved to bury them).
const requireShopOrAdmin2 = async (req, res, next) => {
  const adminToken = req.headers['x-admin-token'];
  if (adminToken && process.env.ADMIN_TOKEN && adminToken === process.env.ADMIN_TOKEN) {
    req.isAdmin = true;
    return next();
  }
  return requireShop(req, res, next);
};

// Status updates: open ↔ reviewed ↔ resolved.
app.patch("/complaints/:id", requireShopOrAdmin2, async (req, res) => {
  try {
    const { status } = req.body || {};
    if (!['open', 'reviewed', 'resolved'].includes(status)) {
      return res.status(400).json({ error: "Invalid status." });
    }
    const complaint = await Complaint.findById(req.params.id);
    if (!complaint) return res.status(404).json({ error: "Complaint not found." });
    // Shop can only mutate complaints filed against itself.
    if (!req.isAdmin) {
      const complaintShopId = complaint.shopId ? complaint.shopId.toString() : '';
      if (complaintShopId !== req.shop._id.toString()) {
        return res.status(403).json({ error: "Not your complaint" });
      }
    }
    complaint.status = status;
    await complaint.save();
    res.json(complaint);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Shop or admin posts a reply onto a complaint. The original customer is
// notified in-app + via OneSignal so they know to come back and read it.
// Bearer-token / admin-token gated; authorType is derived from the credential,
// not the body, so a logged-in shop can't pose as "admin" or vice versa.
app.post("/complaints/:id/replies", requireShopOrAdmin2, async (req, res) => {
  try {
    const { message } = req.body || {};
    if (!message || !message.trim()) {
      return res.status(400).json({ error: "Reply message is required." });
    }

    const complaint = await Complaint.findById(req.params.id);
    if (!complaint) return res.status(404).json({ error: "Complaint not found." });

    let authorType, authorName;
    if (req.isAdmin) {
      authorType = 'admin';
      authorName = (req.body.authorName || 'PackItOut Support').toString().slice(0, 120);
    } else {
      // Shop reply — must own the complaint.
      const complaintShopId = complaint.shopId ? complaint.shopId.toString() : '';
      if (complaintShopId !== req.shop._id.toString()) {
        return res.status(403).json({ error: "Not your complaint" });
      }
      authorType = 'shop';
      authorName = (req.shop.name || 'Shop').toString().slice(0, 120);
    }

    complaint.replies.push({
      authorType,
      authorName,
      message: message.trim().slice(0, 2000),
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
    const incomingPurpose = String(req.body.purpose || 'register');
    const purpose = (incomingPurpose === 'login' || incomingPurpose === 'reset') ? incomingPurpose : 'register';

    if (!validatePhone(phone)) {
      return res.status(400).json({ error: "Enter a valid 10-digit Indian mobile number." });
    }
    if (!checkOtpRateLimit(phone)) {
      return res.status(429).json({ error: "Too many OTP requests. Try again in 15 minutes." });
    }

    // Registration: phone must NOT already exist. Reset: phone MUST already
    // exist (otherwise someone could probe whether a number is registered).
    if (purpose === 'register') {
      const existing = await User.findOne({ phone }).select('_id').lean();
      if (existing) return res.status(409).json({ error: "Phone already registered. Please log in." });
    } else if (purpose === 'reset') {
      const existing = await User.findOne({ phone }).select('_id').lean();
      if (!existing) return res.status(404).json({ error: "No account found with that number." });
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
    const incomingPurpose = String(req.body.purpose || 'register');
    const purpose = (incomingPurpose === 'login' || incomingPurpose === 'reset') ? incomingPurpose : 'register';

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

// Reset password using a verified OTP token. Mirrors /register's token check:
// only a verified, unconsumed 'reset' OtpRequest tied to the same phone is
// accepted, and the token is burned on success so it can't reset twice.
app.post("/auth/reset-password", async (req, res) => {
  try {
    const { phone, newPassword, verificationToken } = req.body || {};
    const phoneStr = String(phone || "").trim();

    if (!validatePhone(phoneStr)) return res.status(400).json({ error: "Enter a valid 10-digit Indian mobile number." });
    if (!validatePassword(newPassword)) return res.status(400).json({ error: "Password must be at least 6 characters." });
    if (!verificationToken) return res.status(400).json({ error: "Please verify your phone number first." });
    if (!mongoose.Types.ObjectId.isValid(verificationToken)) {
      return res.status(400).json({ error: "Invalid verification token." });
    }

    const otpRecord = await OtpRequest.findById(verificationToken);
    if (!otpRecord || otpRecord.phone !== phoneStr || otpRecord.purpose !== 'reset' || !otpRecord.verified || otpRecord.consumed || otpRecord.expiresAt < new Date()) {
      return res.status(400).json({ error: "Phone verification expired or invalid. Please request a new OTP." });
    }

    // select:+password so we can write the new hash to the doc and save.
    const user = await User.findOne({ phone: phoneStr }).select('+password').populate('primaryShop');
    if (!user) return res.status(404).json({ error: "No account found with that number." });

    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();

    otpRecord.consumed = true;
    await otpRecord.save();

    // Auto-login on reset — same shape as /login and /register so the frontend
    // can drop straight into the app.
    const sessionToken = await issueSessionToken(User, user._id);
    const safe = user.toObject();
    delete safe.password;
    delete safe.sessionTokens;
    res.json({ ...safe, sessionToken });
  } catch (err) {
    console.error("reset-password error:", err);
    res.status(500).json({ error: "Could not reset password. Please try again." });
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
      // Atomic $inc instead of read-modify-write — two concurrent registrations
      // with the same code used to award the referrer only once across both.
      const result = await User.updateOne(
        { referralCode: referredBy },
        { $inc: { coins: 50 } }
      );
      if (result.matchedCount === 1) startingCoins = 50;
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

    // password is schema-level select:false (so it doesn't leak via GET /users)
    // — must opt in explicitly here or bcrypt.compare sees undefined and every
    // login fails as "Invalid phone or password" even for correct credentials.
    const user = await User.findOne({ phone }).select('+password').populate('primaryShop');
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

// ==========================================
// 🔥 OAUTH LOGIN — single entry point for Google + email/password (Firebase)
// ==========================================
// Frontend calls this with a Firebase ID token from one of:
//   - signInWithPopup(googleProvider)           → sign_in_provider="google.com"
//   - signInWithEmailAndPassword                → sign_in_provider="password"
//   - createUserWithEmailAndPassword (verified) → sign_in_provider="password"
// We verify the token, find-or-create a User row keyed by firebaseUid (with
// email as a secondary lookup so a user who later changes their email still
// resolves to the same account), and issue a session token.
app.post("/auth/oauth-login", async (req, res) => {
  try {
    const decoded = await verifyFirebaseIdToken(req.body?.idToken);

    const provider = decoded.firebase?.sign_in_provider || "unknown";
    const email = decoded.email ? String(decoded.email).toLowerCase().trim() : null;
    const emailVerified = !!decoded.email_verified;
    const displayName = decoded.name || (email ? email.split("@")[0] : "User");
    const uid = decoded.uid;

    // Reject unverified email/password — they shouldn't be able to log in
    // until they click the verification link.
    if (provider === "password" && !emailVerified) {
      return res.status(403).json({ error: "Please verify your email first. Check your inbox for the link." });
    }
    if (!email && provider !== "phone") {
      return res.status(400).json({ error: "No email associated with this sign-in method." });
    }

    // Find by firebaseUid first (the canonical key). Fall back to email so an
    // existing email/password account auto-resolves when the same user later
    // signs in with Google — Firebase considers them the same identity under
    // "one account per email", so they share a uid; but if email-enumeration
    // protection caused Firebase to issue a separate uid, the email match
    // catches it and we merge by setting firebaseUid below.
    let user = await User.findOne({ firebaseUid: uid });
    if (!user && email) user = await User.findOne({ email });

    if (!user) {
      // New signup. Build a referral code from the display name (matches the
      // pattern /register uses for legacy users).
      const baseName = (displayName || "USER").substring(0, 4).toUpperCase().replace(/\s/g, '') || "PACK";
      const refCode = baseName + Math.floor(1000 + Math.random() * 9000);
      user = new User({
        name: displayName,
        email,
        firebaseUid: uid,
        authProviders: [provider],
        referralCode: refCode,
      });
      await user.save();
    } else {
      // Returning user — backfill any missing identity fields and the new
      // provider. updateOne so we don't trip validators on legacy docs.
      const toSet = {};
      if (!user.firebaseUid) toSet.firebaseUid = uid;
      if (!user.email && email) toSet.email = email;
      const providers = new Set(user.authProviders || []);
      providers.add(provider);
      const newProviders = [...providers];
      if (newProviders.length !== (user.authProviders || []).length) toSet.authProviders = newProviders;
      if (Object.keys(toSet).length) {
        await User.updateOne({ _id: user._id }, { $set: toSet });
        Object.assign(user, toSet);
      }
    }

    // Populate primaryShop the same way /login does so the frontend renders
    // the shop badge correctly on first paint.
    await user.populate('primaryShop');

    const sessionToken = await issueSessionToken(User, user._id);
    const safe = user.toObject();
    delete safe.password;
    delete safe.sessionTokens;
    res.json({ ...safe, sessionToken });
  } catch (err) {
    const status = err.statusCode || 500;
    if (status === 500) console.error("oauth-login error:", err);
    res.status(status).json({ error: err.message || "OAuth login failed." });
  }
});

// ==========================================
// 🔁 ADD EMAIL — legacy phone+password user attaches an email
// ==========================================
// Flow (frontend):
//   1. User signs in with phone OTP via Firebase → gets a phone-provider Firebase user
//   2. linkWithCredential(EmailAuthProvider.credential(email, pw)) → attaches email
//   3. sendEmailVerification
//   4. POST here with the freshly-issued idToken + the original phone, so we can
//      attach the firebaseUid + email to the existing User row.
// Verification can wait — the link itself proves ownership of both phone (OTP)
// and (after the user clicks the email link) email. We just record the link.
app.post("/auth/add-email", async (req, res) => {
  try {
    const decoded = await verifyFirebaseIdToken(req.body?.idToken);
    const phoneFromBody = String(req.body?.phone || "").trim();
    const phoneFromToken = decoded.phone_number ? String(decoded.phone_number).replace(/^\+91/, '') : null;
    const email = decoded.email ? String(decoded.email).toLowerCase().trim() : null;

    if (!email) return res.status(400).json({ error: "Token has no email. Did the link step run?" });
    if (!phoneFromBody && !phoneFromToken) return res.status(400).json({ error: "No phone to attach this email to." });

    // Trust the phone embedded in the Firebase token over the request body.
    const phone = phoneFromToken || phoneFromBody;

    const user = await User.findOne({ phone });
    if (!user) return res.status(404).json({ error: "No account found for that phone." });

    // Guard against attaching an email already used by another account.
    const emailOwner = await User.findOne({ email });
    if (emailOwner && String(emailOwner._id) !== String(user._id)) {
      return res.status(409).json({ error: "This email is already linked to a different account." });
    }

    const providers = new Set(user.authProviders || []);
    providers.add("password");
    providers.add("phone");
    await User.updateOne({ _id: user._id }, {
      $set: {
        email,
        firebaseUid: decoded.uid,
        authProviders: [...providers],
      },
    });

    res.json({ ok: true });
  } catch (err) {
    const status = err.statusCode || 500;
    if (status === 500) console.error("add-email error:", err);
    res.status(status).json({ error: err.message || "Could not link email." });
  }
});

// ==========================================
// 📞 ADD PHONE — email/Google user adds phone at checkout
// ==========================================
// Frontend collects + verifies phone via Firebase phone OTP, then POSTs here
// with the idToken (which now has phone_number after linkWithCredential).
// Session bearer proves who's adding the phone; Firebase token proves the
// phone is real.
app.post("/users/:id/phone", requireUser, async (req, res) => {
  try {
    if (String(req.user._id) !== String(req.params.id)) {
      return res.status(403).json({ error: "Cannot set phone for another user." });
    }
    const decoded = await verifyFirebaseIdToken(req.body?.idToken);
    const phoneFromToken = decoded.phone_number ? String(decoded.phone_number).replace(/^\+91/, '') : null;
    if (!phoneFromToken) return res.status(400).json({ error: "Token has no phone_number. Did the OTP step run?" });
    if (!/^[6-9]\d{9}$/.test(phoneFromToken)) return res.status(400).json({ error: "Phone is not a valid Indian mobile." });

    const owner = await User.findOne({ phone: phoneFromToken });
    if (owner && String(owner._id) !== String(req.user._id)) {
      return res.status(409).json({ error: "This phone is already linked to a different account." });
    }

    const providers = new Set(req.user.authProviders || []);
    providers.add("phone");
    await User.updateOne({ _id: req.user._id }, {
      $set: { phone: phoneFromToken, authProviders: [...providers] },
    });

    res.json({ phone: phoneFromToken });
  } catch (err) {
    const status = err.statusCode || 500;
    if (status === 500) console.error("add-phone error:", err);
    res.status(status).json({ error: err.message || "Could not save phone." });
  }
});

// Admin-only directory, capped at 500 rows. password/sessionTokens are
// schema-level select:false so they never leak.
app.get("/users", requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 200));
    const users = await User.find().sort({ createdAt: -1 }).limit(limit);
    res.json(users);
  } catch (err) { res.status(500).json({ error: "Failed to fetch users" }); }
});
// Bearer-token gated — :id must match the session. Previously unauth'd,
// which let any visitor read another user's phone, pincode, address, coin
// balance, and primaryShop. Admin path goes through /admin/users/:id/profile.
app.get("/users/:id", requireUser, async (req, res) => {
  try {
    if (req.user._id.toString() !== req.params.id) {
      return res.status(403).json({ error: "Not your profile" });
    }
    res.json(await User.findById(req.params.id).populate('primaryShop'));
  } catch (err) { res.status(500).json({ error: err.message }); }
});
// Field whitelist — anything not in this list is dropped before the update.
// Closes the mass-assignment hole where a client could PATCH /users/:id with
// { coins: 999999 } or push a forged sessionTokens entry to hijack the account.
const USER_WRITABLE = ['name', 'pincode', 'address', 'primaryShop'];
app.patch("/users/:id", requireUser, async (req, res) => {
  try {
    if (req.user._id.toString() !== req.params.id) {
      return res.status(403).json({ error: "Cannot modify another user's profile" });
    }
    const updateData = pickFields(req.body || {}, USER_WRITABLE);
    if (updateData.primaryShop === "") updateData.primaryShop = null;
    if (updateData.pincode && !validatePincode(updateData.pincode)) {
      return res.status(400).json({ error: "Pincode must be exactly 6 digits." });
    }
    res.json(await User.findByIdAndUpdate(req.params.id, updateData, { new: true }).populate('primaryShop'));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==========================================
// 📍 USER ADDRESS BOOK ROUTES
// ==========================================
// Multi-address CRUD. Each user has User.addresses[] — Home, Work, etc.
// At most one is isDefault:true; the helper below clears the previous default
// on each set-default so the constraint can't drift. All routes are bearer-
// token gated and confined to the requesting user's own document.
const ADDRESS_WRITABLE = ['label', 'line1', 'line2', 'landmark', 'pincode'];
const sanitizeAddressBody = (src = {}) => {
  const out = {};
  for (const k of ADDRESS_WRITABLE) {
    if (src[k] !== undefined) out[k] = String(src[k] || '').slice(0, 200);
  }
  return out;
};

app.get("/users/:id/addresses", requireUser, async (req, res) => {
  try {
    if (req.user._id.toString() !== req.params.id) {
      return res.status(403).json({ error: "Not your addresses" });
    }
    const u = await User.findById(req.params.id).select('addresses').lean();
    res.json(u?.addresses || []);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/users/:id/addresses", requireUser, async (req, res) => {
  try {
    if (req.user._id.toString() !== req.params.id) {
      return res.status(403).json({ error: "Not your addresses" });
    }
    const body = sanitizeAddressBody(req.body);
    if (!body.line1 || !body.line1.trim()) {
      return res.status(400).json({ error: "Address line 1 is required." });
    }
    if (body.pincode && !validatePincode(body.pincode)) {
      return res.status(400).json({ error: "Pincode must be exactly 6 digits." });
    }
    const wantDefault = !!req.body?.isDefault;
    const user = await User.findById(req.params.id).select('addresses');
    if (!user) return res.status(404).json({ error: "User not found" });
    // If the user has no addresses yet, the first one is the default regardless.
    const isFirst = (user.addresses || []).length === 0;
    const isDefault = wantDefault || isFirst;
    if (isDefault) {
      // Clear any previous default before pushing the new one.
      user.addresses.forEach(a => { a.isDefault = false; });
    }
    user.addresses.push({ ...body, isDefault });
    await user.save();
    res.status(201).json(user.addresses);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch("/users/:id/addresses/:addrId", requireUser, async (req, res) => {
  try {
    if (req.user._id.toString() !== req.params.id) {
      return res.status(403).json({ error: "Not your addresses" });
    }
    const user = await User.findById(req.params.id).select('addresses');
    if (!user) return res.status(404).json({ error: "User not found" });
    const addr = user.addresses.id(req.params.addrId);
    if (!addr) return res.status(404).json({ error: "Address not found" });

    const body = sanitizeAddressBody(req.body);
    if (body.pincode && !validatePincode(body.pincode)) {
      return res.status(400).json({ error: "Pincode must be exactly 6 digits." });
    }
    Object.assign(addr, body);
    if (req.body?.isDefault === true) {
      user.addresses.forEach(a => { a.isDefault = a._id.toString() === addr._id.toString(); });
    }
    await user.save();
    res.json(user.addresses);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete("/users/:id/addresses/:addrId", requireUser, async (req, res) => {
  try {
    if (req.user._id.toString() !== req.params.id) {
      return res.status(403).json({ error: "Not your addresses" });
    }
    const user = await User.findById(req.params.id).select('addresses');
    if (!user) return res.status(404).json({ error: "User not found" });
    const addr = user.addresses.id(req.params.addrId);
    if (!addr) return res.status(404).json({ error: "Address not found" });
    const wasDefault = !!addr.isDefault;
    addr.deleteOne();
    // If we removed the default, promote whichever address is now first so the
    // user always has exactly one default (when they have any addresses).
    if (wasDefault && user.addresses.length > 0) {
      user.addresses[0].isDefault = true;
    }
    await user.save();
    res.json(user.addresses);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- SHOP ROUTES ---
// 🛡️ Admin-only firehose with every field except password/sessionTokens.
// Used by the admin Shops tab. Previously this was public and dumped phone,
// fssai, gst, panNumber and upiId for every shop on the platform to any
// unauthenticated visitor — a PII / financial-id leak.
app.get("/shops", requireAdmin, async (req, res) => {
  try {
    res.json(await Shop.find().sort({ name: 1 }).limit(500));
  } catch (err) { res.status(500).json({ error: "Failed to fetch shops" }); }
});
// Public, slim variant for the customer storefront. Returns ONLY the fields a
// customer screen actually needs: name, image, hours, rating, pincode, open
// status. No phone / fssai / gst / pan / upiId leakage. The Nearby page and
// any other unauthenticated discovery view should use this.
app.get("/shops/public", async (req, res) => {
  try {
    const shops = await Shop.find({}, {
      name: 1, shopImage: 1, operatingHours: 1, fullAddress: 1, pincode: 1,
      serviceablePincodes: 1, isOpen: 1, isAcceptingOrders: 1,
      rating: 1, totalReviews: 1, totalOrdersFulfilled: 1, location: 1,
    }).sort({ name: 1 }).limit(500);
    res.json(shops);
  } catch (err) { res.status(500).json({ error: "Failed to fetch shops" }); }
});
// Admin-only shop creation. Previously unauth'd — anyone could create a shop
// with any phone (provided it didn't collide) and a known password. Password
// is bcrypt-hashed before save (validatePassword enforces ≥6 chars).
app.post("/shops", requireAdmin, async (req, res) => {
  try {
    const body = { ...(req.body || {}) };
    const pw = body.password;
    if (!validatePassword(pw)) {
      return res.status(400).json({ error: "Password must be at least 6 characters." });
    }
    body.password = await bcrypt.hash(String(pw), 10);
    const newShop = new Shop(body);
    await newShop.save();
    const safe = newShop.toObject();
    delete safe.password;
    delete safe.sessionTokens;
    res.json(safe);
  } catch (err) {
    if (err && err.code === 11000) return res.status(409).json({ error: "A shop with that phone already exists." });
    res.status(500).json({ error: "Failed to create shop" });
  }
});
// Shop login with bcrypt + lazy migration. Legacy plaintext rows still in the
// DB are detected via looksHashed(); on a successful plaintext match we
// re-hash and persist before issuing the token, so within one login per shop
// the entire collection migrates to bcrypt without admin intervention.
app.post("/shop-login", async (req, res) => {
  try {
    const phone = String(req.body?.phone || '').trim();
    const password = String(req.body?.password || '');
    // password is select:false, so must opt in explicitly to compare.
    const shop = await Shop.findOne({ phone }).select('+password').populate('inventory.product');
    if (!shop) return res.status(401).json({ error: "Invalid" });

    let ok = false;
    if (looksHashed(shop.password)) {
      ok = await bcrypt.compare(password, shop.password);
    } else {
      ok = shop.password === password;
      // Lazy upgrade: hash + persist so the next login goes through bcrypt.
      if (ok) {
        try {
          const newHash = await bcrypt.hash(password, 10);
          await Shop.updateOne({ _id: shop._id }, { $set: { password: newHash } });
        } catch (e) { console.error('shop password rehash failed:', e.message); }
      }
    }
    if (!ok) return res.status(401).json({ error: "Invalid" });

    // Issue a fresh session token — front-end stores it and sends in
    // Authorization: Bearer for every order-mutating request.
    const sessionToken = await issueSessionToken(Shop, shop._id);

    const safe = shop.toObject();
    delete safe.password;
    delete safe.sessionTokens;
    res.json({ ...safe, sessionToken });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
// Haversine distance in kilometres between two [lng, lat] pairs.
const haversineKm = (lng1, lat1, lng2, lat2) => {
  const R = 6371; // earth radius, km
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
};

app.get("/shops/all/:pincode", async (req, res) => {
  try {
    const shops = await Shop.find({ pincode: req.params.pincode }).lean();

    // Optional ?lat=&lng= from the customer. When present we attach a
    // distanceKm field and sort closest-first; shops without a stored
    // location fall to the bottom unchanged.
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    const hasCustomerLoc = Number.isFinite(lat) && Number.isFinite(lng)
      && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

    if (hasCustomerLoc) {
      for (const s of shops) {
        const coords = s.location && Array.isArray(s.location.coordinates) ? s.location.coordinates : null;
        if (coords && coords.length === 2 && Number.isFinite(coords[0]) && Number.isFinite(coords[1])) {
          s.distanceKm = Number(haversineKm(lng, lat, coords[0], coords[1]).toFixed(2));
        }
      }
      shops.sort((a, b) => {
        const da = typeof a.distanceKm === 'number' ? a.distanceKm : Infinity;
        const db = typeof b.distanceKm === 'number' ? b.distanceKm : Infinity;
        return da - db;
      });
    }

    res.json(shops);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Shop sets / updates its pickup location. Bearer-token gated — only the shop
// itself (logged in on some device) can move its own pin.
app.patch("/shops/:id/location", requireShop, async (req, res) => {
  try {
    if (req.shop._id.toString() !== req.params.id) {
      return res.status(403).json({ error: "Cannot modify another shop's location" });
    }
    const lat = Number(req.body.lat);
    const lng = Number(req.body.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      return res.status(400).json({ error: "Invalid lat/lng" });
    }
    const updated = await Shop.findByIdAndUpdate(
      req.params.id,
      { location: { type: 'Point', coordinates: [lng, lat] } },
      { new: true }
    );
    res.json(updated);
  } catch (err) { res.status(500).json({ error: err.message }); }
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
app.post("/shops/:shopId/inventory", requireShop, async (req, res) => {
  try {
    if (req.shop._id.toString() !== req.params.shopId) {
      return res.status(403).json({ error: "Cannot edit another shop's inventory" });
    }
    const { productId, sellingPrice, inStock } = req.body;
    if (!productId || !mongoose.isValidObjectId(productId)) {
      return res.status(400).json({ error: "Valid productId required." });
    }
    // sellingPrice: must be a finite, non-negative number. The old route would
    // happily accept negatives or NaN, which let a shop list items at -₹5 and
    // break every downstream cart-total calculation.
    let priceVal;
    if (sellingPrice !== undefined) {
      priceVal = Number(sellingPrice);
      if (!Number.isFinite(priceVal) || priceVal < 0) {
        return res.status(400).json({ error: "sellingPrice must be a non-negative number." });
      }
    }
    const shop = await Shop.findById(req.params.shopId);
    const existingIndex = shop.inventory.findIndex(item => item.product && item.product.toString() === productId);
    if (existingIndex > -1) {
      const updateData = {};
      if (priceVal !== undefined) updateData[`inventory.${existingIndex}.sellingPrice`] = priceVal;
      if (inStock !== undefined) updateData[`inventory.${existingIndex}.inStock`] = Boolean(inStock);
      await Shop.updateOne({ _id: req.params.shopId }, { $set: updateData });
    } else {
      if (priceVal === undefined) {
        return res.status(400).json({ error: "sellingPrice required when adding a new inventory item." });
      }
      await Shop.updateOne({ _id: req.params.shopId }, { $push: { inventory: { product: productId, sellingPrice: priceVal, inStock: true } } });
    }
    res.json(await Shop.findById(req.params.shopId).populate('inventory.product'));
  } catch (err) { res.status(500).json({ error: err.message }); }
});
// Admin can edit a broader set of fields than the shop itself can — e.g.
// rotating a password or correcting the shop's phone number. Password resets
// are bcrypt-hashed inline so admin-set passwords land in the same shape as
// shop-set ones.
const SHOP_ADMIN_WRITABLE = [
  'name', 'ownerName', 'fullAddress', 'operatingHours', 'shopImage', 'phone',
  'password', 'pincode', 'serviceablePincodes', 'isOpen', 'isAcceptingOrders',
  'fssai', 'gst', 'panNumber', 'upiId', 'inventoryMode',
];
app.patch("/shops/:id/admin-edit", requireAdmin, async (req, res) => {
  try {
    const updateData = pickFields(req.body || {}, SHOP_ADMIN_WRITABLE);
    if (updateData.password !== undefined) {
      if (!validatePassword(updateData.password)) {
        return res.status(400).json({ error: "Password must be at least 6 characters." });
      }
      updateData.password = await bcrypt.hash(String(updateData.password), 10);
    }
    const updatedShop = await Shop.findByIdAndUpdate(req.params.id, updateData, { new: true });
    res.json(updatedShop);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Upload / replace shop photo. Cloudinary holds the file; the Shop doc stores the URL.
app.post("/shops/:id/upload-image", requireShop, upload.single('shopImage'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No image." });
  try {
    if (req.shop._id.toString() !== req.params.id) {
      return res.status(403).json({ error: "Cannot upload to another shop" });
    }
    const shop = await Shop.findById(req.params.id);
    if (!shop) return res.status(404).json({ error: "Shop not found." });
    const result = await cloudinary.uploader.upload(req.file.path, {
      folder: 'packitout_shops',
      transformation: [{ width: 1200, height: 1200, crop: 'limit', quality: 'auto:good' }],
    });
    shop.shopImage = result.secure_url;
    await shop.save();
    const populated = await Shop.findById(shop._id).populate('inventory.product');
    res.json(populated);
  } catch (err) {
    console.error("Shop image upload failed:", err);
    res.status(500).json({ error: "Upload failed." });
  } finally {
    safeUnlink(req.file?.path);
  }
});

// Shop edits its own profile. Narrower whitelist than admin-edit — phone,
// password, serviceablePincodes etc. need admin intervention.
const SHOP_SELF_WRITABLE = [
  'name', 'ownerName', 'fullAddress', 'operatingHours', 'shopImage',
  'isOpen', 'isAcceptingOrders', 'fssai', 'gst', 'panNumber', 'upiId',
  'inventoryMode',
];
app.patch("/shops/:id", requireShop, async (req, res) => {
  try {
    if (req.shop._id.toString() !== req.params.id) {
      return res.status(403).json({ error: "Cannot modify another shop's profile" });
    }
    const updateData = pickFields(req.body || {}, SHOP_SELF_WRITABLE);
    res.json(await Shop.findByIdAndUpdate(req.params.id, updateData, { new: true }).populate('inventory.product'));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- MASTER PRODUCTS ---

// Whitelist of fields the admin can write into a MasterProduct. Anything else
// in the body is ignored — prevents callers from sneaking in fields not in the
// schema or overwriting computed/ref-only fields.
const MASTER_PRODUCT_WRITABLE = [
  'name', 'brand', 'category', 'mrp', 'qnty', 'emoji', 'image', 'searchTags',
  'description', 'ingredients', 'manufacturer', 'manufactureraddress',
  'energy', 'protein', 'carbs', 'sugar', 'fat', 'isVeg', 'itemGroupId',
  'relatedProducts', 'substitutes',
];
// pickFields / normaliseSearchTags are hoisted near the top of the file so
// they're available for POST /orders, which runs before this section.

app.post("/master-products", requireAdmin, async (req, res) => {
  try {
    const body = pickFields(req.body || {}, MASTER_PRODUCT_WRITABLE);
    if (body.mrp !== undefined) body.mrp = Number(body.mrp);
    const tags = normaliseSearchTags(req.body?.searchTags);
    if (tags !== undefined) body.searchTags = tags;
    const p = new MasterProduct(body);
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
// Note: Placed above /:id to ensure Express routes it correctly. Now admin-
// gated AND requires an explicit confirm body so a stray DELETE can't wipe
// the catalog. To purge: send { "confirm": "PURGE-ALL-PRODUCTS" } in the body.
app.delete("/master-products/purge-all", requireAdmin, async (req, res) => {
  try {
    if (req.body?.confirm !== 'PURGE-ALL-PRODUCTS') {
      return res.status(400).json({ error: 'Missing confirmation. Pass {"confirm":"PURGE-ALL-PRODUCTS"}' });
    }
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
app.delete("/master-products/:id", requireAdmin, async (req, res) => {
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

app.patch("/master-products/:id", requireAdmin, async (req, res) => {
  try {
    const updateData = pickFields(req.body || {}, MASTER_PRODUCT_WRITABLE);
    if (updateData.mrp !== undefined) updateData.mrp = Number(updateData.mrp);
    const tags = normaliseSearchTags(req.body?.searchTags);
    if (tags !== undefined) updateData.searchTags = tags;
    const updatedProduct = await MasterProduct.findByIdAndUpdate(req.params.id, updateData, { new: true });
    res.json(updatedProduct);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 🌟 UPDATED BULK UPLOAD WITH QC GATEKEEPER 🌟
app.post("/master-products/bulk-upload", requireAdmin, memoryUpload.single('file'), async (req, res) => {
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
// Now gated by either the shop's own bearer token (the shop is editing its own
// inventory from the dashboard) OR the admin X-Admin-Token (admin one-click
// stocking). Previously anonymous — any visitor could replace any shop's
// inventory at any discount.
const requireShopOrAdmin = async (req, res, next) => {
  const adminToken = req.headers['x-admin-token'];
  if (adminToken && process.env.ADMIN_TOKEN && adminToken === process.env.ADMIN_TOKEN) {
    req.isAdmin = true;
    return next();
  }
  return requireShop(req, res, next);
};

app.post("/shops/:shopId/bulk-import", requireShopOrAdmin, async (req, res) => {
  try {
    const { shopId } = req.params;
    // Shop callers can only stock their own store; admin can stock any.
    if (!req.isAdmin && req.shop && req.shop._id.toString() !== shopId) {
      return res.status(403).json({ error: "Cannot bulk-import into another shop" });
    }

    // 🚀 Grab the dynamic discount from the frontend (defaults to 0 if not sent)
    // Clamp 0–95% — keeps a typo (or malicious 99) from torching margins.
    const discountPercent = Math.max(0, Math.min(95, Number(req.body.discountPercent) || 0));

    // 1. Fetch ALL Master Products
    const masterProducts = await MasterProduct.find({});

    if (!masterProducts || masterProducts.length === 0) {
      return res.status(400).json({ error: "Master catalog is empty!" });
    }

    // 2. Format them for your Shop.inventory schema with the dynamic discount
    const newInventoryArray = masterProducts.map(product => {
      const baseMrp = Number(product.mrp) || 0;

      // 🧮 Math: If input is 10%, multiplier becomes 0.90. Round (don't floor)
      // so consistent under-rounding doesn't quietly erode revenue.
      const discountMultiplier = (100 - discountPercent) / 100;
      const discountedPrice = Math.round(baseMrp * discountMultiplier);

      return {
        product: product._id,         // References MasterProduct
        sellingPrice: discountedPrice, // Dynamically discounted price
        stockCount: 100,
        inStock: true
      };
    });

    // 3. Completely replace the shop's existing inventory array. Use the
    // updated doc to detect "no such shop" — silent no-op used to return 200
    // even if the shopId was garbage or pointed at a deleted shop.
    if (!mongoose.isValidObjectId(shopId)) {
      return res.status(400).json({ error: "Invalid shopId" });
    }
    const updated = await Shop.findByIdAndUpdate(
      shopId,
      { $set: { inventory: newInventoryArray } },
      { new: true }
    );
    if (!updated) return res.status(404).json({ error: "Shop not found" });

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
// term and we won't blow up on repeats. Rate-limited to keep a single
// abusive client from spawning thousands of MissedSearch docs per minute.
app.post("/missed-searches", rateLimit('missed-searches', 30, 60 * 1000), async (req, res) => {
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
app.patch("/missed-searches/:id/resolve", requireAdmin, async (req, res) => {
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

app.delete("/missed-searches/:id", requireAdmin, async (req, res) => {
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
app.put("/ranking-config", requireAdmin, async (req, res) => {
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
//   T+15min → auto-cancel, refund coins, flag UPI refund (if paid), notify both
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

  // Atomic claim — only one caller can move the order from "not-closed" to
  // the cancellation status. Two concurrent cancels (admin + worker, e.g.)
  // used to double-refund coins and double-flag UPI refunds.
  const claim = await Order.updateOne(
    {
      _id: order._id,
      status: { $not: /❌|✅/ },
    },
    { $set: { status: statusLabel } }
  );
  if (claim.modifiedCount !== 1) {
    // Someone else already closed it — drop out, leave their work intact.
    return;
  }

  // Refund coins regardless of payment method — they were debited at checkout.
  // Idempotent: claim refund.coinsRefunded atomically before crediting. Two
  // racing cancels (admin + worker, retry, etc.) used to double-refund coins;
  // now the second one sees refund.coinsRefunded=true and skips.
  if (order.coinsUsed > 0 && order.userId && mongoose.Types.ObjectId.isValid(order.userId._id || order.userId)) {
    const userId = order.userId._id || order.userId;
    const refundClaim = await Order.updateOne(
      { _id: order._id, 'refund.coinsRefunded': { $ne: true } },
      { $set: { 'refund.coinsRefunded': true } }
    );
    if (refundClaim.modifiedCount === 1) {
      try { await User.findByIdAndUpdate(userId, { $inc: { coins: order.coinsUsed } }); }
      catch (e) { console.error('[cancel] coin refund failed:', e.message); }
    }
  }

  // Money refund — payment flows directly to the shop's UPI ID so the platform
  // can't push the money back. If the customer had already paid (paymentStatus
  // was Paid), flag refund.pending=true so the shop knows they owe a manual
  // UPI return. POP orders had no money in flight, so no flag is needed.
  const refundSet = {};
  if (order.paymentStatus === 'Paid' && order.paymentMethod === 'UPI') {
    refundSet['refund.pending'] = true;
    refundSet['refund.attemptedAt'] = new Date();
  }

  // statusHistory + refund flag piggyback on the local doc; status is already
  // set via the conditional update above. Use updateOne to avoid the full-doc
  // .save() race that would overwrite a shop-side accept that landed in between.
  await Order.updateOne(
    { _id: order._id },
    {
      $push: { statusHistory: { status: statusLabel, at: new Date() } },
      ...(Object.keys(refundSet).length ? { $set: refundSet } : {}),
    }
  );
  // Keep the in-memory copy in sync for callers that read order.status downstream.
  order.status = statusLabel;

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
          // Claim the tier atomically — only fire if the order is still
          // Pending AND no other worker beat us to this tier. Without this,
          // the previous `.save()` of the whole doc could overwrite a shop's
          // accept that landed in between, un-accepting the order.
          const claim = await Order.updateOne(
            { _id: order._id, status: 'Pending', 'escalation.tier': { $lt: tier.tier } },
            { $set: { escalation: { tier: tier.tier, lastFiredAt: new Date() } } }
          );
          if (claim.modifiedCount !== 1) break;
          await fireEscalationTier(order, tier);
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
