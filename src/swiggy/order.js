/**
 * FOOD ORDERING FLOW ("order me a pizza")
 * ---------------------------------------
 * Deterministic 2-turn state machine, same philosophy as reminders:
 * money-moving actions happen in code, never inside the AI.
 *
 *   Turn 1  prepareOrder(userId, craving)
 *           address → open restaurants → menu → best item → cart
 *           → returns a summary; a PENDING confirmation (2-min TTL)
 *           is parked in memory.
 *   Turn 2  confirmPending(userId)   ← user said "yes"
 *           → place_food_order (COD) → order id + ETA.
 *           cancelPending(userId)    ← user said "no" → cart flushed.
 *
 * Guard rails (Swiggy Builders Club v1):
 *   • COD only, hard ₹1000 cart cap.
 *   • place_food_order is NOT idempotent → on 5xx we check
 *     get_food_orders before ever surfacing a retry.
 *   • Confirmation expires after 2 minutes; a new craving replaces it.
 */
const { callTool } = require("./mcp");

const CAP_RUPEES = 1000;
const CONFIRM_TTL_MS = 120_000;

/** userId → { summary, total, restaurantName, itemName, at } */
const pendingConfirm = new Map();
setInterval(() => {
  const cutoff = Date.now() - CONFIRM_TTL_MS;
  for (const [k, v] of pendingConfirm) if (v.at < cutoff) pendingConfirm.delete(k);
}, 60_000).unref();

const norm = (s) => String(s || "").toLowerCase();

/** Cheap relevance: rating-weighted match of craving words in item name. */
function scoreItem(item, cravingWords) {
  const name = norm(item.name);
  let hits = 0;
  for (const w of cravingWords) if (name.includes(w)) hits++;
  if (hits === 0) return -1;
  const rating = Number(item.rating || item.avgRating || 0);
  return hits * 10 + rating;
}

function firstArray(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (Array.isArray(v) && v.length) return v;
  }
  return Array.isArray(obj) ? obj : [];
}

const rupees = (v) => {
  const n = Number(v || 0);
  return n > 5000 ? Math.round(n / 100) : Math.round(n); // paise-safe
};

/**
 * Build the cart for a craving. Returns { ok, say } where `say` is the
 * exact situation for the AI to voice. Never places the order.
 */
async function prepareOrder(userId, craving) {
  pendingConfirm.delete(userId); // new craving supersedes any old one

  // 1. Address
  const addrRes = await callTool(userId, "get_addresses");
  const addresses = firstArray(addrRes, ["data", "addresses"]);
  if (!addresses.length) {
    return { ok: false, say: "The user has no saved delivery address on Swiggy. Ask them to add one in the Swiggy app first." };
  }
  const addr = addresses.find((a) => norm(a.label) === "home") || addresses[0];

  // 2. Restaurants — only OPEN ones, best rated first
  const restRes = await callTool(userId, "search_restaurants", {
    addressId: addr.id || addr.addressId,
    query: craving,
  });
  const restaurants = firstArray(restRes.data || restRes, ["restaurants", "data"])
    .filter((r) => !r.availabilityStatus || norm(r.availabilityStatus) === "open")
    .sort((a, b) => Number(b.rating || b.avgRating || 0) - Number(a.rating || a.avgRating || 0));
  if (!restaurants.length) {
    return { ok: false, say: `No restaurants serving ${craving} are open near the user right now. Say so with sympathy.` };
  }

  // 3. Best matching item across the top few restaurants (menus fetched in parallel)
  const cravingWords = norm(craving).split(/\s+/).filter((w) => w.length > 2);
  const top = restaurants.slice(0, 3);
  const menus = await Promise.allSettled(
    top.map((r) => callTool(userId, "get_restaurant_menu", { restaurantId: r.id || r.restaurantId }))
  );
  let best = null;
  menus.forEach((m, i) => {
    if (m.status !== "fulfilled") return;
    const data = m.value.data || m.value;
    const items = firstArray(data, ["items", "menu", "menuItems"]);
    for (const item of items) {
      const s = scoreItem(item, cravingWords);
      if (s < 0) continue;
      const price = rupees(item.price || item.defaultPrice);
      if (price > CAP_RUPEES) continue;
      if (!best || s > best.score) {
        best = { score: s, item, price, restaurant: top[i], restaurantId: data.restaurantId || top[i].id || top[i].restaurantId };
      }
    }
  });
  if (!best) {
    return { ok: false, say: `Open restaurants were found but none had a clear ${craving} under rupees ${CAP_RUPEES}. Ask the user to be more specific.` };
  }

  // 4. Cart (server is the source of truth for the total)
  await callTool(userId, "update_food_cart", {
    restaurantId: best.restaurantId,
    items: [{ itemId: best.item.id || best.item.itemId, quantity: 1 }],
  });
  const cartRes = await callTool(userId, "get_food_cart");
  const total = rupees((cartRes.data || cartRes).total);
  if (total > CAP_RUPEES) {
    await callTool(userId, "flush_food_cart").catch(() => {});
    return { ok: false, say: `With delivery the total came to rupees ${total}, above the rupees ${CAP_RUPEES} order limit. Suggest something cheaper.` };
  }

  const restaurantName = best.restaurant.name || "the restaurant";
  const itemName = best.item.name;
  pendingConfirm.set(userId, { restaurantName, itemName, total, at: Date.now() });
  return {
    ok: true,
    say:
      `A cart is READY, NOT yet ordered: ${itemName} from ${restaurantName}, total rupees ${total}, cash on delivery. ` +
      `Tell the user exactly this and ask them to say yes to confirm or no to cancel. Do not claim the order is placed.`,
  };
}

