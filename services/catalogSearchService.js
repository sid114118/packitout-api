/**
 * PackItOut - Catalog Search & Autocomplete Service
 * Powers visual autocomplete with category thumbnails, dynamic attribute filtering,
 * variant-consolidated product cards, and standardized unit pricing.
 */

const { computeUnitPrice, parseQuantity } = require('../utils/unitPriceCalculator');
const { inferProductAttributes, extractCategoryFilterPills, DEFAULT_SORT_OPTIONS } = require('../utils/attributeExtractor');

// Curated high-resolution Cloudinary fallback thumbnails for standard categories/terms
const CURATED_CATEGORY_THUMBNAILS = {
  powder: 'https://res.cloudinary.com/dj48tkcsw/image/upload/v1775368062/Products/Amul/kp5mli0uneidjzg4ytmm.webp',
  'face powder': 'https://res.cloudinary.com/dj48tkcsw/image/upload/v1775374531/Products/Amul/tdxtg1ocwgcqiqzterj9.avif',
  'talcum powder': 'https://res.cloudinary.com/dj48tkcsw/image/upload/v1775368062/Products/Amul/kp5mli0uneidjzg4ytmm.webp',
  'detergent powder': 'https://res.cloudinary.com/dj48tkcsw/image/upload/v1775368144/Products/Amul/jaeiv0fjtlq2utwnk0cq.webp',
  'himalaya baby powder': 'https://res.cloudinary.com/dj48tkcsw/image/upload/v1775368302/Products/Amul/pke0syf0hs9bfqbqakja.webp',
  rice: 'https://res.cloudinary.com/dj48tkcsw/image/upload/v1775368127/Products/Amul/mjjjgita6hjipemw7gf2.webp',
  'basmati rice': 'https://res.cloudinary.com/dj48tkcsw/image/upload/v1775368127/Products/Amul/mjjjgita6hjipemw7gf2.webp',
  milk: 'https://res.cloudinary.com/dj48tkcsw/image/upload/v1775374531/Products/Amul/tdxtg1ocwgcqiqzterj9.avif',
  atta: 'https://res.cloudinary.com/dj48tkcsw/image/upload/v1775368127/Products/Amul/mjjjgita6hjipemw7gf2.webp',
  default: 'https://res.cloudinary.com/dj48tkcsw/image/upload/v1775368062/Products/Amul/kp5mli0uneidjzg4ytmm.webp'
};

/**
 * Resolves a thumbnail URL for a category/suggestion.
 */
function resolveThumbnail(text, matchedImage = null) {
  if (matchedImage && typeof matchedImage === 'string' && matchedImage.startsWith('http')) {
    return matchedImage;
  }
  const key = String(text || '').toLowerCase().trim();
  for (const [pattern, url] of Object.entries(CURATED_CATEGORY_THUMBNAILS)) {
    if (key.includes(pattern)) return url;
  }
  return CURATED_CATEGORY_THUMBNAILS.default;
}

/**
 * Helper to fetch raw product items either from inMemory array, Shop inventory, or MasterProduct model.
 */
async function getRawCatalogItems({ shopId, Shop, MasterProduct, inMemoryProducts }) {
  if (Array.isArray(inMemoryProducts) && inMemoryProducts.length > 0) {
    return inMemoryProducts;
  }

  if (shopId && Shop) {
    const shop = await Shop.findById(shopId)
      .select('inventory')
      .populate({
        path: 'inventory.product',
        select: 'name brand category subCategory section image mrp qnty emoji itemGroupId searchTags barcode isVeg description attributes'
      })
      .lean();

    if (!shop || !shop.inventory) return [];

    return shop.inventory
      .filter(inv => inv && inv.product && inv.product.name)
      .map(inv => {
        const p = inv.product;
        const mrpVal = Number(p.mrp) || 0;
        const sellVal = Number(inv.sellingPrice) || mrpVal;
        return {
          ...p,
          _id: p._id || inv._id,
          productId: p._id,
          sellingPrice: sellVal,
          inStock: inv.inStock !== false,
          stockCount: inv.stockCount || 0,
          isFeatured: Boolean(inv.isFeatured),
          featuredRank: inv.featuredRank ?? 999
        };
      });
  }

  if (MasterProduct) {
    const products = await MasterProduct.find({ isActive: { $ne: false } }).lean();
    return products.map(p => ({
      ...p,
      sellingPrice: Number(p.mrp) || 0,
      inStock: true
    }));
  }

  return [];
}

/**
 * Computes search score for relevance sorting
 */
