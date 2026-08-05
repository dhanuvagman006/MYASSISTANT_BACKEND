/**
 * SEMANTIC MEMORY UNIT TEST — no network, no database.
 * Verifies the pure logic behind relevance-ranked recall:
 *   1. cosine() math and NaN/shape safety
 *   2. normalize() produces unit vectors
 *   3. rankMemories() orders by relevance, keeps embedding-less rows LAST
 *      (never lost), and is a no-op without a query vector
 *   4. embedText() honors the test seam (deterministic fake embedder)
 * Run: node scripts/memory-semantic-test.js
 */
const assert = require("assert");
const {
  cosine,
  normalize,
  rankMemories,
  embedText,
  setEmbedderForTests,
} = require("../src/memory/embeddings");

let passed = 0;
function ok(name, fn) {
  fn();
  passed++;
  console.log("  ✓", name);
}

console.log("memory-semantic-test");

ok("cosine of identical unit vectors is 1", () => {
  const v = normalize([3, 4]);
  assert(Math.abs(cosine(v, v) - 1) < 1e-9);
});

ok("cosine of orthogonal vectors is 0", () => {
  assert(Math.abs(cosine([1, 0], [0, 1])) < 1e-9);
});

ok("cosine is safe on bad shapes", () => {
  assert.strictEqual(cosine([1, 0], [1]), -1);
  assert.strictEqual(cosine(null, [1]), -1);
});

ok("normalize returns unit length and rejects zero vectors", () => {
  const v = normalize([0.5, 0.5, 0.5, 0.5]);
  const len = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  assert(Math.abs(len - 1) < 1e-9);
  assert.strictEqual(normalize([0, 0, 0]), null);
});

ok("rankMemories puts the relevant fact first", () => {
  const rows = [
    { key: "favorite_food", value: "masala dosa", embedding: [1, 0, 0] },
    { key: "doctor_name", value: "Dr. Rao", embedding: [0, 1, 0] },
    { key: "car_model", value: "Nexon EV", embedding: JSON.stringify([0, 0, 1]) },
  ];
  const q = [0.05, 0.99, 0.05]; // "who is my doctor?"
  const ranked = rankMemories(rows, normalize(q));
  assert.strictEqual(ranked[0].key, "doctor_name");
  // JSON-string embeddings are parsed and ranked too
  assert(ranked.map((r) => r.key).includes("car_model"));
});

ok("rows without embeddings sort last but are never dropped", () => {
  const rows = [
    { key: "old_fact", value: "no vector yet", embedding: null },
    { key: "relevant", value: "x", embedding: [1, 0] },
  ];
  const ranked = rankMemories(rows, [1, 0]);
  assert.strictEqual(ranked.length, 2);
  assert.strictEqual(ranked[0].key, "relevant");
  assert.strictEqual(ranked[1].key, "old_fact");
});

ok("rankMemories without a query vector returns rows unchanged", () => {
  const rows = [{ key: "a" }, { key: "b" }];
  assert.deepStrictEqual(rankMemories(rows, null).map((r) => r.key), ["a", "b"]);
});

(async () => {
  // Deterministic fake: vector depends only on which word the text contains.
  setEmbedderForTests(async (text) =>
    text.includes("biryani") ? [1, 0, 0] : [0, 1, 0]
  );
  const food = await embedText("I love biryani");
  const other = await embedText("weather today");
  assert(cosine(food, [1, 0, 0]) > 0.99);
  assert(cosine(food, other) < 0.01);
  passed++;
  console.log("  ✓ embedText test seam produces rankable vectors");

  console.log(`memory-semantic-test: ${passed}/8 passed`);
})();
