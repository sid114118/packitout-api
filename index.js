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
const EventEmitter = require('events');
const systemEvents = new EventEmitter();

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
  .then(async () => {
    console.log("✅ DB Connected");
    // 🔧 Sync User indexes — the old schema had phone as plain unique (no sparse),
    // which made two email/Google signups (both with phone: null) collide.
    // syncIndexes drops indexes whose definition changed and recreates them
    // from the current schema (phone is now sparse). Idempotent — safe to run
    // on every boot. Wrapped in try/catch so a Mongo permission hiccup never
    // takes the whole API down.
    try {
      const result = await mongoose.model("User").syncIndexes();
      if (Array.isArray(result) && result.length) {
        console.log("✅ User indexes synced — dropped stale:", result);
      } else {
        console.log("✅ User indexes already in sync");
      }
    } catch (e) {
      console.error("⚠️ User.syncIndexes failed:", e.message);
    }
  })
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
  .then(async () => {
    console.log("✅ DB Connected");
    // 🔧 Sync User indexes — the old schema had phone as plain unique (no sparse),
    // which made two email/Google signups (both with phone: null) collide.
    // syncIndexes drops indexes whose definition changed and recreates them
    // from the current schema (phone is now sparse). Idempotent — safe to run
    // on every boot. Wrapped in try/catch so a Mongo permission hiccup never
    // takes the whole API down.
    try {
      const result = await mongoose.model("User").syncIndexes();
      if (Array.isArray(result) && result.length) {
        console.log("✅ User indexes synced — dropped stale:", result);
      } else {
        console.log("✅ User indexes already in sync");
      }
    } catch (e) {
      console.error("⚠️ User.syncIndexes failed:", e.message);
    }
  })
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
    type: { type: String, enum: ['Point'] },
    coordinates: { type: [Number], default: undefined },
  },
  fssai: { type: String, default: "" },          
  gst: { type: String, default: "" },            
  panNumber: { type: String, default: "" },      
  upiId: { type: String, default: "" },          
  canCreateCustomProducts: { type: Boolean, default: false },
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

// Automatically push SSE events when a notification is created
notificationSchema.post('save', function(doc) {
  if (doc.shopId) systemEvents.emit('notify_shop', String(doc.shopId), 'new_notification');
  if (doc.userId) systemEvents.emit('notify_user', String(doc.userId), 'new_notification');
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


// ==========================================
// ⚡ SERVER-SENT EVENTS (SSE) FOR SHOPS
// ==========================================
const shopSSEClients = new Map();

// Keep connections alive through proxies (Nginx, Hostinger, Vercel) by sending
// a comment ping every 20 seconds. Without this, idle connections are silently
// dropped by the proxy after 30-60s and the shop stops getting live orders.
setInterval(() => {
  shopSSEClients.forEach(clients => {
    for (const res of clients) {
      res.write(': heartbeat\n\n');
    }
  });
}, 20000);

const notifyShopSSE = (shopId, event) => {
  const clients = shopSSEClients.get(String(shopId));
  if (clients) {
    for (const res of clients) {
      res.write(`event: ${event}\ndata: {}\n\n`);
    }
  }
};
systemEvents.on('notify_shop', notifyShopSSE);

app.get("/shop-events/:shopId", async (req, res) => {
  try {
    const token = req.query.token;
    if (!token) return res.status(401).json({ error: "Missing token" });
    const shop = await Shop.findOne({ "sessionTokens.token": token }).select('+sessionTokens');
    if (!shop || shop._id.toString() !== req.params.shopId) {
      return res.status(403).json({ error: "Invalid session or not your shop" });
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const shopId = req.params.shopId;
    if (!shopSSEClients.has(shopId)) shopSSEClients.set(shopId, new Set());
    shopSSEClients.get(shopId).add(res);

    req.on("close", () => {
      const clients = shopSSEClients.get(shopId);
      if (clients) {
        clients.delete(res);
        if (clients.size === 0) shopSSEClients.delete(shopId);
      }
    });
  } catch (err) {
    res.status(500).end();
  }
});

// ==========================================
// ⚡ SERVER-SENT EVENTS (SSE) FOR USERS
// ==========================================
const userSSEClients = new Map();

setInterval(() => {
  userSSEClients.forEach(clients => {
    for (const res of clients) {
      res.write(': heartbeat\n\n');
    }
  });
}, 20000);

const notifyUserSSE = (userId, event) => {
  const clients = userSSEClients.get(String(userId));
  if (clients) {
    for (const res of clients) {
      res.write(`event: ${event}\ndata: {}\n\n`);
    }
  }
};
systemEvents.on('notify_user', notifyUserSSE);

app.get("/user-events/:userId", async (req, res) => {
  try {
    const token = req.query.token;
    if (!token) return res.status(401).json({ error: "Missing token" });
    const user = await User.findOne({ "sessionTokens.token": token }).select('+sessionTokens');
    if (!user || user._id.toString() !== req.params.userId) {
      return res.status(403).json({ error: "Invalid session or not your account" });
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const userId = req.params.userId;
    if (!userSSEClients.has(userId)) userSSEClients.set(userId, new Set());
    userSSEClients.get(userId).add(res);

    req.on("close", () => {
      const clients = userSSEClients.get(userId);
      if (clients) {
        clients.delete(res);
        if (clients.size === 0) userSSEClients.delete(userId);
      }
    });
  } catch (err) {
    res.status(500).end();
  }
});

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
    notifyShopSSE(shopId, "refresh_parchis");
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
    notifyUserSSE(String(customerId), 'refresh_orders');
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
