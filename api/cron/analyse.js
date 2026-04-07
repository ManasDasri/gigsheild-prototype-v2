// api/cron/analyse.js
// Layer 2 — AI Analyser
// Called by pulse.js via internal POST when velocity spikes.
// Fetches readings from Redis, calls Groq for prediction, fires payout if triggered.
// Env vars: GROQ_API_KEY, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN

import redis from '../lib/redis.js';
import { getAccuracyContext, adjustThreshold, getEffectiveThreshold, recordOutcome } from '../lib/memory.js';

const GROQ_MODEL = 'llama-3.1-8b-instant';
const CITIES = ['Bengaluru', 'Chennai', 'Mumbai', 'Hyderabad', 'Delhi', 'Pune'];
const SIGNALS = ['rain', 'aqi', 'heat'];

// Internal URL for calling payout.js — works on Vercel
function payoutUrl(req) {
  const host = req.headers.host || 'localhost:3000';
  const proto = host.includes('localhost') ? 'http' : 'https';
  return `${proto}://${host}/api/cron/payout`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-internal-key');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { city, signal, triggeredBy } = req.body || {};

  if (!city || !signal || !triggeredBy) {
    return res.status(400).json({ error: 'city, signal, and triggeredBy are required.' });
  }
  if (!CITIES.includes(city)) return res.status(400).json({ error: 'Invalid city.' });
  if (!SIGNALS.includes(signal)) return res.status(400).json({ error: 'Invalid signal.' });

  const key = process.env.GROQ_API_KEY;
  if (!key) return res.status(500).json({ error: 'GROQ_API_KEY not configured.' });

  const { velocity, acceleration, latest } = triggeredBy;
  const startTime = Date.now();

  try {
    // ── 1. Fetch last 12 readings from Redis ──────────────────────
    const readingsRaw = await redis.lrange(`readings:${city}:${signal}`, 0, 11);
    const readings = readingsRaw
      .map(r => { try { return JSON.parse(r); } catch { return { value: parseFloat(r) }; } })
      .filter(r => r && !isNaN(Number(r.value || r)));

    const values = readings.map(r => Number(r.value || r));

    // ── 2. Fetch accuracy context from Layer 3 memory ─────────────
    const accuracyContext = await getAccuracyContext(city, signal);

    // ── 3. Get effective threshold (may be adjusted by Layer 3) ───
    const threshold = await getEffectiveThreshold(city, signal);
    const { threshold: adjustedThr, reason: adjustReason } = await adjustThreshold(city, signal);

    // ── 4. Build Groq prompt ──────────────────────────────────────
    const signalUnit = { rain: 'mm/hr', aqi: 'AQI', heat: '°C' }[signal];
    const signalLabel = { rain: 'Rainfall', aqi: 'Air Quality Index', heat: 'Temperature' }[signal];
    const triggerThreshold = { rain: 35, aqi: 300, heat: 42 }[signal];

    const readingTimeline = values
      .map((v, i) => `T-${i * 5}min: ${v}${signalUnit}`)
      .join(', ');

    const prompt = `You are GigShield's real-time disruption AI for ${city}, India. Analyse the following sensor data and predict if a payout trigger will occur in the next 20 minutes.

Signal: ${signalLabel} (${signal})
Payout trigger threshold: ${triggerThreshold}${signalUnit}
Effective threshold (Layer 3 adjusted): ${adjustedThr}${signalUnit}

Current reading: ${latest}${signalUnit}
Velocity (rate of change per 5min): ${velocity.toFixed(2)}${signalUnit}
Acceleration (change in velocity): ${acceleration.toFixed(2)}${signalUnit}

Last 12 readings (newest to oldest, every 5 minutes): ${readingTimeline}

Historical accuracy context: ${accuracyContext}

Threshold adjustment note: ${adjustReason}

Context: India delivery riders in ${city} are insured against income loss from: rainfall ≥35mm/hr, AQI ≥300, temperature ≥42°C. If triggered, automatic UPI payouts go to all enrolled riders in the zone.

Your task: Predict whether the ${signalLabel} will cross the trigger threshold (${triggerThreshold}${signalUnit}) in the next 20 minutes, based on the current trajectory.

Respond ONLY with a raw JSON object, no markdown, no extra text:
{"trigger":true_or_false,"severity":<integer_1_to_10>,"payout_pct":<float_0.4_to_1.0>,"warning_flag":true_or_false,"confidence":<float_0_to_1>,"reasoning":"<one concise sentence>","predicted_peak":<number>}`;

    // ── 5. Call Groq ──────────────────────────────────────────────
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: 200
      })
    });

    if (!groqRes.ok) {
      const errText = await groqRes.text();
      throw new Error('Groq API error: ' + errText);
    }

    const groqData = await groqRes.json();
    const rawContent = groqData.choices[0].message.content.trim()
      .replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

    const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in Groq response: ' + rawContent);

    const aiResult = JSON.parse(jsonMatch[0]);
    const { trigger, severity, payout_pct, warning_flag, confidence, reasoning, predicted_peak } = aiResult;

    const latency = Date.now() - startTime;

    // ── 6. Log AI decision to events:{city} ──────────────────────
    const eventRecord = {
      type: trigger ? 'AI_TRIGGER' : warning_flag ? 'AI_WARNING' : 'AI_CLEAR',
      ts: Date.now(),
      city, signal,
      latest, velocity, acceleration,
      threshold: adjustedThr,
      trigger, severity, payout_pct, warning_flag, confidence, reasoning, predicted_peak,
      latency_ms: latency
    };

    await redis.lpush(`events:${city}`, JSON.stringify(eventRecord));
    await redis.ltrim(`events:${city}`, 0, 99);

    // ── 7. Update status hash ─────────────────────────────────────
    await redis.hset(`status:${city}`,
      `${signal}_ai_trigger`, trigger ? '1' : '0',
      `${signal}_ai_warning`, warning_flag ? '1' : '0',
      `${signal}_ai_confidence`, String(confidence),
      `${signal}_ai_severity`, String(severity),
      `${signal}_ai_reasoning`, reasoning,
      `${signal}_ai_ts`, String(Date.now())
    );

    // ── 8. Fire payout if triggered ───────────────────────────────
    let payoutResult = null;
    if (trigger) {
      try {
        const payRes = await fetch(payoutUrl(req), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ city, signal, severity, payout_pct, confidence, reasoning })
        });
        payoutResult = await payRes.json();
        console.log(`[ANALYSE] Payout fired for ${city}/${signal}:`, payoutResult.ref);
      } catch (e) {
        console.error('[ANALYSE] Payout call failed:', e.message);
        // Record to Redis that payout attempt was made even if call failed
        await redis.lpush(`events:${city}`, JSON.stringify({
          type: 'PAYOUT_ERROR', ts: Date.now(), city, signal, error: e.message
        }));
      }

      // Record outcome: trigger=true, happened=true (payout was warranted)
      await recordOutcome(city, signal, true, true);
    }

    // ── 9. Handle warning flag ────────────────────────────────────
    if (warning_flag && !trigger) {
      await redis.hset(`status:${city}`,
        `${signal}_warning_since`, String(Date.now()),
        `${signal}_warning_value`, String(latest)
      );
      // Record as triggered=true, actuallyHappened=false (warning, not yet confirmed)
      // Will be corrected on next cycle if it doesn't materialise
      await recordOutcome(city, signal, false, false);
      console.log(`[ANALYSE] Warning flag set for ${city}/${signal}. Value: ${latest}${signalUnit}, confidence: ${confidence}`);
    }

    if (!trigger && !warning_flag) {
      // Clear outcome: nothing triggered, nothing happened
      await recordOutcome(city, signal, false, false);
    }

    console.log(`[ANALYSE] ${city}/${signal} — trigger: ${trigger}, severity: ${severity}, confidence: ${confidence}, latency: ${latency}ms`);

    return res.status(200).json({
      success: true,
      city, signal,
      decision: { trigger, severity, payout_pct, warning_flag, confidence, reasoning, predicted_peak },
      payout: payoutResult,
      threshold_used: adjustedThr,
      latency_ms: latency
    });

  } catch (err) {
    console.error('[ANALYSE] Error:', err.message);

    // Log error to Redis
    try {
      await redis.lpush(`events:${city}`, JSON.stringify({
        type: 'ANALYSE_ERROR', ts: Date.now(), city, signal, error: err.message
      }));
      await redis.ltrim(`events:${city}`, 0, 99);
    } catch (_) {}

    return res.status(500).json({ error: 'Analysis failed: ' + err.message });
  }
}
