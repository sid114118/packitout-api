const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  expandQueryTokens,
  calculateGroceryRelevance,
  classifyProduct,
  normalizeStem,
  tokenMatches
} = require('../utils/grocerySearchEngine');
const { searchProducts } = require('../services/catalogSearchService');

describe('Grocery Search Engine & Catalog Relevance Tests', () => {
  const catalog = [
    {
      _id: 'dryfruit_kaju_whole',
      name: 'King House Premium Kaju / Cashew Nuts Whole (W210) 250g',
      brand: 'King House',
      category: 'Dry Fruits & Cereals',
      subCategory: 'Almonds & Cashews',
      mrp: 350,
      sellingPrice: 320,
      qnty: '250 g',
      inStock: true
    },
    {
      _id: 'dryfruit_kaju_tukda',
      name: 'Kaju Tukda / Broken Cashew Nuts 500g',
      brand: 'Loose',
      category: 'Dry Fruits & Cereals',
      subCategory: 'Almonds & Cashews',
      mrp: 450,
      sellingPrice: 400,
      qnty: '500 g',
      inStock: true
    },
    {
      _id: 'dryfruit_cashew_only',
      name: 'Royal Premium Cashew Nuts W320 250g',
      brand: 'Royal',
      category: 'Dry Fruits & Cereals',
      subCategory: 'Almonds & Cashews',
      mrp: 340,
      sellingPrice: 310,
      qnty: '250 g',
      inStock: true
    },
    {
      _id: 'kaju_cake',
      name: 'Britannia Kaju Cake 50g',
      brand: 'Britannia',
      category: 'Bakery & Biscuits',
      subCategory: 'Cakes & Muffins',
      mrp: 30,
      sellingPrice: 25,
      qnty: '50 g',
      inStock: true
    },
    {
      _id: 'kaju_mixture_namkeen',
      name: 'Haldiram Kaju Mixture Namkeen 400g Zipper Pack',
      brand: 'Haldiram',
      category: 'Chips & Namkeen',
      subCategory: 'Traditional Namkeen',
      mrp: 190,
      sellingPrice: 175,
      qnty: '400 g',
      inStock: true
    },
    {
      _id: 'kaju_biscuit',
      name: 'Britannia Good Day Kaju / Cashew Cookies 200g',
      brand: 'Britannia',
      category: 'Bakery & Biscuits',
      subCategory: 'Cookies',
      mrp: 45,
      sellingPrice: 40,
      qnty: '200 g',
      inStock: true
    },
    {
      _id: 'kaju_ice_cream',
      name: 'Amul Gold Kaju Draksh Ice Cream Tub 1L',
      brand: 'Amul',
      category: 'Ice Creams',
      subCategory: 'Tubs & Bricks',
      mrp: 260,
      sellingPrice: 240,
      qnty: '1 L',
      inStock: true
    },
    {
      _id: 'kaju_katli_sweet',
      name: 'Amul Kaju Katli Packaged Indian Sweet 200g',
      brand: 'Amul',
      category: 'Sweets & Chocolates',
      subCategory: 'Packaged Indian Sweets',
      mrp: 220,
      sellingPrice: 200,
      qnty: '200 g',
      inStock: true
    },
    {
      _id: 'rice_basmati',
      name: 'Daawat Rozzana Super Basmati Rice 5kg',
      brand: 'Daawat',
      category: 'Atta & Rice',
      subCategory: 'Basmati Rice',
      mrp: 495,
      sellingPrice: 425,
      qnty: '5 kg',
      inStock: true
    },
    {
      _id: 'sugar_madhur',
      name: 'Madhur Pure & Hygienic Sugar 1kg',
      brand: 'Madhur',
      category: 'Oil, Ghee & Salt',
      subCategory: 'Salt & Sugar',
      mrp: 60,
      sellingPrice: 52,
      qnty: '1 kg',
      inStock: true
    },
    {
      _id: 'turmeric_everest',
      name: 'Everest Haldi / Turmeric Powder 200g',
      brand: 'Everest',
      category: 'Spices & Condiments',
      subCategory: 'Powdered Spices',
      mrp: 75,
      sellingPrice: 68,
      qnty: '200 g',
      inStock: true
    },
    {
      _id: 'jeera_mdh',
      name: 'MDH Jeera Whole Cumin Seeds 100g',
      brand: 'MDH',
      category: 'Spices & Condiments',
      subCategory: 'Whole Spices',
      mrp: 80,
      sellingPrice: 75,
      qnty: '100 g',
      inStock: true
    },
    {
      _id: 'paneer_amul',
      name: 'Amul Malai Fresh Paneer 200g',
      brand: 'Amul',
      category: 'Dairy, Bread & Eggs',
      subCategory: 'Paneer & Tofu',
      mrp: 90,
      sellingPrice: 85,
      qnty: '200 g',
      inStock: true
    },
    {
      _id: 'rajma_fortune',
      name: 'Fortune Chitra Rajma 500g',
      brand: 'Fortune',
      category: 'Dals & Pulses',
      subCategory: 'Rajma & Chole',
      mrp: 110,
      sellingPrice: 98,
      qnty: '500 g',
      inStock: true
    },
    {
      _id: 'ghee_amul',
      name: 'Amul Pure Desi Ghee 1L Tin',
      brand: 'Amul',
      category: 'Oil, Ghee & Salt',
      subCategory: 'Ghee',
      mrp: 650,
      sellingPrice: 610,
      qnty: '1 L',
      inStock: true
    },
    {
      _id: 'data_cable',
      name: 'USB Type C Fast Charging Data Cable 1m',
      brand: 'Generic',
      category: 'Home & Office',
      subCategory: 'Stationery',
      mrp: 199,
      sellingPrice: 99,
      qnty: '1 pc',
      inStock: true
    },
    {
      _id: 'misclassified_dove_soap',
      name: 'Dove Cream Beauty Bathing Bar Soap 100g',
      brand: 'Dove',
      category: 'Sweets & Chocolates', // intentionally misclassified in legacy db
      subCategory: 'Sweets & Chocolates',
      mrp: 70,
      sellingPrice: 65,
      qnty: '100 g',
      inStock: true
    },
    {
      _id: 'misclassified_hair_oil',
      name: 'Bajaj Almond Drops Non-Sticky Hair Oil 100ml',
      brand: 'Bajaj',
      category: 'Oil, Ghee & Salt', // intentionally misclassified in legacy db
      subCategory: 'Cooking Oil',
      mrp: 85,
      sellingPrice: 78,
      qnty: '100 ml',
      inStock: true
    }
  ];

  describe('1. Search Relevance & Weighted Ranking (Core Promotion & Derivative Demotion)', () => {
    it('ranks pure Kaju/Cashew dry fruits at the very top when searching "kaju"', async () => {
      const res = await searchProducts({
        query: 'kaju',
        inMemoryProducts: catalog,
        limit: 10
      });

      assert.ok(res.items.length >= 5);
      const topNames = res.items.slice(0, 3).map(i => i.name);

      assert.ok(
        topNames[0].includes('King House') || topNames[0].includes('Kaju Tukda'),
        `Expected pure dry fruit at rank 1, got: ${topNames[0]}`
      );
      assert.ok(
        topNames[1].includes('King House') || topNames[1].includes('Kaju Tukda'),
        `Expected pure dry fruit at rank 2, got: ${topNames[1]}`
      );
    });

    it('demotes derivative products (Kaju biscuits, cake, namkeen, ice cream) below core products', async () => {
      const res = await searchProducts({
        query: 'kaju',
        inMemoryProducts: catalog,
        limit: 10
      });

      const names = res.items.map(i => i.name);
      const idxKingHouse = names.findIndex(n => n.includes('King House'));
      const idxTukda = names.findIndex(n => n.includes('Kaju Tukda'));
      const idxBiscuit = names.findIndex(n => n.includes('Britannia Good Day Kaju'));
      const idxCake = names.findIndex(n => n.includes('Britannia Kaju Cake'));
      const idxMixture = names.findIndex(n => n.includes('Haldiram Kaju Mixture'));
      const idxIceCream = names.findIndex(n => n.includes('Amul Gold Kaju Draksh'));

      assert.ok(idxKingHouse < idxBiscuit, 'Pure Cashew must rank above Kaju Cookies');
      assert.ok(idxKingHouse < idxCake, 'Pure Cashew must rank above Kaju Cake');
      assert.ok(idxKingHouse < idxMixture, 'Pure Cashew must rank above Kaju Mixture');
      assert.ok(idxKingHouse < idxIceCream, 'Pure Cashew must rank above Kaju Ice Cream');
      assert.ok(idxTukda < idxBiscuit, 'Kaju Tukda must rank above Kaju Cookies');
    });

    it('boosts derivative products when user explicitly searches for them (e.g. "kaju biscuit")', () => {
      const qc = expandQueryTokens('kaju biscuit');
      const biscuitItem = catalog.find(i => i._id === 'kaju_biscuit');
      const score = calculateGroceryRelevance(biscuitItem, qc);
      assert.ok(score >= 350, `Expected explicit kaju biscuit to be boosted, got score ${score}`);
    });

    it('activates category intent boosting for core terms (Dry Fruits & Cereals for "kaju")', () => {
      const qc = expandQueryTokens('kaju');
      assert.ok(qc.intent, 'Core intent should be detected for kaju');
      assert.ok(qc.intent.intentCategories.includes('Dry Fruits & Cereals'));
    });
  });

  describe('2. Synonyms, Bilingual (Hinglish/English) & Typo Matching', () => {
    it('retrieves Cashew-only titled item when searching Hindi/Hinglish "kaju"', async () => {
      const res = await searchProducts({
        query: 'kaju',
        inMemoryProducts: catalog
      });

      const found = res.items.some(i => i.name.includes('Royal Premium Cashew Nuts'));
      assert.ok(found, 'Searching "kaju" must retrieve "Royal Premium Cashew Nuts" via bilingual synonym');
    });

    it('retrieves Rice items when searching Hindi/Hinglish "chawal"', async () => {
      const res = await searchProducts({
        query: 'chawal',
        inMemoryProducts: catalog
      });

      assert.ok(res.items.length >= 1);
      assert.ok(res.items[0].name.includes('Basmati Rice'));
    });

    it('retrieves Sugar items when searching Hindi/Hinglish "chini" and "cheeni"', async () => {
      const res1 = await searchProducts({ query: 'chini', inMemoryProducts: catalog });
      assert.ok(res1.items.length >= 1);
      assert.ok(res1.items[0].name.includes('Madhur Pure & Hygienic Sugar'));

      const res2 = await searchProducts({ query: 'cheeni', inMemoryProducts: catalog });
      assert.ok(res2.items.length >= 1);
      assert.ok(res2.items[0].name.includes('Madhur Pure & Hygienic Sugar'));
    });

    it('supports multi-word query phrases: "cumin seeds", "cottage cheese", "clarified butter", "kidney beans"', () => {
      const qCumin = expandQueryTokens('cumin seeds');
      assert.ok(calculateGroceryRelevance(catalog.find(i => i._id === 'jeera_mdh'), qCumin) > 0);

      const qCheese = expandQueryTokens('cottage cheese');
      assert.ok(calculateGroceryRelevance(catalog.find(i => i._id === 'paneer_amul'), qCheese) > 0);

      const qButter = expandQueryTokens('clarified butter');
      assert.ok(calculateGroceryRelevance(catalog.find(i => i._id === 'ghee_amul'), qButter) > 0);

      const qBeans = expandQueryTokens('kidney beans');
      assert.ok(calculateGroceryRelevance(catalog.find(i => i._id === 'rajma_fortune'), qBeans) > 0);
    });

    it('supports multi-word product titles with single-word query: "rajma" on "Kidney Beans", "paneer" on "Cottage Cheese"', () => {
      const qRajma = expandQueryTokens('rajma');
      const kidneyItem = { name: 'Organic Kidney Beans 500g', category: 'Dals & Pulses' };
      assert.ok(calculateGroceryRelevance(kidneyItem, qRajma) > 0);

      const qPaneer = expandQueryTokens('paneer');
      const cottageItem = { name: 'Milky Mist Fresh Cottage Cheese 200g', category: 'Dairy, Bread & Eggs' };
      assert.ok(calculateGroceryRelevance(cottageItem, qPaneer) > 0);
    });

    it('handles typo matching: "chawall" matches Basmati Rice, "casheww" matches Cashew Nuts', () => {
      const qChawall = expandQueryTokens('chawall');
      assert.ok(calculateGroceryRelevance(catalog.find(i => i._id === 'rice_basmati'), qChawall) > 0);

      const qCasheww = expandQueryTokens('casheww');
      assert.ok(calculateGroceryRelevance(catalog.find(i => i._id === 'dryfruit_cashew_only'), qCasheww) > 0);
    });

    it('strictly prevents short-word false-positive typos: "atta" does NOT match Data Cable, "beans" does NOT match Besan', () => {
      const qAtta = expandQueryTokens('atta');
      assert.strictEqual(calculateGroceryRelevance(catalog.find(i => i._id === 'data_cable'), qAtta), -1);

      const qBeans = expandQueryTokens('beans');
      const besanItem = { name: 'Fortune Besan 500g', category: 'Atta & Rice' };
      assert.strictEqual(calculateGroceryRelevance(besanItem, qBeans), -1);
    });

    it('supports plural stemming: "cashews" retrieves "cashew" and vice-versa', () => {
      assert.strictEqual(normalizeStem('cashews'), 'cashew');
      assert.strictEqual(normalizeStem('biscuits'), 'biscuit');
      assert.strictEqual(normalizeStem('eggs'), 'egg');
      assert.ok(tokenMatches('cashews', 'cashew'));
      assert.ok(tokenMatches('biscutes', 'biscuit'));
    });
  });

  describe('3. Catalog Misclassification Self-Healing & Classification Audit', () => {
    it('reclassifies miscategorized bathing soap out of Sweets & Chocolates into Bath & Body', () => {
      const fixed = classifyProduct({
        name: 'Dove Cream Beauty Bathing Bar Soap 100g',
        category: 'Sweets & Chocolates'
      });
      assert.ok(fixed);
      assert.strictEqual(fixed.category, 'Bath & Body');
      assert.strictEqual(fixed.subCategory, 'Bar Soaps');
    });

    it('reclassifies hair oil out of Cooking Oil into Beauty & Grooming > Hair Care & Oils', () => {
      const fixed = classifyProduct({
        name: 'Bajaj Almond Drops Non-Sticky Hair Oil 100ml',
        category: 'Oil, Ghee & Salt',
        subCategory: 'Cooking Oil'
      });
      assert.ok(fixed);
      assert.strictEqual(fixed.category, 'Beauty & Grooming');
      assert.strictEqual(fixed.subCategory, 'Hair Care & Oils');
    });

    it('reclassifies face scrubs out of Dry Fruits into Beauty & Grooming > Skin Care & Lotions', () => {
      const fixed = classifyProduct({
        name: 'Everyuth Walnut Face Scrub 25g',
        category: 'Dry Fruits & Cereals'
      });
      assert.ok(fixed);
      assert.strictEqual(fixed.category, 'Beauty & Grooming');
      assert.strictEqual(fixed.subCategory, 'Skin Care & Lotions');
    });

    it('reclassifies chocolates out of Dry Fruits into Sweets & Chocolates > Chocolates', () => {
      const fixed = classifyProduct({
        name: 'Cadbury Silk Roast Almond Chocolate Bar 50g',
        category: 'Dry Fruits & Cereals'
      });
      assert.ok(fixed);
      assert.strictEqual(fixed.category, 'Sweets & Chocolates');
      assert.strictEqual(fixed.subCategory, 'Chocolates');
    });

    it('reclassifies cooking oils named after grains out of Atta & Rice into Oil, Ghee & Salt', () => {
      const fixed = classifyProduct({
        name: 'Fortune Rice Bran Refined Oil 750g Pouch',
        category: 'Atta & Rice',
        subCategory: 'Daily Rice'
      });
      assert.ok(fixed);
      assert.strictEqual(fixed.category, 'Oil, Ghee & Salt');
      assert.strictEqual(fixed.subCategory, 'Refined Oils');
    });

    it('auto-heals catalog items on load in searchProducts', async () => {
      const res = await searchProducts({
        query: 'Dove',
        inMemoryProducts: catalog
      });
      assert.strictEqual(res.items[0].category, 'Bath & Body');
      assert.strictEqual(res.items[0].subCategory, 'Bar Soaps');
    });
  });
});
