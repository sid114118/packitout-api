/**
 * PackItOut - Unit Price Calculator Utility
 * Normalizes item quantities and computes standardized unit prices
 * (e.g. ₹118/100 g, ₹171/kg, ₹6/100 ml, ₹60/L, ₹25/pc).
 */

/**
 * Normalizes a unit string to standard forms:
 * 'g', 'kg', 'ml', 'l', 'pc'
 */
function normalizeUnit(unitStr) {
  if (!unitStr) return null;
  const u = String(unitStr).toLowerCase().trim();

  if (['g', 'gm', 'gms', 'gram', 'grams'].includes(u)) return 'g';
  if (['kg', 'kgs', 'kilo', 'kilogram', 'kilograms'].includes(u)) return 'kg';
  if (['ml', 'mls', 'milliliter', 'millilitre', 'milliliters', 'millilitres'].includes(u)) return 'ml';
  if (['l', 'lt', 'ltr', 'liter', 'litre', 'liters', 'litres'].includes(u)) return 'l';
  if (['pc', 'pcs', 'piece', 'pieces', 'unit', 'units', 'pack', 'packs', 'tablet', 'tablets', 'capsule', 'capsules', 'sachet', 'sachets'].includes(u)) return 'pc';

  return null;
}

/**
 * Parses a freeform quantity string into numeric value and normalized unit.
 * Handles patterns such as:
 * - "125 g", "100g", "1.5 kg"
 * - "500 ml", "1 L", "1.75 L"
 * - "1 pc", "2 pieces", "10 units"
 * - "1 pack (200 g)", "pack of 2 (100 ml)"
 *
 * @param {string} qntyStr
 * @returns {{ val: number, unit: string } | null}
 */
function parseQuantity(qntyStr) {
  if (!qntyStr) return null;
  const str = String(qntyStr).toLowerCase().trim();
  if (!str) return null;

  // 1. Check for weight/volume specified inside parentheses first, e.g. "1 pack (200 g)"
  const parenMatch = str.match(/\(([^)]+)\)/);
  if (parenMatch) {
    const inside = parenMatch[1].trim();
    const insideMatch = inside.match(/([0-9]+(?:\.[0-9]+)?)\s*(kg|kgs|gm|gms|g|ml|mls|ltr|lt|l|pcs|pc|units|unit|pack|packs|tablets|tablet)\b/);
    if (insideMatch) {
      const val = parseFloat(insideMatch[1]);
      const unit = normalizeUnit(insideMatch[2]);
      if (!isNaN(val) && val > 0 && unit) {
        return { val, unit };
      }
    }
  }

  // 2. Multiplier pattern like "2 x 100 g" or "2x100g"
  const multiMatch = str.match(/([0-9]+(?:\.[0-9]+)?)\s*[xX*]\s*([0-9]+(?:\.[0-9]+)?)\s*(kg|kgs|gm|gms|g|ml|mls|ltr|lt|l|pcs|pc)\b/);
  if (multiMatch) {
    const count = parseFloat(multiMatch[1]);
    const size = parseFloat(multiMatch[2]);
    const unit = normalizeUnit(multiMatch[3]);
    if (!isNaN(count) && !isNaN(size) && count > 0 && size > 0 && unit) {
      return { val: count * size, unit };
    }
  }

  // 3. Standard "125 g", "1 kg", "500 ml", "1 pc"
  const stdMatch = str.match(/([0-9]+(?:\.[0-9]+)?)\s*(kg|kgs|gm|gms|gram|grams|g|ml|mls|ltr|lt|liter|litre|l|pcs|piece|pieces|pc|units|unit|tablets|tablet|pack|packs|sachet|sachets)\b/);
  if (stdMatch) {
    const val = parseFloat(stdMatch[1]);
    const unit = normalizeUnit(stdMatch[2]);
    if (!isNaN(val) && val > 0 && unit) {
      return { val, unit };
    }
  }

  return null;
}

/**
 * Formats unit price and unit measure into a user-facing string.
 * e.g. formatUnitPriceDisplay(118, "100 g") -> "₹118/100 g"
 *
 * @param {number} unitPrice
 * @param {string} unitMeasure
 * @returns {string}
 */
