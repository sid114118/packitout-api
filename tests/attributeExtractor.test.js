const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  inferProductAttributes,
  extractCategoryFilterPills,
  DEFAULT_SORT_OPTIONS
} = require('../utils/attributeExtractor');

describe('AttributeExtractor Unit Tests', () => {
  describe('inferProductAttributes', () => {
    it('infers Women gender attribute for women-targeted cosmetics/powders', () => {
      const prod = {
        name: 'Enchanteur Romantic Perfumed Talcum Powder for Women',
        category: 'Beauty & Grooming',
        subCategory: 'Deodorants & Fragrances',
        brand: 'Enchanteur',
        qnty: '125 g',
        mrp: 185,
        sellingPrice: 148
      };
      const attrs = inferProductAttributes(prod);
      assert.strictEqual(attrs.gender, 'Women');
      assert.strictEqual(attrs.brand, 'Enchanteur');
      assert.strictEqual(attrs.unitMeasure, '100 g');
      assert.strictEqual(attrs.unitPrice, 118);
    });

    it('infers Men gender attribute for men grooming products', () => {
      const prod = {
        name: 'Wild Stone Hydra Energy Talc for Men',
        category: 'Beauty & Grooming',
        subCategory: 'Deodorants & Fragrances',
        brand: 'Wild Stone',
        qnty: '100 g',
        sellingPrice: 110
      };
      const attrs = inferProductAttributes(prod);
      assert.strictEqual(attrs.gender, 'Men');
      assert.strictEqual(attrs.brand, 'Wild Stone');
    });

    it('infers Baby gender attribute for baby care products', () => {
      const prod = {
        name: 'Himalaya Baby Powder 400 g',
        category: 'Baby Care',
        subCategory: 'Baby Skin & Bath',
        brand: 'Himalaya',
        qnty: '400 g',
        sellingPrice: 215
      };
      const attrs = inferProductAttributes(prod);
      assert.strictEqual(attrs.gender, 'Baby');
      assert.strictEqual(attrs.brand, 'Himalaya');
    });

    it('infers Unisex for general cosmetic/talc without explicit gender', () => {
      const prod = {
        name: 'Cinthol Lime Refreshing Talc',
        category: 'Beauty & Grooming',
        subCategory: 'Deodorants & Fragrances',
        brand: 'Cinthol',
        qnty: '300 g',
        sellingPrice: 160
      };
      const attrs = inferProductAttributes(prod);
      assert.strictEqual(attrs.gender, 'Unisex');
    });

    it('infers Basmati grainType for Basmati rice items', () => {
      const prod = {
        name: 'Amul Organic Basmati Rice 1 kg',
        category: 'Atta & Rice',
        subCategory: 'Basmati Rice',
        brand: 'Amul',
        qnty: '1 kg',
        sellingPrice: 171
      };
      const attrs = inferProductAttributes(prod);
      assert.strictEqual(attrs.grainType, 'Basmati');
      assert.strictEqual(attrs.unitMeasure, 'kg');
      assert.strictEqual(attrs.unitPrice, 171);
      assert.strictEqual(attrs.pricePerUnitRange, '150_plus_kg');
    });

    it('infers Daily Rice grainType for Kolam / Sona Masoori', () => {
      const prod = {
        name: 'Fortune Everyday Sona Masoori Rice 5 kg',
        category: 'Atta & Rice',
        subCategory: 'Rice',
        brand: 'Fortune',
        qnty: '5 kg',
        sellingPrice: 320
      };
      const attrs = inferProductAttributes(prod);
      assert.strictEqual(attrs.grainType, 'Daily Rice');
      assert.strictEqual(attrs.unitMeasure, 'kg');
      assert.strictEqual(attrs.unitPrice, 64);
      assert.strictEqual(attrs.pricePerUnitRange, '50_100_kg');
    });

    it('infers Brown Rice grainType for brown rice products', () => {
      const prod = {
        name: 'Organic India Brown Rice 1 kg',
        category: 'Atta & Rice',
        subCategory: 'Rice',
        brand: 'Organic India',
        qnty: '1 kg',
        sellingPrice: 140
      };
      const attrs = inferProductAttributes(prod);
      assert.strictEqual(attrs.grainType, 'Brown Rice');
      assert.strictEqual(attrs.pricePerUnitRange, '100_150_kg');
    });

    it('infers dietary indicator properly', () => {
      const veg = inferProductAttributes({ name: 'Milk', isVeg: true });
      assert.strictEqual(veg.dietary, 'Vegetarian');

      const nonVeg = inferProductAttributes({ name: 'Chicken Soup', isVeg: false });
      assert.strictEqual(nonVeg.dietary, 'Non-Vegetarian');
    });
  });

  describe('extractCategoryFilterPills', () => {
    const mockPowderCatalog = [
      {
        name: 'Enchanteur Romantic Talc for Women',
        brand: 'Enchanteur',
        category: 'Beauty & Grooming',
        qnty: '125 g',
        sellingPrice: 148
      },
      {
        name: 'Yardley London English Lavender Talc for Women',
        brand: 'Yardley',
        category: 'Beauty & Grooming',
        qnty: '250 g',
        sellingPrice: 210
      },
      {
        name: 'Wild Stone Hydra Energy Talc for Men',
        brand: 'Wild Stone',
        category: 'Beauty & Grooming',
        qnty: '100 g',
        sellingPrice: 110
      },
      {
        name: 'Himalaya Baby Powder',
        brand: 'Himalaya',
        category: 'Baby Care',
        qnty: '200 g',
        sellingPrice: 130
      },
      {
        name: 'Ponds Dreamflower Talc Unisex',
        brand: 'Ponds',
        category: 'Beauty & Grooming',
        qnty: '100 g',
        sellingPrice: 95
      }
    ];

    it('dynamically generates Gender and Brand pills for powder search', () => {
      const result = extractCategoryFilterPills(mockPowderCatalog, 'powder', 'Beauty & Grooming');

      assert.strictEqual(result.query, 'powder');
      assert.strictEqual(result.category, 'Beauty & Grooming');
      assert.deepStrictEqual(result.sortOptions, DEFAULT_SORT_OPTIONS);
      assert.strictEqual(result.priceRange.min, 95);
      assert.strictEqual(result.priceRange.max, 210);

      // Verify Gender pill
      const genderPill = result.filterPills.find(p => p.key === 'gender');
      assert.ok(genderPill, 'Should have gender filter pill');
      assert.strictEqual(genderPill.label, 'Gender');
      assert.strictEqual(genderPill.type, 'single_select');

      const womenOpt = genderPill.options.find(o => o.value === 'Women');
      assert.ok(womenOpt);
      assert.strictEqual(womenOpt.count, 2);

      const menOpt = genderPill.options.find(o => o.value === 'Men');
      assert.ok(menOpt);
      assert.strictEqual(menOpt.count, 1);

      const babyOpt = genderPill.options.find(o => o.value === 'Baby');
      assert.ok(babyOpt);
      assert.strictEqual(babyOpt.count, 1);

      const unisexOpt = genderPill.options.find(o => o.value === 'Unisex');
      assert.ok(unisexOpt);
      assert.strictEqual(unisexOpt.count, 1);

      // Verify Brand pill
      const brandPill = result.filterPills.find(p => p.key === 'brand');
      assert.ok(brandPill, 'Should have brand filter pill');
      assert.strictEqual(brandPill.options.length, 5);
    });

    const mockRiceCatalog = [
      {
        name: 'India Gate Basmati Rice Feast Rozzana 1 kg',
        brand: 'India Gate',
        category: 'Atta & Rice',
        qnty: '1 kg',
        sellingPrice: 120
      },
      {
        name: 'Fortune Special Biryani Basmati Rice 1 kg',
        brand: 'Fortune',
        category: 'Atta & Rice',
        qnty: '1 kg',
        sellingPrice: 180
      },
      {
        name: 'Fortune Everyday Sona Masoori Rice 5 kg',
        brand: 'Fortune',
        category: 'Atta & Rice',
        qnty: '5 kg',
        sellingPrice: 280
      },
      {
        name: 'Organic India Brown Rice 1 kg',
        brand: 'Organic India',
        category: 'Atta & Rice',
        qnty: '1 kg',
        sellingPrice: 140
      }
    ];

    it('dynamically generates Grain Type and Price per kg pills for rice search', () => {
      const result = extractCategoryFilterPills(mockRiceCatalog, 'rice', 'Atta & Rice');

      // Verify Grain Type pill
      const grainPill = result.filterPills.find(p => p.key === 'grainType');
      assert.ok(grainPill, 'Should have grainType filter pill');
      assert.strictEqual(grainPill.label, 'Grain Type');

      const basmatiOpt = grainPill.options.find(o => o.value === 'Basmati');
      assert.ok(basmatiOpt);
      assert.strictEqual(basmatiOpt.count, 2);

      const dailyOpt = grainPill.options.find(o => o.value === 'Daily Rice');
      assert.ok(dailyOpt);
      assert.strictEqual(dailyOpt.count, 1);

      const brownOpt = grainPill.options.find(o => o.value === 'Brown Rice');
      assert.ok(brownOpt);
      assert.strictEqual(brownOpt.count, 1);

      // Verify Price per kg pill
      const priceKgPill = result.filterPills.find(p => p.key === 'pricePerUnit');
      assert.ok(priceKgPill, 'Should have pricePerUnit filter pill for kg');
      assert.strictEqual(priceKgPill.label, 'Price per kg');
      assert.ok(priceKgPill.options.length > 0);
    });
  });
});
