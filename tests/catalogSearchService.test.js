const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  getAutocompleteSuggestions,
  getCategoryFilters,
  searchProducts,
  resolveThumbnail
} = require('../services/catalogSearchService');

describe('CatalogSearchService Tests', () => {
  const sampleProducts = [
    {
      _id: 'prod_talc_125g',
      name: 'Enchanteur Romantic Perfumed Talcum Powder for Women 125 g',
      brand: 'Enchanteur',
      category: 'Beauty & Grooming',
      subCategory: 'Deodorants & Fragrances',
      qnty: '125 g',
      mrp: 185,
      sellingPrice: 148,
      itemGroupId: 'enchanteur_romantic_talc',
      image: 'https://res.cloudinary.com/dj48tkcsw/image/upload/v1775368062/Products/Enchanteur/125.webp',
      inStock: true
    },
    {
      _id: 'prod_talc_250g',
      name: 'Enchanteur Romantic Perfumed Talcum Powder for Women 250 g',
      brand: 'Enchanteur',
      category: 'Beauty & Grooming',
      subCategory: 'Deodorants & Fragrances',
      qnty: '250 g',
      mrp: 320,
      sellingPrice: 260,
      itemGroupId: 'enchanteur_romantic_talc',
      image: 'https://res.cloudinary.com/dj48tkcsw/image/upload/v1775368062/Products/Enchanteur/250.webp',
      inStock: true
    },
    {
      _id: 'prod_face_powder',
      name: 'White Tone Face Powder Soft Glow',
      brand: 'White Tone',
      category: 'Beauty & Grooming',
      subCategory: 'Makeup & Cosmetics',
      qnty: '70 g',
      mrp: 120,
      sellingPrice: 105,
      itemGroupId: '',
      image: 'https://res.cloudinary.com/dj48tkcsw/image/upload/v1775374531/Products/WhiteTone/sample.avif',
      inStock: true
    },
    {
      _id: 'prod_detergent_powder',
      name: 'Surf Excel Quick Wash Detergent Powder 1 kg',
      brand: 'Surf Excel',
      category: 'Cleaners & Repellents',
      subCategory: 'Laundry Care',
      qnty: '1 kg',
      mrp: 160,
      sellingPrice: 140,
      itemGroupId: 'surf_excel_powder',
      image: 'https://res.cloudinary.com/dj48tkcsw/image/upload/v1775368144/Products/SurfExcel/sample.webp',
      inStock: true
    },
    {
      _id: 'prod_himalaya_baby_powder',
      name: 'Himalaya Baby Powder 400 g',
      brand: 'Himalaya',
      category: 'Baby Care',
      subCategory: 'Baby Skin & Bath',
      qnty: '400 g',
      mrp: 230,
      sellingPrice: 200,
      itemGroupId: '',
      image: 'https://res.cloudinary.com/dj48tkcsw/image/upload/v1775368302/Products/Himalaya/sample.webp',
      inStock: true
    },
    {
      _id: 'prod_basmati_1kg',
      name: 'Amul Organic Basmati Rice 1 kg',
      brand: 'Amul',
      category: 'Atta & Rice',
      subCategory: 'Basmati Rice',
      qnty: '1 kg',
      mrp: 199,
      sellingPrice: 171,
      itemGroupId: 'amul_basmati_rice',
      image: 'https://res.cloudinary.com/dj48tkcsw/image/upload/v1775368127/Products/Amul/sample.webp',
      inStock: true
    },
    {
      _id: 'prod_daily_rice_5kg',
      name: 'Fortune Everyday Sona Masoori Rice 5 kg',
      brand: 'Fortune',
      category: 'Atta & Rice',
      subCategory: 'Rice',
      qnty: '5 kg',
      mrp: 350,
      sellingPrice: 290,
      itemGroupId: 'fortune_sona_masoori',
      image: 'https://res.cloudinary.com/dj48tkcsw/image/upload/v1775368127/Products/Fortune/rice.webp',
      inStock: true
    }
  ];

  describe('Autocomplete Suggestions', () => {
    it('returns category, subcategory and brand suggestions with Cloudinary thumbnails for "powder"', async () => {
      const res = await getAutocompleteSuggestions({
        query: 'powder',
        inMemoryProducts: sampleProducts,
        limit: 8
      });

      assert.strictEqual(res.query, 'powder');
      assert.ok(Array.isArray(res.suggestions));
      assert.ok(res.suggestions.length >= 4);

      // Verify each suggestion has required properties and Cloudinary thumbnail
      for (const s of res.suggestions) {
        assert.ok(s.id, 'Suggestion should have id');
        assert.ok(s.text, 'Suggestion should have text');
        assert.ok(s.type, 'Suggestion should have type');
        assert.ok(s.thumbnail, 'Suggestion should have thumbnail');
        assert.ok(
          s.thumbnail.startsWith('https://res.cloudinary.com/'),
          `Thumbnail should be Cloudinary URL: ${s.thumbnail}`
        );
      }

      const texts = res.suggestions.map(s => s.text.toLowerCase());
      assert.ok(texts.some(t => t.includes('powder')), 'Should include broad powder category');
      assert.ok(texts.some(t => t.includes('face powder') || t.includes('talcum') || t.includes('detergent')), 'Should include subcategories');
      assert.ok(texts.some(t => t.includes('himalaya')), 'Should include brand item suggestion');
    });

    it('returns empty suggestions for empty query', async () => {
      const res = await getAutocompleteSuggestions({
        query: '',
        inMemoryProducts: sampleProducts
      });
      assert.strictEqual(res.query, '');
      assert.deepStrictEqual(res.suggestions, []);
    });
  });

  describe('Dynamic Filters Service', () => {
    it('returns dynamic filter pills, sort options and price range for "powder"', async () => {
      const res = await getCategoryFilters({
        query: 'powder',
        inMemoryProducts: sampleProducts
      });

      assert.strictEqual(res.query, 'powder');
      assert.ok(Array.isArray(res.sortOptions));
      assert.strictEqual(res.sortOptions.length, 5);

      assert.ok(res.priceRange.min <= res.priceRange.max);
      assert.strictEqual(res.priceRange.min, 105);
      assert.strictEqual(res.priceRange.max, 260);

      // Check gender pill presence for powder
      const genderPill = res.filterPills.find(p => p.key === 'gender');
      assert.ok(genderPill, 'Should have gender pill');
      assert.ok(genderPill.options.some(o => o.value === 'Women'));
      assert.ok(genderPill.options.some(o => o.value === 'Baby'));

      // Check brand pill
      const brandPill = res.filterPills.find(p => p.key === 'brand');
      assert.ok(brandPill, 'Should have brand pill');
    });

    it('returns grainType filter pill for "rice"', async () => {
      const res = await getCategoryFilters({
        query: 'rice',
        inMemoryProducts: sampleProducts
      });

      const grainPill = res.filterPills.find(p => p.key === 'grainType');
      assert.ok(grainPill, 'Should have grainType pill for rice');
      assert.ok(grainPill.options.some(o => o.value === 'Basmati'));
      assert.ok(grainPill.options.some(o => o.value === 'Daily Rice'));
    });
  });

  describe('SearchProducts - Filtering, Sorting & Variant Consolidation', () => {
    it('consolidates multi-variant products by itemGroupId into single product card with variants array', async () => {
      const res = await searchProducts({
        query: 'Enchanteur',
        inMemoryProducts: sampleProducts
      });

      assert.strictEqual(res.total, 1, 'Both 125g and 250g Enchanteur should consolidate into 1 product card');
      const card = res.items[0];
      assert.strictEqual(card.itemGroupId, 'enchanteur_romantic_talc');
      assert.strictEqual(card.isMultiVariant, true);
      assert.strictEqual(card.variants.length, 2);

      // Verify unit prices on main card and variants
      assert.strictEqual(card.unitPrice, 118);
      assert.strictEqual(card.unitMeasure, '100 g');
      assert.strictEqual(card.unitPriceDisplay, '₹118/100 g');

      // Verify variant details
      const var1 = card.variants.find(v => v.qnty === '125 g');
      const var2 = card.variants.find(v => v.qnty === '250 g');
      assert.ok(var1);
      assert.ok(var2);
      assert.strictEqual(var1.unitPriceDisplay, '₹118/100 g');
      assert.strictEqual(var2.unitPriceDisplay, '₹104/100 g');
    });

    it('filters by dynamic attribute gender="Baby"', async () => {
      const res = await searchProducts({
        query: 'powder',
        gender: 'Baby',
        inMemoryProducts: sampleProducts
      });

      assert.strictEqual(res.total, 1);
      assert.strictEqual(res.items[0].brand, 'Himalaya');
      assert.strictEqual(res.items[0].attributes.gender, 'Baby');
    });

    it('filters by dynamic attribute grainType="Basmati"', async () => {
      const res = await searchProducts({
        query: 'rice',
        grainType: 'Basmati',
        inMemoryProducts: sampleProducts
      });

      assert.strictEqual(res.total, 1);
      assert.strictEqual(res.items[0].name, 'Amul Organic Basmati Rice 1 kg');
      assert.strictEqual(res.items[0].unitPriceDisplay, '₹171/kg');
    });

    it('filters by price range (minPrice, maxPrice)', async () => {
      const res = await searchProducts({
        query: 'powder',
        minPrice: 100,
        maxPrice: 150,
        inMemoryProducts: sampleProducts
      });

      for (const item of res.items) {
        assert.ok(item.sellingPrice >= 100 && item.sellingPrice <= 150);
      }
    });

    it('sorts by price_asc', async () => {
      const res = await searchProducts({
        query: 'powder',
        sort: 'price_asc',
        inMemoryProducts: sampleProducts
      });

      const prices = res.items.map(i => i.sellingPrice);
      for (let i = 0; i < prices.length - 1; i++) {
        assert.ok(prices[i] <= prices[i + 1], `Price ${prices[i]} should be <= ${prices[i+1]}`);
      }
    });

    it('sorts by price_desc', async () => {
      const res = await searchProducts({
        query: 'powder',
        sort: 'price_desc',
        inMemoryProducts: sampleProducts
      });

      const prices = res.items.map(i => i.sellingPrice);
      for (let i = 0; i < prices.length - 1; i++) {
        assert.ok(prices[i] >= prices[i + 1], `Price ${prices[i]} should be >= ${prices[i+1]}`);
      }
    });

    it('sorts by discount_desc', async () => {
      const res = await searchProducts({
        query: 'powder',
        sort: 'discount_desc',
        inMemoryProducts: sampleProducts
      });

      const discounts = res.items.map(i => i.discountPercent);
      for (let i = 0; i < discounts.length - 1; i++) {
        assert.ok(discounts[i] >= discounts[i + 1]);
      }
    });
  });
});
