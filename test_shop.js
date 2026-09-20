require('dotenv').config();
const mongoose = require('mongoose');

const shopSchema = new mongoose.Schema({ 
  name: String, 
  phone: { type: String, unique: true },
  password: { type: String, required: true, select: false },
  location: {
    type: { type: String, enum: ['Point'], default: 'Point' },
    coordinates: { type: [Number], default: undefined },
  },
});
shopSchema.index({ location: '2dsphere' });
const Shop = mongoose.model("ShopTest", shopSchema);

async function run() {
  const s = new Shop({ name: "Test", phone: "999999999", password: "test" });
  const err = s.validateSync();
  if (err) {
    console.log("Validation Error:", err.message);
  } else {
    console.log("Validation Passed");
  }
}
run();