function calculateRelevanceScore(product, queryTokens, fullQueryLower) {
  if (!queryTokens || queryTokens.length === 0) return 0;

  const nameLower = String(product.name || '').toLowerCase();
  const brandLower = String(product.brand || '').toLowerCase();
  const catLower = String(product.category || '').toLowerCase();
  const subLower = String(product.subCategory || '').toLowerCase();
  const barcodeStr = String(product.barcode || '').toLowerCase();
  const tagsStr = Array.isArray(product.searchTags)
    ? product.searchTags.join(' ').toLowerCase()
    : String(product.searchTags || '').toLowerCase();

  const haystack = `${nameLower} ${brandLower} ${catLower} ${subLower} ${barcodeStr} ${tagsStr}`;

  // Check if every token matches the haystack
  const allMatched = queryTokens.every(tok => haystack.includes(tok));
  if (!allMatched) return -1; // No match

  let score = 0;
  if (barcodeStr && barcodeStr === fullQueryLower) score += 300;
  if (nameLower === fullQueryLower) score += 200;
  else if (nameLower.startsWith(fullQueryLower)) score += 120;
  else if (nameLower.includes(fullQueryLower)) score += 60;

  if (brandLower === fullQueryLower || brandLower.startsWith(fullQueryLower)) score += 40;
  if (subLower.includes(fullQueryLower)) score += 30;
  if (catLower.includes(fullQueryLower)) score += 20;
  if (tagsStr.includes(fullQueryLower)) score += 25;

  if (product.inStock !== false) score += 10;
  if (product.isFeatured) score += 5;

  return score;
}

/**
 * 1. Autocomplete suggestion service:
 * Returns visual category/type/brand suggestions paired with representative Cloudinary thumbnail images.
 *
 * @param {object} params
 * @param {string} params.query
 * @param {string} [params.shopId]
 * @param {number} [params.limit=8]
 * @param {object} [params.Shop]
 * @param {object} [params.MasterProduct]
 * @param {Array} [params.inMemoryProducts]
 */
