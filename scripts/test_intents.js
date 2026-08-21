const { buildToolContext } = require("../src/services/intents");

async function testIntents() {
  console.log("=== Testing Intent Layer for Astrology & Lucky Day ===");
  const res1 = await buildToolContext({
    userId: null,
    messages: [{ role: "user", content: "What is my horoscope and is today my lucky day?" }],
    tzOffsetMin: 330,
  });
  console.log("Astrology intent block:\n", res1.block);
  console.log("Sources:", res1.sources);

  console.log("\n=== Testing Intent Layer for Morning Briefing ===");
  const res2 = await buildToolContext({
    userId: null,
    messages: [{ role: "user", content: "Good morning briefing" }],
    tzOffsetMin: 330,
  });
  console.log("Briefing intent block:\n", res2.block);
}

testIntents().catch(console.error);
