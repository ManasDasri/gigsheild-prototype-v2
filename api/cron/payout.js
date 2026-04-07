// api/cron/payout.js
// Layer 2 — Payout initiator
// Called by analyse.js when trigger=true
// In production: calls Razorpay/UPI APIs per rider in zone
// Right now: logs the payout event to Redis and returns payout summary

import redis from '../lib/redis.js';
import { recordOutcome } from '../lib/memory.js';

// Simulated rider counts per city (replace with real DB query in production)
const RIDER_COUNTS = {
  Bengaluru: 1247,
  Chennai: 892,
  Mumbai: 2103,
  Hyderabad: 743,
  Delhi: 1876,
  Pune: 521
};

// Payout base amounts per signal (% of avg daily earnings)
const PAYOUT_RATES = {
  rain: 0.60,
  aqi: 0.50,
  heat: 0.40,
  curfew: 1.00
};

const AVG_DAILY_EARN = 700; // Rs. — used for simulation

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { city, signal, severity, payout_pct, confidence, reasoning } = req.body || {};

  if (!city || !signal) {
    return res.status(400).json({ error: 'city and signal are required.' });
  }

  const riderCount = RIDER_COUNTS[city] || 500;
  const baseRate = PAYOUT_RATES[signal] || 0.50;
  const effectiveRate = payout_pct || baseRate;
  const perRiderPayout = Math.round(AVG_DAILY_EARN * effectiveRate);
  const totalPayout = perRiderPayout * riderCount;

  const payoutRecord = {
    ts: Date.now(),
    city,
    signal,
    severity: severity || 5,
    payout_pct: effectiveRate,
    confidence: confidence || 0.8,
    riders_affected: riderCount,
    per_rider_rs: perRiderPayout,
    total_rs: totalPayout,
    reasoning: reasoning || 'Threshold breached — auto-payout initiated.',
    status: 'initiated',
    ref: 'GS-' + Date.now().toString(36).toUpperCase()
  };

  try {
    // Log payout event to Redis events list
    const evKey = `events:${city}`;
    await redis.lpush(evKey, JSON.stringify({
      type: 'PAYOUT_INITIATED',
      ...payoutRecord
    }));
    await redis.ltrim(evKey, 0, 99);

    // Record outcome for Layer 3 learning (triggered=true, happened=true)
    await recordOutcome(city, signal, true, true);

    // Store payout summary to a payouts list for dashboard
    await redis.lpush('payouts:all', JSON.stringify(payoutRecord));
    await redis.ltrim('payouts:all', 0, 199);

    console.log(`[PAYOUT] ${city}/${signal} — ₹${totalPayout.toLocaleString('en-IN')} to ${riderCount} riders. Ref: ${payoutRecord.ref}`);

    return res.status(200).json({
      success: true,
      ref: payoutRecord.ref,
      city,
      signal,
      riders_affected: riderCount,
      per_rider_rs: perRiderPayout,
      total_rs: totalPayout,
      message: `Payout initiated for ${riderCount} riders in ${city}. Total: Rs. ${totalPayout.toLocaleString('en-IN')}.`
    });

  } catch (err) {
    console.error('[PAYOUT] Redis error:', err.message);
    return res.status(500).json({ error: 'Payout logging failed: ' + err.message });
  }
}
