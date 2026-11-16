const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeUnit,
  parseQuantity,
  computeUnitPrice,
  formatUnitPriceDisplay
} = require('../utils/unitPriceCalculator');

describe('UnitPriceCalculator Unit Tests', () => {
  describe('normalizeUnit', () => {
    it('normalizes gram variations to "g"', () => {
      assert.strictEqual(normalizeUnit('g'), 'g');
      assert.strictEqual(normalizeUnit('gm'), 'g');
      assert.strictEqual(normalizeUnit('gms'), 'g');
      assert.strictEqual(normalizeUnit('gram'), 'g');
      assert.strictEqual(normalizeUnit('grams'), 'g');
      assert.strictEqual(normalizeUnit('  GMS  '), 'g');
    });

    it('normalizes kilogram variations to "kg"', () => {
      assert.strictEqual(normalizeUnit('kg'), 'kg');
      assert.strictEqual(normalizeUnit('kgs'), 'kg');
      assert.strictEqual(normalizeUnit('kilo'), 'kg');
      assert.strictEqual(normalizeUnit('kilogram'), 'kg');
    });

    it('normalizes milliliter variations to "ml"', () => {
      assert.strictEqual(normalizeUnit('ml'), 'ml');
      assert.strictEqual(normalizeUnit('mls'), 'ml');
      assert.strictEqual(normalizeUnit('milliliter'), 'ml');
    });

    it('normalizes liter variations to "l"', () => {
      assert.strictEqual(normalizeUnit('l'), 'l');
      assert.strictEqual(normalizeUnit('lt'), 'l');
      assert.strictEqual(normalizeUnit('ltr'), 'l');
      assert.strictEqual(normalizeUnit('liter'), 'l');
      assert.strictEqual(normalizeUnit('litre'), 'l');
    });

    it('normalizes piece/pack/unit variations to "pc"', () => {
      assert.strictEqual(normalizeUnit('pc'), 'pc');
      assert.strictEqual(normalizeUnit('pcs'), 'pc');
      assert.strictEqual(normalizeUnit('piece'), 'pc');
      assert.strictEqual(normalizeUnit('pieces'), 'pc');
      assert.strictEqual(normalizeUnit('unit'), 'pc');
      assert.strictEqual(normalizeUnit('units'), 'pc');
      assert.strictEqual(normalizeUnit('pack'), 'pc');
      assert.strictEqual(normalizeUnit('packs'), 'pc');
      assert.strictEqual(normalizeUnit('tablet'), 'pc');
    });

    it('returns null for unknown units', () => {
      assert.strictEqual(normalizeUnit('inches'), null);
      assert.strictEqual(normalizeUnit(null), null);
      assert.strictEqual(normalizeUnit(''), null);
    });
  });

  describe('parseQuantity', () => {
    it('parses standard weight formats', () => {
      assert.deepStrictEqual(parseQuantity('125 g'), { val: 125, unit: 'g' });
      assert.deepStrictEqual(parseQuantity('100g'), { val: 100, unit: 'g' });
      assert.deepStrictEqual(parseQuantity('1 kg'), { val: 1, unit: 'kg' });
      assert.deepStrictEqual(parseQuantity('1.5 kg'), { val: 1.5, unit: 'kg' });
      assert.deepStrictEqual(parseQuantity('500 gm'), { val: 500, unit: 'g' });
    });

    it('parses volume formats', () => {
      assert.deepStrictEqual(parseQuantity('500 ml'), { val: 500, unit: 'ml' });
      assert.deepStrictEqual(parseQuantity('1 L'), { val: 1, unit: 'l' });
      assert.deepStrictEqual(parseQuantity('1.75 LTR'), { val: 1.75, unit: 'l' });
    });

    it('parses count/piece formats', () => {
      assert.deepStrictEqual(parseQuantity('1 pc'), { val: 1, unit: 'pc' });
      assert.deepStrictEqual(parseQuantity('6 pieces'), { val: 6, unit: 'pc' });
      assert.deepStrictEqual(parseQuantity('10 units'), { val: 10, unit: 'pc' });
    });

    it('parses composite and parenthesized quantity strings', () => {
      assert.deepStrictEqual(parseQuantity('1 pack (200 g)'), { val: 200, unit: 'g' });
      assert.deepStrictEqual(parseQuantity('Bottle (500 ml)'), { val: 500, unit: 'ml' });
      assert.deepStrictEqual(parseQuantity('Pouch (1 kg)'), { val: 1, unit: 'kg' });
    });

    it('parses multiplier quantity strings', () => {
      assert.deepStrictEqual(parseQuantity('2 x 100 g'), { val: 200, unit: 'g' });
      assert.deepStrictEqual(parseQuantity('3 x 500 ml'), { val: 1500, unit: 'ml' });
    });

    it('returns null for non-parsable or invalid inputs', () => {
      assert.strictEqual(parseQuantity(null), null);
      assert.strictEqual(parseQuantity(''), null);
      assert.strictEqual(parseQuantity('No quantity here'), null);
      assert.strictEqual(parseQuantity('0 g'), null);
    });
  });

  describe('computeUnitPrice', () => {
    it('accurately computes 125 g at ₹148 to ₹118/100 g (Reference Design Target)', () => {
      const res = computeUnitPrice(148, '125 g');
      assert.ok(res);
      assert.strictEqual(res.unitPrice, 118);
      assert.strictEqual(res.unitMeasure, '100 g');
      assert.strictEqual(res.unitPriceDisplay, '₹118/100 g');
    });

    it('accurately computes 100 g at ₹140 to ₹140/100 g (Reference Design Target)', () => {
      const res = computeUnitPrice(140, '100 g');
      assert.ok(res);
      assert.strictEqual(res.unitPrice, 140);
      assert.strictEqual(res.unitMeasure, '100 g');
      assert.strictEqual(res.unitPriceDisplay, '₹140/100 g');
    });

    it('accurately computes 1 kg at ₹171 to ₹171/kg (Reference Design Target)', () => {
      const res = computeUnitPrice(171, '1 kg');
      assert.ok(res);
      assert.strictEqual(res.unitPrice, 171);
      assert.strictEqual(res.unitMeasure, 'kg');
      assert.strictEqual(res.unitPriceDisplay, '₹171/kg');
    });

    it('normalizes gram quantities >= 1000 g to kg pricing', () => {
      const res = computeUnitPrice(200, '1000 g');
      assert.ok(res);
      assert.strictEqual(res.unitPrice, 200);
      assert.strictEqual(res.unitMeasure, 'kg');
      assert.strictEqual(res.unitPriceDisplay, '₹200/kg');
    });

    it('accurately computes volume pricing under 1000 ml to 100 ml base', () => {
      const res = computeUnitPrice(30, '500 ml');
      assert.ok(res);
      assert.strictEqual(res.unitPrice, 6);
      assert.strictEqual(res.unitMeasure, '100 ml');
      assert.strictEqual(res.unitPriceDisplay, '₹6/100 ml');
    });

    it('accurately computes volume pricing for Liters', () => {
      const res = computeUnitPrice(120, '2 L');
      assert.ok(res);
      assert.strictEqual(res.unitPrice, 60);
      assert.strictEqual(res.unitMeasure, 'L');
      assert.strictEqual(res.unitPriceDisplay, '₹60/L');
    });

    it('accurately computes piece pricing', () => {
      const res = computeUnitPrice(50, '2 pcs');
      assert.ok(res);
      assert.strictEqual(res.unitPrice, 25);
      assert.strictEqual(res.unitMeasure, 'pc');
      assert.strictEqual(res.unitPriceDisplay, '₹25/pc');
    });

    it('returns null on invalid price or invalid quantity', () => {
      assert.strictEqual(computeUnitPrice(0, '100 g'), null);
      assert.strictEqual(computeUnitPrice(-50, '100 g'), null);
      assert.strictEqual(computeUnitPrice('invalid', '100 g'), null);
      assert.strictEqual(computeUnitPrice(100, null), null);
      assert.strictEqual(computeUnitPrice(100, 'unknown'), null);
    });
  });

  describe('formatUnitPriceDisplay', () => {
    it('formats price and measure correctly', () => {
      assert.strictEqual(formatUnitPriceDisplay(118, '100 g'), '₹118/100 g');
      assert.strictEqual(formatUnitPriceDisplay(171, 'kg'), '₹171/kg');
    });

    it('returns empty string on falsy or invalid price', () => {
      assert.strictEqual(formatUnitPriceDisplay(null, 'kg'), '');
      assert.strictEqual(formatUnitPriceDisplay(NaN, 'kg'), '');
      assert.strictEqual(formatUnitPriceDisplay(100, ''), '');
    });
  });
});
