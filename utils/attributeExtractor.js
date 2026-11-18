/**
 * PackItOut - Attribute Extractor Utility
 * Dynamic attribute inference and context-aware filter aggregation
 * for search results and category navigation.
 */

const { computeUnitPrice } = require('./unitPriceCalculator');

const attributeCache = new WeakMap();

/**
 * Dynamically infers attributes for a product based on its name, category,
 * subCategory, brand, searchTags, description, and quantity.
 *
 * @param {object} product
 * @returns {object} Extracted key-value attributes (e.g. { gender, grainType, dietary, brand, unitMeasure, pricePerUnitRange })
 */
function inferProductAttributes(product) {
  if (!product || typeof product !== 'object') return {};
  if (product.attributes) return product.attributes;
  const cached = attributeCache.get(product);
  if (cached) return cached;

  const attrs = {};
  const tagsStr = Array.isArray(product.searchTags)
    ? product.searchTags.join(' ')
    : String(product.searchTags || '');
  const rawText = `${product.name || ''} ${product.subCategory || ''} ${product.category || ''} ${tagsStr} ${product.description || ''}`;
  const text = rawText.toLowerCase();

  // 1. Gender Inference (cosmetics, powders, perfumes, personal care, baby products)
  const isPersonalCareOrBeauty =
    /beauty|grooming|personal care|cosmetic|fragrance|deodorant|perfume|powder|talc|soap|shampoo|skincare|skin|hair|lotion/i.test(text);

  const hasBabyCue = /\b(baby|infant|newborn|toddler|kinder)\b/i.test(text);
  const hasWomenCue = /\b(women|woman|ladies|female|girls?)\b/i.test(text);
  const hasMenCue = /\b(men|man|gentlemen|male|boys?)\b/i.test(text);
  const hasUnisexCue = /\b(unisex|all skin types|for all|men and women|women and men)\b/i.test(text);

  if (hasBabyCue) {
    attrs.gender = 'Baby';
  } else if (hasUnisexCue) {
    attrs.gender = 'Unisex';
  } else if (hasWomenCue && !hasMenCue) {
    attrs.gender = 'Women';
  } else if (hasMenCue && !hasWomenCue) {
    attrs.gender = 'Men';
  } else if (hasWomenCue && hasMenCue) {
    attrs.gender = 'Unisex';
  } else if (isPersonalCareOrBeauty && /powder|talc|perfume|deodorant|fragrance/i.test(text)) {
    // Default personal care fragrances/talcs without explicit gender markers to Unisex
    attrs.gender = 'Unisex';
  }

  // 2. Grain Type Inference (for Rice, Atta, Staples)
  const isGrainOrStaple = /rice|atta|wheat|flour|dal|pulse|grain/i.test(text);
  if (isGrainOrStaple) {
    if (/\bbasmati\b/i.test(text)) {
      attrs.grainType = 'Basmati';
    } else if (/\bbrown rice\b/i.test(text)) {
      attrs.grainType = 'Brown Rice';
    } else if (/\b(kolam|sona masoori|sonamasuri|daily rice|raw rice|boiled rice|ponni|idli rice|broken rice|jeera rice|gobindobhog|wada kolam)\b/i.test(text)) {
      attrs.grainType = 'Daily Rice';
    } else if (/rice/i.test(text)) {
      // General rice if neither basmati nor brown
      attrs.grainType = 'Daily Rice';
    }
  }

  // 3. Dietary Inference (Vegetarian vs Non-Vegetarian)
  if (product.isVeg !== undefined && product.isVeg !== null) {
    attrs.dietary = product.isVeg ? 'Vegetarian' : 'Non-Vegetarian';
  } else if (/egg|chicken|mutton|fish|meat/i.test(text)) {
    attrs.dietary = 'Non-Vegetarian';
  } else {
    attrs.dietary = 'Vegetarian';
  }

  // 4. Normalized Brand
  let cleanBrand = (product.brand || '').trim();
  if (cleanBrand && cleanBrand.toLowerCase() !== 'nan' && cleanBrand.toLowerCase() !== 'undefined') {
    attrs.brand = cleanBrand;
  }

  // 5. Unit Price Range classification (e.g. Under ₹50/kg, ₹50-₹100/kg)
  const price = Number(product.sellingPrice || product.mrp || 0);
  if (price > 0 && product.qnty) {
    const unitPriceInfo = computeUnitPrice(price, product.qnty);
    if (unitPriceInfo) {
      attrs.unitMeasure = unitPriceInfo.unitMeasure;
      attrs.unitPrice = unitPriceInfo.unitPrice;
      attrs.unitPriceDisplay = unitPriceInfo.unitPriceDisplay;

      if (unitPriceInfo.unitMeasure === 'kg') {
        const p = unitPriceInfo.unitPrice;
        if (p < 50) attrs.pricePerUnitRange = 'under_50_kg';
        else if (p <= 100) attrs.pricePerUnitRange = '50_100_kg';
        else if (p <= 150) attrs.pricePerUnitRange = '100_150_kg';
        else attrs.pricePerUnitRange = '150_plus_kg';
      } else if (unitPriceInfo.unitMeasure === '100 g') {
        const p = unitPriceInfo.unitPrice;
        if (p < 50) attrs.pricePerUnitRange = 'under_50_100g';
        else if (p <= 100) attrs.pricePerUnitRange = '50_100_100g';
        else attrs.pricePerUnitRange = '100_plus_100g';
      }
    }
  }

  attributeCache.set(product, attrs);
  return attrs;
}

