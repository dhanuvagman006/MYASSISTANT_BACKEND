/**
 * UNIT CONVERSION (C4) — fully deterministic, zero network, zero AI cost.
 * Parses "convert 5 km to miles", "how many pounds is 70 kg",
 * "10 feet in meters", "98.6 f to c" and returns an exact answer block.
 *
 * Linear units share one table (factor to a base unit per dimension);
 * temperature is affine and handled separately. O(1) lookups via a
 * prebuilt alias map — safe at any traffic level.
 */

// base units: length=m, mass=kg, volume=l, area=m2, speed=mps, data=byte
const UNITS = {
  // length (base: metre)
  mm: { d: "length", f: 0.001, name: "millimetres" },
  cm: { d: "length", f: 0.01, name: "centimetres" },
  m: { d: "length", f: 1, name: "metres" },
  km: { d: "length", f: 1000, name: "kilometres" },
  in: { d: "length", f: 0.0254, name: "inches" },
  ft: { d: "length", f: 0.3048, name: "feet" },
  yd: { d: "length", f: 0.9144, name: "yards" },
  mi: { d: "length", f: 1609.344, name: "miles" },
  // mass (base: kg)
  mg: { d: "mass", f: 1e-6, name: "milligrams" },
  g: { d: "mass", f: 0.001, name: "grams" },
  kg: { d: "mass", f: 1, name: "kilograms" },
  t: { d: "mass", f: 1000, name: "tonnes" },
  oz: { d: "mass", f: 0.028349523125, name: "ounces" },
  lb: { d: "mass", f: 0.45359237, name: "pounds" },
  st: { d: "mass", f: 6.35029318, name: "stone" },
  // volume (base: litre)
  ml: { d: "volume", f: 0.001, name: "millilitres" },
  l: { d: "volume", f: 1, name: "litres" },
  gal: { d: "volume", f: 3.785411784, name: "gallons (US)" },
  floz: { d: "volume", f: 0.0295735, name: "fluid ounces" },
  cup: { d: "volume", f: 0.2365882365, name: "cups" },
  // area (base: m²) — includes Indian land units
  sqft: { d: "area", f: 0.09290304, name: "square feet" },
  sqm: { d: "area", f: 1, name: "square metres" },
  acre: { d: "area", f: 4046.8564224, name: "acres" },
  hectare: { d: "area", f: 10000, name: "hectares" },
  cent: { d: "area", f: 40.468564224, name: "cents" },
  gunta: { d: "area", f: 101.171, name: "guntas" },
  // speed (base: m/s)
  kmph: { d: "speed", f: 1 / 3.6, name: "km/h" },
  mph: { d: "speed", f: 0.44704, name: "miles/h" },
  knot: { d: "speed", f: 0.514444, name: "knots" },
  // data (base: byte)
  kb: { d: "data", f: 1e3, name: "KB" },
  mb: { d: "data", f: 1e6, name: "MB" },
  gb: { d: "data", f: 1e9, name: "GB" },
  tb: { d: "data", f: 1e12, name: "TB" },
};

