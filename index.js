const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

// ⚠️ FIXED: Lowercase const, added quotation marks, removed <>, and safely encoded the # and @ in your password!
const MONGO_URI = "mongodb+srv://packitout_db:%23Sid07%400712@cluster0.bceowku.mongodb.net/packitout_db?retryWrites=true&w=majority&appName=Cluster0";

mongoose.connect(MONGO_URI)
  .then(() => console.log("✅ SUCCESS: Connected to MongoDB!"))
  .catch((err) => console.log("❌ ERROR:", err));

app.get("/", (req, res) => {
  res.send("📦 PackItOut API is officially live on Hostinger!");
});

// Hostinger uses environment ports
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});