/**
 * Standard sort options supported across catalog searches
 */
const DEFAULT_SORT_OPTIONS = [
  { id: 'relevance', label: 'Relevance' },
  { id: 'price_asc', label: 'Price: Low to High' },
  { id: 'price_desc', label: 'Price: High to Low' },
  { id: 'discount_desc', label: 'Discount: High to Low' },
  { id: 'rating_desc', label: 'Customer Rating' }
];

/**
 * Dynamically compiles context-aware filter pills from an array of matching products,
 * adapting attributes (e.g., gender for cosmetics/powder, price per kg/grainType for rice).
 *
 * @param {Array<object>} products - Matching products
 * @param {string} query - Active query
 * @param {string} activeCategory - Active category filter
 * @returns {{
 *   query: string,
 *   category: string,
 *   sortOptions: Array<{ id: string, label: string }>,
 *   priceRange: { min: number, max: number },
 *   filterPills: Array<{ key: string, label: string, type: string, options: Array<{ value: string, label: string, count: number }> }>
 * }}
 */
function extractCategoryFilterPills(products = [], query = '', activeCategory = '') {
  const qLower = String(query || '').toLowerCase().trim();
  const catLower = String(activeCategory || '').toLowerCase().trim();

  // Price range calculation
  let minPrice = Infinity;
  let maxPrice = 0;

  // Facet count maps
  const genderCounts = { Women: 0, Men: 0, Baby: 0, Unisex: 0 };
  const grainTypeCounts = { Basmati: 0, 'Daily Rice': 0, 'Brown Rice': 0 };
  const brandCounts = new Map();
  const priceKgCounts = {
    'under_50': { label: 'Under ₹50/kg', count: 0, min: 0, max: 50 },
    '50_100': { label: '₹50 - ₹100/kg', count: 0, min: 50, max: 100 },
    '100_150': { label: '₹100 - ₹150/kg', count: 0, min: 100, max: 150 },
    '150_plus': { label: 'Above ₹150/kg', count: 0, min: 150, max: Infinity }
  };
  const price100gCounts = {
    'under_50': { label: 'Under ₹50/100g', count: 0, min: 0, max: 50 },
    '50_100': { label: '₹50 - ₹100/100g', count: 0, min: 50, max: 100 },
    '100_plus': { label: 'Above ₹100/100g', count: 0, min: 100, max: Infinity }
  };

  let hasGender = false;
  let hasGrainType = false;
  let kgProductCount = 0;
  let g100ProductCount = 0;

  for (const item of products) {
    const price = Number(item.sellingPrice || item.mrp || 0);
    if (price > 0) {
      if (price < minPrice) minPrice = price;
      if (price > maxPrice) maxPrice = price;
    }

    const attrs = item.attributes || inferProductAttributes(item);

    // Gender counts
    if (attrs.gender && genderCounts[attrs.gender] !== undefined) {
      genderCounts[attrs.gender]++;
      hasGender = true;
    }

    // Grain type counts
    if (attrs.grainType && grainTypeCounts[attrs.grainType] !== undefined) {
      grainTypeCounts[attrs.grainType]++;
      hasGrainType = true;
    }

    // Brand counts
    const brand = attrs.brand || item.brand;
    if (brand && String(brand).toLowerCase() !== 'nan') {
      const bKey = String(brand).trim();
      brandCounts.set(bKey, (brandCounts.get(bKey) || 0) + 1);
    }

    // Unit price ranges
    const unitMeasure = attrs.unitMeasure || item.unitMeasure;
    const unitPrice = attrs.unitPrice !== undefined ? attrs.unitPrice : item.unitPrice;
    if (unitMeasure === 'kg' && unitPrice !== undefined) {
      kgProductCount++;
      if (unitPrice < 50) priceKgCounts['under_50'].count++;
      else if (unitPrice <= 100) priceKgCounts['50_100'].count++;
      else if (unitPrice <= 150) priceKgCounts['100_150'].count++;
      else priceKgCounts['150_plus'].count++;
    } else if (unitMeasure === '100 g' && unitPrice !== undefined) {
      g100ProductCount++;
      if (unitPrice < 50) price100gCounts['under_50'].count++;
      else if (unitPrice <= 100) price100gCounts['50_100'].count++;
      else price100gCounts['100_plus'].count++;
    }
  }

  // Construct dynamic filter pills
  const filterPills = [];

  // Determine query/category context
  const isCosmeticOrPowderContext =
    qLower.includes('powder') ||
    qLower.includes('cream') ||
    qLower.includes('soap') ||
    qLower.includes('shampoo') ||
    catLower.includes('beauty') ||
    catLower.includes('grooming') ||
    hasGender;

  const isRiceOrGrainContext =
    qLower.includes('rice') ||
    qLower.includes('atta') ||
    catLower.includes('atta') ||
    catLower.includes('rice') ||
    hasGrainType;

  // 1. Gender Filter Pill (Dynamic: appears for powder / cosmetics / personal care)
  if (isCosmeticOrPowderContext || hasGender) {
    const genderOptions = [
      { value: 'Women', label: 'Women', count: genderCounts.Women },
      { value: 'Men', label: 'Men', count: genderCounts.Men },
      { value: 'Baby', label: 'Baby', count: genderCounts.Baby },
      { value: 'Unisex', label: 'Unisex', count: genderCounts.Unisex },
    ].filter(o => o.count > 0);

    if (genderOptions.length > 0) {
      filterPills.push({
        key: 'gender',
        label: 'Gender',
        type: 'single_select',
        priority: 1,
        options: genderOptions
      });
    }
  }

  // 2. Grain Type Pill (Dynamic: appears for rice/atta/grocery)
  if (isRiceOrGrainContext || hasGrainType) {
    const grainOptions = [
      { value: 'Basmati', label: 'Basmati', count: grainTypeCounts.Basmati },
      { value: 'Daily Rice', label: 'Daily Rice', count: grainTypeCounts['Daily Rice'] },
      { value: 'Brown Rice', label: 'Brown Rice', count: grainTypeCounts['Brown Rice'] },
    ].filter(o => o.count > 0);

    if (grainOptions.length > 0) {
      filterPills.push({
        key: 'grainType',
        label: 'Grain Type',
        type: 'single_select',
        priority: 1,
        options: grainOptions
      });
    }
  }

  // 3. Brand Pill (Available across all queries with multiple brands)
  if (brandCounts.size > 0) {
    const sortedBrands = Array.from(brandCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([brand, count]) => ({ value: brand, label: brand, count }));

    filterPills.push({
      key: 'brand',
      label: 'Brand',
      type: 'multi_select',
      priority: 2,
      options: sortedBrands
    });
  }

  // 4. Price Per Unit Pill (Dynamic: Price per kg for rice/staples, or Price per 100g for powders)
  if (isRiceOrGrainContext && kgProductCount > 0) {
    const kgOptions = Object.entries(priceKgCounts)
      .filter(([_, opt]) => opt.count > 0)
      .map(([key, opt]) => ({ value: key, label: opt.label, count: opt.count }));

    if (kgOptions.length > 0) {
      filterPills.push({
        key: 'pricePerUnit',
        label: 'Price per kg',
        type: 'single_select',
        priority: 3,
        options: kgOptions
      });
    }
  } else if (isCosmeticOrPowderContext && g100ProductCount > 0) {
    const gOptions = Object.entries(price100gCounts)
      .filter(([_, opt]) => opt.count > 0)
      .map(([key, opt]) => ({ value: key, label: opt.label, count: opt.count }));

    if (gOptions.length > 0) {
      filterPills.push({
        key: 'pricePerUnit',
        label: 'Price per 100g',
        type: 'single_select',
        priority: 3,
        options: gOptions
      });
    }
  }

  return {
    query: query || '',
    category: activeCategory || '',
    sortOptions: DEFAULT_SORT_OPTIONS,
    priceRange: {
      min: minPrice === Infinity ? 0 : minPrice,
      max: maxPrice === 0 ? 500 : maxPrice
    },
    filterPills
  };
}

module.exports = {
  inferProductAttributes,
  extractCategoryFilterPills,
  DEFAULT_SORT_OPTIONS,
};