/** True if the user has a live, unexpired confirmation waiting. */
function hasPending(userId) {
  const p = pendingConfirm.get(userId);
  if (!p) return false;
  if (Date.now() - p.at > CONFIRM_TTL_MS) { pendingConfirm.delete(userId); return false; }
  return true;
}

/** The user said YES → place the order for real. */
async function confirmPending(userId) {
  const p = pendingConfirm.get(userId);
  if (!p) return { ok: false, say: "There is no order waiting for confirmation — it may have expired. Offer to start again." };
  pendingConfirm.delete(userId);

  let order;
  try {
    order = await callTool(userId, "place_food_order", { paymentMethod: "COD" });
  } catch (e) {
    // NOT idempotent: a 5xx may still have placed it. Verify before retrying.
    const recent = await callTool(userId, "get_food_orders").catch(() => null);
    const placed = firstArray(recent?.data || recent || {}, ["orders", "data"])
      .find((o) => Date.now() - new Date(o.createdAt || o.orderTime || 0).getTime() < 300_000);
    if (placed) {
      return { ok: true, say: `The order DID go through: ${p.itemName} from ${p.restaurantName}, rupees ${p.total}, cash on delivery. Confirm it cheerfully.` };
    }
    console.error("swiggy place_food_order failed:", e.message);
    return { ok: false, say: "Placing the order failed and no order was created. Apologize and offer to try again." };
  }

  const data = order.data || order;
  const orderId = data.orderId || data.id || "";
  let eta = "";
  if (orderId) {
    const t = await callTool(userId, "track_food_order", { orderId }).catch(() => null);
    const mins = t?.data?.etaMinutes || t?.data?.eta || null;
    if (mins) eta = ` Estimated delivery in about ${mins} minutes.`;
  }
  return {
    ok: true,
    say: `ORDER PLACED: ${p.itemName} from ${p.restaurantName}, rupees ${p.total}, cash on delivery.${eta} Tell the user warmly.`,
  };
}

/** The user said NO → drop the cart. */
async function cancelPending(userId) {
  pendingConfirm.delete(userId);
  await callTool(userId, "flush_food_cart").catch(() => {});
  return { ok: true, say: "Order cancelled before placing, cart cleared. Acknowledge briefly." };
}

module.exports = { prepareOrder, hasPending, confirmPending, cancelPending };
