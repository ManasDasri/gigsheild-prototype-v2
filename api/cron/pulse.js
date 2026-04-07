// api/cron/pulse.js
// Layer 1 — Pulse Monitor
// Runs every 5 minutes via Vercel cron job.
// Fetches live weather + AQI for all 6 cities.
// Stores readings in Redis rolling lists.
// Computes velocity/acceleration. Wakes analyse.js when needed.
//
// Env vars:
//   WEATHERAPI_KEY, WAQI_TOKEN (or use CPCB/OpenAQ as fallback)
//   UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
//   GROQ_API_KEY (used by analyse.js, not here)
//   CRON_SECRET (optional — set in Vercel cron header for security)

import redis from '../lib/redis.js';
import { computeVelocity, shouldWakeAI, getSignalThreshold } from '../lib/velocity.js';
import { getEffectiveThreshold } from '../lib/memory.js';

const CITIES = ['Bengaluru', 'Chennai', 'Mumbai', 'Hyderabad', 'Delhi', 'Pune'];
const MAX_READINGS = 36; // 3 hours of 5-min readings

// WeatherAPI city query strings
const CITY_QUERIES = {
  Bengaluru: 'Bangalore,India',
  Chennai: 'Chennai,India',
  Mumbai: 'Mumbai,India',
  Hyderabad: 'Hyderabad,India',
  Delhi: 'New Delhi,India',
  Pune: 'Pune,India'
};

// WAQI station IDs for India cities (used for AQI if available)
const WAQI_STATIONS = {
  Bengaluru: '@7021',
  Chennai: '@4327',
  Mumbai: '@3119',
  Hyderabad: '@4328',
  Delhi: '@7025',
  Pune: '@8330'
};

function analyseUrl(req) {
  const host = req.headers.host || 'localhost:3000';
  const proto = host.includes('localhost') ? 'http' : 'https';
  return `${proto}://${host}/api/cron/analyse`;
}

