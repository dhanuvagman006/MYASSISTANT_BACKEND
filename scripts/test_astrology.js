const astro = require("../src/services/tools/astrology");

async function test() {
  console.log("=== Testing Zodiac Signs ===");
  console.log("1995-08-15 ->", astro.getZodiacSign("1995-08-15")?.name, "(Expected: Leo)");
  console.log("2000-03-25 ->", astro.getZodiacSign("2000-03-25")?.name, "(Expected: Aries)");
  console.log("1998-11-05 ->", astro.getZodiacSign("1998-11-05")?.name, "(Expected: Scorpio)");
  console.log("1992-01-10 ->", astro.getZodiacSign("1992-01-10")?.name, "(Expected: Capricorn)");

  console.log("\n=== Testing Astrology Reading with FreeAstrologyAPI ===");
  const reading = await astro.getAstrologyReading({
    birthday: "1998-11-05",
    name: "Allen",
  });

  console.log("Reading result:", JSON.stringify(reading, null, 2));
  console.log("\n=== Formatted Spoken / AI Context Description ===");
  console.log(astro.describeAstrology(reading, "Allen"));
}

test().catch(console.error);