function formatUnitPriceDisplay(unitPrice, unitMeasure) {
  if (unitPrice === null || unitPrice === undefined || isNaN(unitPrice) || !unitMeasure) {
    return '';
  }
  return `₹${unitPrice}/${unitMeasure}`;
}

/**
 * Computes standardized unit price given a selling price and quantity string.
 * Follows the reference design:
 * - Grams (< 1000 g): formatted per "100 g", e.g. 125 g @ ₹148 -> ₹118/100 g, 100 g @ ₹140 -> ₹140/100 g
 * - Kilograms (or >= 1000 g): formatted per "kg", e.g. 1 kg @ ₹171 -> ₹171/kg
 * - Milliliters (< 1000 ml): formatted per "100 ml", e.g. 500 ml @ ₹30 -> ₹6/100 ml
 * - Liters (or >= 1000 ml): formatted per "L", e.g. 1 L @ ₹60 -> ₹60/L
 * - Pieces/units: formatted per "pc", e.g. 1 pc @ ₹25 -> ₹25/pc
 *
 * @param {number} price - Selling price or MRP
 * @param {string} qntyStr - Quantity description
 * @returns {{
 *   unitPrice: number,
 *   unitMeasure: string,
 *   unitPriceDisplay: string,
 *   basePricePerUnit: number
 * } | null}
 */
function computeUnitPrice(price, qntyStr) {
  const numericPrice = Number(price);
  if (isNaN(numericPrice) || numericPrice <= 0) return null;

  const parsed = parseQuantity(qntyStr);
  if (!parsed) return null;

  const { val, unit } = parsed;

  if (unit === 'g') {
    if (val >= 1000) {
      const kg = val / 1000;
      const pricePerKg = Math.round(numericPrice / kg);
      return {
        unitPrice: pricePerKg,
        unitMeasure: 'kg',
        unitPriceDisplay: formatUnitPriceDisplay(pricePerKg, 'kg'),
        basePricePerUnit: numericPrice / val // price per gram
      };
    } else {
      const pricePer100g = Math.round((numericPrice / val) * 100);
      return {
        unitPrice: pricePer100g,
        unitMeasure: '100 g',
        unitPriceDisplay: formatUnitPriceDisplay(pricePer100g, '100 g'),
        basePricePerUnit: numericPrice / val
      };
    }
  }

  if (unit === 'kg') {
    const pricePerKg = Math.round(numericPrice / val);
    return {
      unitPrice: pricePerKg,
      unitMeasure: 'kg',
      unitPriceDisplay: formatUnitPriceDisplay(pricePerKg, 'kg'),
      basePricePerUnit: numericPrice / (val * 1000)
    };
  }

  if (unit === 'ml') {
    if (val >= 1000) {
      const l = val / 1000;
      const pricePerL = Math.round(numericPrice / l);
      return {
        unitPrice: pricePerL,
        unitMeasure: 'L',
        unitPriceDisplay: formatUnitPriceDisplay(pricePerL, 'L'),
        basePricePerUnit: numericPrice / val // price per ml
      };
    } else {
      const pricePer100ml = Math.round((numericPrice / val) * 100);
      return {
        unitPrice: pricePer100ml,
        unitMeasure: '100 ml',
        unitPriceDisplay: formatUnitPriceDisplay(pricePer100ml, '100 ml'),
        basePricePerUnit: numericPrice / val
      };
    }
  }

  if (unit === 'l') {
    const pricePerL = Math.round(numericPrice / val);
    return {
      unitPrice: pricePerL,
      unitMeasure: 'L',
      unitPriceDisplay: formatUnitPriceDisplay(pricePerL, 'L'),
      basePricePerUnit: numericPrice / (val * 1000)
    };
  }

  if (unit === 'pc') {
    const pricePerPc = Math.round(numericPrice / val);
    return {
      unitPrice: pricePerPc,
      unitMeasure: 'pc',
      unitPriceDisplay: formatUnitPriceDisplay(pricePerPc, 'pc'),
      basePricePerUnit: numericPrice / val
    };
  }

  return null;
}

module.exports = {
  normalizeUnit,
  parseQuantity,
  computeUnitPrice,
  formatUnitPriceDisplay,
};