export default async function handler(req, res) {
  // Validate cron secret if set
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers['x-cron-secret'] !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const wKey = process.env.WEATHERAPI_KEY;
  if (!wKey) return res.status(500).json({ error: 'WEATHERAPI_KEY not set.' });

  const results = [];
  const wakeCallsMade = [];

  for (const city of CITIES) {
    try {
      // ── Fetch weather ─────────────────────────────────────────
      const wUrl = `https://api.weatherapi.com/v1/current.json?key=${wKey}&q=${encodeURIComponent(CITY_QUERIES[city])}&aqi=no`;
      const wRes = await fetch(wUrl);
      const wData = await wRes.json();

      if (wData.error) throw new Error('WeatherAPI: ' + wData.error.message);

      const rain = parseFloat((wData.current.precip_mm || 0).toFixed(1));
      const temp = Math.round(wData.current.temp_c);
      const wind = wData.current.wind_kph;

      // ── Fetch AQI ─────────────────────────────────────────────
      let aqi = null;
      try {
        const waqiToken = process.env.WAQI_TOKEN;
        if (waqiToken) {
          const aRes = await fetch(`https://api.waqi.info/feed/${WAQI_STATIONS[city]}/?token=${waqiToken}`);
          const aData = await aRes.json();
          if (aData.status === 'ok' && aData.data && aData.data.aqi) {
            aqi = parseInt(aData.data.aqi);
          }
        }
        // Fallback: OpenAQ
        if (aqi === null) {
          const oRes = await fetch(`https://api.openaq.org/v3/locations?city=${encodeURIComponent(city)}&country_id=IN&parameters_id=2&limit=3&order_by=lastUpdated&sort=desc`, {
            headers: { 'Accept': 'application/json' }
          });
          const oData = await oRes.json();
          if (oData.results && oData.results.length > 0) {
            for (const loc of oData.results) {
              for (const s of (loc.sensors || [])) {
                if (s.parameter?.name === 'pm25' && s.latest?.value > 0) {
                  // Convert PM2.5 to AQI (simplified EPA formula)
                  const pm = s.latest.value;
                  aqi = pm <= 12 ? Math.round(pm * 50 / 12) :
                        pm <= 35.4 ? Math.round(51 + (pm - 12.1) * 49 / 23.3) :
                        pm <= 55.4 ? Math.round(101 + (pm - 35.5) * 49 / 19.9) :
                        pm <= 150.4 ? Math.round(151 + (pm - 55.5) * 49 / 94.9) :
                        pm <= 250.4 ? Math.round(201 + (pm - 150.5) * 99 / 99.9) :
                        Math.round(301 + (pm - 250.5) * 99 / 99.9);
                  break;
                }
              }
              if (aqi !== null) break;
            }
          }
        }
      } catch (aqiErr) {
        console.warn(`[PULSE] AQI fetch failed for ${city}:`, aqiErr.message);
      }

      const ts = Date.now();
      const readingRain = JSON.stringify({ value: rain, ts, wind });
      const readingHeat = JSON.stringify({ value: temp, ts });
      const readingAqi  = aqi !== null ? JSON.stringify({ value: aqi, ts }) : null;

      // ── Store readings in Redis ───────────────────────────────
      await redis.pipeline([
        ['LPUSH', `readings:${city}:rain`, readingRain],
        ['LTRIM', `readings:${city}:rain`, 0, MAX_READINGS - 1],
        ['LPUSH', `readings:${city}:heat`, readingHeat],
        ['LTRIM', `readings:${city}:heat`, 0, MAX_READINGS - 1],
        ...(readingAqi ? [
          ['LPUSH', `readings:${city}:aqi`, readingAqi],
          ['LTRIM', `readings:${city}:aqi`, 0, MAX_READINGS - 1]
        ] : []),
        ['HSET', `status:${city}`,
          'rain', String(rain),
          'heat', String(temp),
          'aqi', aqi !== null ? String(aqi) : 'null',
          'wind_kph', String(wind),
          'last_updated', String(ts)
        ]
      ]);

      // ── Compute velocity for each signal ─────────────────────
      const cityResult = { city, rain, temp, aqi, woken: [] };

      const signals = [
        { name: 'rain', value: rain },
        { name: 'heat', value: temp },
        ...(aqi !== null ? [{ name: 'aqi', value: aqi }] : [])
      ];

      for (const sig of signals) {
        const rawReadings = await redis.lrange(`readings:${city}:${sig.name}`, 0, 11);
        const values = rawReadings
          .map(r => { try { return JSON.parse(r).value; } catch { return parseFloat(r); } })
          .filter(v => !isNaN(v));

        const { velocity, acceleration, trend } = computeVelocity(values);

        // Store velocity to status hash
        await redis.hset(`status:${city}`,
          `${sig.name}_velocity`, velocity.toFixed(3),
          `${sig.name}_acceleration`, acceleration.toFixed(3),
          `${sig.name}_trend`, trend
        );

        // Get effective threshold (adjusted by Layer 3 if applicable)
        const threshold = await getEffectiveThreshold(city, sig.name);

        // Decide whether to wake AI
        if (shouldWakeAI(sig.name, sig.value, velocity, acceleration, threshold)) {
          wakeCallsMade.push({ city, signal: sig.name, value: sig.value, velocity, acceleration });
          cityResult.woken.push(sig.name);

          // Call analyse.js asynchronously (fire and forget in edge, await in serverless)
          try {
            const aUrl = analyseUrl(req);
            fetch(aUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                city,
                signal: sig.name,
                triggeredBy: { velocity, acceleration, latest: sig.value }
              })
            }).catch(e => console.error('[PULSE] analyse call failed:', e.message));
          } catch (e) {
            console.error('[PULSE] Failed to wake analyse:', e.message);
          }

          // Log wake event to Redis
          await redis.lpush(`events:${city}`, JSON.stringify({
            type: 'AI_WOKEN',
            ts,
            city,
            signal: sig.name,
            value: sig.value,
            velocity,
            acceleration,
            threshold
          }));
          await redis.ltrim(`events:${city}`, 0, 99);
        }
      }

      results.push(cityResult);
      console.log(`[PULSE] ${city}: rain=${rain}mm, temp=${temp}°C, aqi=${aqi ?? 'n/a'}, woken=${cityResult.woken.join(',') || 'none'}`);

    } catch (err) {
      console.error(`[PULSE] ${city} error:`, err.message);
      results.push({ city, error: err.message });
    }
  }

  return res.status(200).json({
    success: true,
    ts: Date.now(),
    results,
    ai_woken: wakeCallsMade.length,
    woken_for: wakeCallsMade.map(w => `${w.city}/${w.signal}`)
  });
}
