/**
 * WEATHER TOOL — Open-Meteo (free, no API key).
 * Used by the /chat intent layer ("what's the weather") and the app's
 * Today screen (GET /tools/weather). 10-minute in-memory cache.
 */
const TIMEOUT = 8000;
const cache = new Map(); // key → { ts, data }
const TTL = 10 * 60 * 1000;

const WMO = {
  0: "clear sky", 1: "mostly clear", 2: "partly cloudy", 3: "overcast",
  45: "fog", 48: "rime fog", 51: "light drizzle", 53: "drizzle",
  55: "heavy drizzle", 61: "light rain", 63: "rain", 65: "heavy rain",
  66: "freezing rain", 67: "freezing rain", 71: "light snow", 73: "snow",
  75: "heavy snow", 77: "snow grains", 80: "light showers", 81: "showers",
  82: "violent showers", 85: "snow showers", 86: "snow showers",
  95: "thunderstorm", 96: "thunderstorm with hail", 99: "thunderstorm with hail",
};

async function getJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT) });
  if (!r.ok) throw new Error(`weather ${r.status}`);
  return r.json();
}

async function geocodeCity(name) {
  const key = `geo:${name.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < 24 * 3600_000) return hit.data;
  const j = await getJson(
    "https://geocoding-api.open-meteo.com/v1/search?count=1&name=" +
      encodeURIComponent(name)
  );
  const g = j.results?.[0];
  if (!g) return null;
  const data = {
    lat: g.latitude, lng: g.longitude,
    label: [g.name, g.admin1, g.country].filter(Boolean).join(", "),
  };
  cache.set(key, { ts: Date.now(), data });
  return data;
}

/**
 * @param {{lat?:number,lng?:number,city?:string}} where
 * @returns {Promise<object|null>} { label, current:{...}, days:[...] }
 */
async function getWeather(where) {
  let lat = where.lat, lng = where.lng, label = where.city || null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    if (!where.city) return null;
    const g = await geocodeCity(where.city);
    if (!g) return null;
    ({ lat, lng, label } = g);
  }

  const key = `wx:${lat.toFixed(2)},${lng.toFixed(2)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < TTL) return { ...hit.data, label: label || hit.data.label };

  const j = await getJson(
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
      "&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m" +
      "&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code" +
      "&timezone=auto&forecast_days=3"
  );

  const data = {
    label: label || `${lat.toFixed(2)}, ${lng.toFixed(2)}`,
    current: {
      tempC: j.current?.temperature_2m,
      feelsC: j.current?.apparent_temperature,
      humidity: j.current?.relative_humidity_2m,
      windKmh: j.current?.wind_speed_10m,
      condition: WMO[j.current?.weather_code] || "unknown",
    },
    days: (j.daily?.time || []).map((date, i) => ({
      date,
      maxC: j.daily.temperature_2m_max?.[i],
      minC: j.daily.temperature_2m_min?.[i],
      rainChance: j.daily.precipitation_probability_max?.[i],
      condition: WMO[j.daily.weather_code?.[i]] || "unknown",
    })),
  };
  cache.set(key, { ts: Date.now(), data });
  return data;
}

/** One-paragraph plain text for the AI context. */
function describe(w) {
  if (!w) return "";
  const c = w.current;
  const today = w.days[0], tomorrow = w.days[1];
  let s =
    `Weather in ${w.label} right now: ${c.condition}, ${c.tempC}°C ` +
    `(feels like ${c.feelsC}°C), humidity ${c.humidity}%, wind ${c.windKmh} km/h.`;
  if (today) s += ` Today: ${today.condition}, ${today.minC}–${today.maxC}°C, ${today.rainChance}% chance of rain.`;
  if (tomorrow) s += ` Tomorrow: ${tomorrow.condition}, ${tomorrow.minC}–${tomorrow.maxC}°C, ${tomorrow.rainChance}% rain.`;
  return s;
}

module.exports = { getWeather, describe };