async function getAutocompleteSuggestions({ query, shopId, limit = 8, Shop, MasterProduct, inMemoryProducts }) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) {
    return { query: '', suggestions: [] };
  }

  const items = await getRawCatalogItems({ shopId, Shop, MasterProduct, inMemoryProducts });
  const qTokens = q.split(/\s+/).filter(Boolean);

  const categoryHits = new Map();
  const subCategoryHits = new Map();
  const brandHits = new Map();
  const phraseHits = new Map();

  for (const item of items) {
    const name = String(item.name || '');
    const nameLower = name.toLowerCase();
    const cat = item.category || 'General';
    const sub = item.subCategory || '';
    const brand = item.brand || '';
    const img = item.image;

    // Check broad category
    if (cat.toLowerCase().includes(q)) {
      if (!categoryHits.has(cat)) {
        categoryHits.set(cat, {
          id: `cat_${cat.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
          text: cat,
          type: 'category',
          category: cat,
          subCategory: sub,
          thumbnail: resolveThumbnail(cat, img),
          itemCount: 0
        });
      }
      categoryHits.get(cat).itemCount++;
    }

    // Check subcategory
    if (sub && sub.toLowerCase().includes(q)) {
      if (!subCategoryHits.has(sub)) {
        subCategoryHits.set(sub, {
          id: `sub_${sub.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
          text: sub,
          type: 'subCategory',
          category: cat,
          subCategory: sub,
          thumbnail: resolveThumbnail(sub, img),
          itemCount: 0
        });
      }
      subCategoryHits.get(sub).itemCount++;
    }

    // Check brand
    if (brand && brand.toLowerCase().includes(q)) {
      if (!brandHits.has(brand)) {
        brandHits.set(brand, {
          id: `brand_${brand.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
          text: brand,
          type: 'brand',
          brand,
          category: cat,
          subCategory: sub,
          thumbnail: resolveThumbnail(brand, img),
          itemCount: 0
        });
      }
      brandHits.get(brand).itemCount++;
    }

    // Check for high-interest specific item/type phrases (e.g. "Talcum powder", "Face powder", "Detergent powder", "Himalaya baby powder")
    if (nameLower.includes(q)) {
      // If brand + query is in name (e.g. "Himalaya baby powder")
      if (brand && nameLower.includes(brand.toLowerCase()) && brand.toLowerCase() !== q) {
        const brandItemPhrase = `${brand} ${q}`.trim();
        const formattedPhrase = brandItemPhrase.replace(/\b\w/g, c => c.toUpperCase());
        if (!phraseHits.has(formattedPhrase.toLowerCase())) {
          phraseHits.set(formattedPhrase.toLowerCase(), {
            id: `brand_item_${formattedPhrase.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
            text: formattedPhrase,
            type: 'brand_item',
            brand,
            category: cat,
            subCategory: sub,
            thumbnail: resolveThumbnail(formattedPhrase, img),
            itemCount: 0
          });
        }
        phraseHits.get(formattedPhrase.toLowerCase()).itemCount++;
      }

      // Check for compound sub-phrases like "Face powder", "Talcum powder", "Detergent powder"
      const subPhrases = ['face powder', 'talcum powder', 'detergent powder', 'baby powder', 'basmati rice', 'daily rice'];
      for (const phrase of subPhrases) {
        if (phrase.includes(q) && nameLower.includes(phrase)) {
          const formatted = phrase.replace(/\b\w/g, c => c.toUpperCase());
          if (!phraseHits.has(phrase)) {
            phraseHits.set(phrase, {
              id: `type_${phrase.replace(/[^a-z0-9]/g, '_')}`,
              text: formatted,
              type: 'subCategory',
              category: cat,
              subCategory: sub || formatted,
              thumbnail: resolveThumbnail(phrase, img),
              itemCount: 0
            });
          }
          phraseHits.get(phrase).itemCount++;
        }
      }
    }
  }

  // Synthesize top suggestions
  // If user searched a generic word like "powder", ensure broad Category "Powder" is at top
  const suggestions = [];
  const seenTexts = new Set();

  // If query is an archetype (e.g. "powder", "rice"), make sure a primary category suggestion is present
  const capitalizedQuery = q.replace(/\b\w/g, c => c.toUpperCase());
  if (!seenTexts.has(capitalizedQuery.toLowerCase())) {
    // Find representative category for this query
    let repCategory = 'Beauty & Grooming';
    let repSub = '';
    let repThumb = resolveThumbnail(q);

    for (const item of items) {
      if ((item.name || '').toLowerCase().includes(q)) {
        repCategory = item.category || repCategory;
        repSub = item.subCategory || repSub;
        if (item.image) {
          repThumb = item.image;
          break;
        }
      }
    }

    seenTexts.add(capitalizedQuery.toLowerCase());
    suggestions.push({
      id: `cat_${q}`,
      text: capitalizedQuery,
      type: 'category',
      category: repCategory,
      subCategory: repSub,
      thumbnail: repThumb,
      itemCount: items.filter(x => (x.name || '').toLowerCase().includes(q)).length
    });
  }

  // Add specific phrase hits (Face powder, Talcum powder, Detergent powder, Himalaya baby powder)
  for (const [_, hit] of phraseHits.entries()) {
    if (!seenTexts.has(hit.text.toLowerCase())) {
      seenTexts.add(hit.text.toLowerCase());
      suggestions.push(hit);
    }
  }

  // Add subcategory hits
  for (const [_, hit] of subCategoryHits.entries()) {
    if (!seenTexts.has(hit.text.toLowerCase())) {
      seenTexts.add(hit.text.toLowerCase());
      suggestions.push(hit);
    }
  }

  // Add category hits
  for (const [_, hit] of categoryHits.entries()) {
    if (!seenTexts.has(hit.text.toLowerCase())) {
      seenTexts.add(hit.text.toLowerCase());
      suggestions.push(hit);
    }
  }

  // Add brand hits
  for (const [_, hit] of brandHits.entries()) {
    if (!seenTexts.has(hit.text.toLowerCase())) {
      seenTexts.add(hit.text.toLowerCase());
      suggestions.push(hit);
    }
  }

  // Sort by itemCount descending while keeping category priority
  const finalSuggestions = suggestions
    .filter(s => s.itemCount > 0 || s.type === 'category')
    .slice(0, limit);

  return {
    query,
    suggestions: finalSuggestions
  };
}

/**
 * 2. Dynamic Attribute & Filter Extraction Service:
 * Aggregates context-aware filter pills (gender for powder, price per kg/brand for rice),
 * sort options, and price range.
 */
async function getCategoryFilters({ query = '', category = '', subCategory = '', shopId, Shop, MasterProduct, inMemoryProducts }) {
  const items = await getRawCatalogItems({ shopId, Shop, MasterProduct, inMemoryProducts });
  const qLower = String(query || '').trim().toLowerCase();
  const qTokens = qLower.split(/\s+/).filter(Boolean);
  const catLower = String(category || '').trim().toLowerCase();
  const subLower = String(subCategory || '').trim().toLowerCase();

  // Filter items matching the initial scope
  const matchingItems = items.filter(item => {
    if (catLower && !(item.category || '').toLowerCase().includes(catLower)) return false;
    if (subLower && (item.subCategory || '').toLowerCase() !== subLower) return false;

    if (qTokens.length > 0) {
      const score = calculateRelevanceScore(item, qTokens, qLower);
      if (score < 0) return false;
    }
    return true;
  });

  return extractCategoryFilterPills(matchingItems, query, category || subCategory);
}