const ALIASES = {
  millimetre: "mm", millimeter: "mm", millimetres: "mm", millimeters: "mm",
  centimetre: "cm", centimeter: "cm", centimetres: "cm", centimeters: "cm", cms: "cm",
  metre: "m", meter: "m", metres: "m", meters: "m",
  kilometre: "km", kilometer: "km", kilometres: "km", kilometers: "km", kms: "km",
  inch: "in", inches: "in", "\"": "in",
  foot: "ft", feet: "ft", "'": "ft",
  yard: "yd", yards: "yd",
  mile: "mi", miles: "mi",
  milligram: "mg", milligrams: "mg",
  gram: "g", grams: "g", gm: "g", gms: "g",
  kilogram: "kg", kilograms: "kg", kilo: "kg", kilos: "kg", kgs: "kg",
  tonne: "t", tonnes: "t", ton: "t", tons: "t",
  ounce: "oz", ounces: "oz",
  pound: "lb", pounds: "lb", lbs: "lb",
  stone: "st", stones: "st",
  millilitre: "ml", milliliter: "ml", millilitres: "ml", milliliters: "ml",
  litre: "l", liter: "l", litres: "l", liters: "l", ltr: "l", ltrs: "l",
  gallon: "gal", gallons: "gal",
  "fluid ounce": "floz", "fluid ounces": "floz", "fl oz": "floz",
  cups: "cup",
  "square foot": "sqft", "square feet": "sqft", "sq ft": "sqft", sft: "sqft",
  "square metre": "sqm", "square meter": "sqm", "square metres": "sqm",
  "square meters": "sqm", "sq m": "sqm",
  acres: "acre", hectares: "hectare", cents: "cent", guntas: "gunta", guntha: "gunta",
  "km/h": "kmph", kph: "kmph", "kilometers per hour": "kmph", "kilometres per hour": "kmph",
  "miles per hour": "mph", "m/h": "mph",
  knots: "knot",
  kilobyte: "kb", kilobytes: "kb", megabyte: "mb", megabytes: "mb",
  gigabyte: "gb", gigabytes: "gb", terabyte: "tb", terabytes: "tb",
  celsius: "c", centigrade: "c", "°c": "c", fahrenheit: "f", "°f": "f", kelvin: "k",
};

// longest-first so "square feet" wins over "feet"
const ALL_NAMES = [...Object.keys(ALIASES), ...Object.keys(UNITS), "c", "f", "k"]
  .sort((a, b) => b.length - a.length)
  .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .join("|");

const ASK = new RegExp(
  "(?:convert\\s+)?(-?\\d+(?:[.,]\\d+)?)\\s*(" + ALL_NAMES + ")\\b" +
    "\\s*(?:to|in|into|as|=|is how many|equals?)\\s*(" + ALL_NAMES + ")\\b",
  "i"
);
const ASK_REV = new RegExp(
  "how (?:many|much)\\s+(" + ALL_NAMES + ")\\b.{0,12}?" +
    "(-?\\d+(?:[.,]\\d+)?)\\s*(" + ALL_NAMES + ")\\b",
  "i"
);

const canon = (s) => {
  const k = s.toLowerCase().trim();
  return ALIASES[k] || k;
};

function convertTemp(v, from, to) {
  let c;
  if (from === "c") c = v;
  else if (from === "f") c = (v - 32) * (5 / 9);
  else if (from === "k") c = v - 273.15;
  else return null;
  if (to === "c") return c;
  if (to === "f") return c * (9 / 5) + 32;
  if (to === "k") return c + 273.15;
  return null;
}

const TEMP_NAME = { c: "°C", f: "°F", k: "K" };

function round(n) {
  const r = Math.abs(n) >= 100 ? Math.round(n * 100) / 100 : Math.round(n * 10000) / 10000;
  return String(r);
}

/**
 * @returns {string|null} a TOOL RESULT sentence, or null when the message
 * is not a unit-conversion question. Never throws.
 */
function parseAndConvert(msg) {
  try {
    let amount, fromRaw, toRaw;
    let m = ASK.exec(msg);
    if (m) [, amount, fromRaw, toRaw] = m;
    else {
      m = ASK_REV.exec(msg); // "how many pounds is 70 kg"
      if (!m) return null;
      [, toRaw, amount, fromRaw] = m;
    }
    const v = parseFloat(String(amount).replace(",", "."));
    if (!Number.isFinite(v)) return null;
    const from = canon(fromRaw);
    const to = canon(toRaw);
    if (from === to) return null;

    // temperature (affine)
    if ("cfk".includes(from) && "cfk".includes(to) && from.length === 1 && to.length === 1) {
      const out = convertTemp(v, from, to);
      if (out === null) return null;
      return `${v} ${TEMP_NAME[from]} = ${round(out)} ${TEMP_NAME[to]}.`;
    }

    const uf = UNITS[from];
    const ut = UNITS[to];
    if (!uf || !ut || uf.d !== ut.d) return null; // unknown or mixed dimensions
    const out = (v * uf.f) / ut.f;
    return `${v} ${uf.name} = ${round(out)} ${ut.name}.`;
  } catch {
    return null;
  }
}

module.exports = { parseAndConvert };