/**
 * 3. Filtered, Sorted, Variant-Consolidated Catalog Search:
 * Supports dynamic attribute filters (gender, grainType, brand, price),
 * variant consolidation by itemGroupId, and standardized unit pricing.
 */
async function searchProducts({
  shopId,
  query = '',
  category = '',
  subCategory = '',
  brand = '',
  gender = '',
  grainType = '',
  minPrice,
  maxPrice,
  minUnitPrice,
  maxUnitPrice,
  sort = 'relevance',
  inStock,
  page = 1,
  limit = 40,
  Shop,
  MasterProduct,
  inMemoryProducts
}) {
  const items = await getRawCatalogItems({ shopId, Shop, MasterProduct, inMemoryProducts });

  const qRaw = String(query || '').trim().toLowerCase();
  const tokens = qRaw ? qRaw.split(/\s+/).filter(Boolean) : [];
  const catRaw = String(category || '').trim().toLowerCase();
  const subRaw = String(subCategory || '').trim().toLowerCase();
  const brandList = brand
    ? (Array.isArray(brand) ? brand : String(brand).split(',')).map(b => b.trim().toLowerCase()).filter(Boolean)
    : [];
  const genderRaw = String(gender || '').trim().toLowerCase();
  const grainRaw = String(grainType || '').trim().toLowerCase();
  const inStockOnly = inStock === true || inStock === 'true';

  const numMinPrice = minPrice !== undefined && minPrice !== '' ? Number(minPrice) : null;
  const numMaxPrice = maxPrice !== undefined && maxPrice !== '' ? Number(maxPrice) : null;
  const numMinUnitPrice = minUnitPrice !== undefined && minUnitPrice !== '' ? Number(minUnitPrice) : null;
  const numMaxUnitPrice = maxUnitPrice !== undefined && maxUnitPrice !== '' ? Number(maxUnitPrice) : null;

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 40));

  // Step 1: Filter and Enrich each item
  const processedItems = [];

  for (const item of items) {
    if (inStockOnly && item.inStock === false) continue;

    // Check category & subCategory
    if (catRaw && !(item.category || '').toLowerCase().includes(catRaw)) continue;
    if (subRaw && (item.subCategory || '').toLowerCase() !== subRaw) continue;

    // Check brand
    if (brandList.length > 0) {
      const itemBrand = (item.brand || '').toLowerCase();
      if (!brandList.includes(itemBrand)) continue;
    }

    // Relevance scoring
    let score = 0;
    if (tokens.length > 0) {
      score = calculateRelevanceScore(item, tokens, qRaw);
      if (score < 0) continue; // Did not match tokens
    } else {
      if (item.inStock !== false) score += 10;
      if (item.isFeatured) score += 5;
    }

    // Infer dynamic attributes
    const attrs = inferProductAttributes(item);

    // Dynamic attribute filtering: gender
    if (genderRaw) {
      const itemGender = (attrs.gender || '').toLowerCase();
      if (itemGender !== genderRaw) continue;
    }

    // Dynamic attribute filtering: grainType
    if (grainRaw) {
      const itemGrain = (attrs.grainType || '').toLowerCase();
      if (itemGrain !== grainRaw) continue;
    }

    // Pricing & Unit Pricing calculation
    const mrpVal = Number(item.mrp) || 0;
    const sellVal = Number(item.sellingPrice) || mrpVal;

    // Price range filters
    if (numMinPrice !== null && sellVal < numMinPrice) continue;
    if (numMaxPrice !== null && sellVal > numMaxPrice) continue;

    const discountPercent = (mrpVal > 0 && sellVal < mrpVal)
      ? Math.round(((mrpVal - sellVal) / mrpVal) * 100)
      : 0;

    const unitPriceCalc = computeUnitPrice(sellVal, item.qnty);
    const unitPrice = unitPriceCalc ? unitPriceCalc.unitPrice : 0;
    const unitMeasure = unitPriceCalc ? unitPriceCalc.unitMeasure : '';
    const unitPriceDisplay = unitPriceCalc ? unitPriceCalc.unitPriceDisplay : '';
    const basePricePerUnit = unitPriceCalc ? unitPriceCalc.basePricePerUnit : 0;

    // Unit price bounds filter
    if (numMinUnitPrice !== null && unitPrice < numMinUnitPrice) continue;
    if (numMaxUnitPrice !== null && unitPrice > numMaxUnitPrice) continue;

    processedItems.push({
      ...item,
      sellingPrice: sellVal,
      mrp: mrpVal,
      discountPercent,
      unitPrice,
      unitMeasure,
      unitPriceDisplay,
      basePricePerUnit,
      attributes: attrs,
      _score: score
    });
  }

  // Step 2: Variant Consolidation by `itemGroupId`
  // Group sibling products sharing itemGroupId into consolidated product cards
  const groups = new Map();
  const independentItems = [];

  for (const item of processedItems) {
    const groupId = (item.itemGroupId || '').trim();
    if (groupId) {
      if (!groups.has(groupId)) {
        groups.set(groupId, []);
      }
      groups.get(groupId).push(item);
    } else {
      independentItems.push(item);
    }
  }

  const consolidatedCards = [];

  // Consolidate groups
  for (const [groupId, groupVariants] of groups.entries()) {
    // Sort variants by quantity value or sellingPrice
    groupVariants.sort((a, b) => {
      const qA = parseQuantity(a.qnty);
      const qB = parseQuantity(b.qnty);
      if (qA && qB && qA.unit === qB.unit) {
        return qA.val - qB.val;
      }
      return (a.sellingPrice || 0) - (b.sellingPrice || 0);
    });

    // Use primary variant (e.g. highest relevance score, or first in stock)
    const primary = groupVariants.reduce((best, curr) => {
      if (curr._score > best._score) return curr;
      return best;
    }, groupVariants[0]);

    const variantList = groupVariants.map(v => ({
      _id: v._id || v.productId,
      qnty: v.qnty,
      mrp: v.mrp,
      sellingPrice: v.sellingPrice,
      unitPrice: v.unitPrice,
      unitMeasure: v.unitMeasure,
      unitPriceDisplay: v.unitPriceDisplay,
      discountPercent: v.discountPercent,
      inStock: v.inStock !== false,
      image: v.image,
      emoji: v.emoji
    }));

    consolidatedCards.push({
      ...primary,
      itemGroupId: groupId,
      isMultiVariant: variantList.length > 1,
      variants: variantList
    });
  }

  // Independent items
  for (const item of independentItems) {
    consolidatedCards.push({
      ...item,
      isMultiVariant: false,
      variants: [{
        _id: item._id || item.productId,
        qnty: item.qnty,
        mrp: item.mrp,
        sellingPrice: item.sellingPrice,
        unitPrice: item.unitPrice,
        unitMeasure: item.unitMeasure,
        unitPriceDisplay: item.unitPriceDisplay,
        discountPercent: item.discountPercent,
        inStock: item.inStock !== false,
        image: item.image,
        emoji: item.emoji
      }]
    });
  }

  // Step 3: Sorting
  consolidatedCards.sort((a, b) => {
    switch (sort) {
      case 'price_asc':
        return (a.sellingPrice || 0) - (b.sellingPrice || 0);
      case 'price_desc':
        return (b.sellingPrice || 0) - (a.sellingPrice || 0);
      case 'discount_desc':
        return (b.discountPercent || 0) - (a.discountPercent || 0);
      case 'rating_desc':
        // Sort by featured rank / stock / score
        if ((b.featuredRank ?? 999) !== (a.featuredRank ?? 999)) {
          return (a.featuredRank ?? 999) - (b.featuredRank ?? 999);
        }
        return b._score - a._score;
      case 'relevance':
      default:
        if (b._score !== a._score) return b._score - a._score;
        return (a.name || '').localeCompare(b.name || '');
    }
  });

  // Step 4: Pagination
  const total = consolidatedCards.length;
  const start = (pageNum - 1) * limitNum;
  const paginatedItems = consolidatedCards
    .slice(start, start + limitNum)
    .map(({ _score, ...rest }) => rest);

  return {
    items: paginatedItems,
    total,
    page: pageNum,
    limit: limitNum,
    totalPages: Math.max(1, Math.ceil(total / limitNum)),
    hasMore: start + paginatedItems.length < total
  };
}

module.exports = {
  getAutocompleteSuggestions,
  getCategoryFilters,
  searchProducts,
  resolveThumbnail,
  CURATED_CATEGORY_THUMBNAILS,
  DEFAULT_SORT_OPTIONS
};
