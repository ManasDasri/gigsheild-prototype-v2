// api/lib/memory.js
// Layer 3 — GigShield memory and self-learning system
// Records trigger outcomes, computes accuracy, adjusts thresholds over time.
// All state stored in Upstash Redis.

import redis from './redis.js';
import { BASE_THRESHOLDS } from './velocity.js';

const MAX_OUTCOMES = 50; // keep last 50 outcomes per city+signal
const ACCURACY_WINDOW = 20; // use last 20 for accuracy rate

/**
 * recordOutcome(city, signal, triggered, actuallyHappened)
 * Called after a payout fires (triggered=true, actuallyHappened=true)
 * or after a warning that did not become a trigger (triggered=true, actuallyHappened=false)
 *
 * actuallyHappened: whether the threshold was actually crossed in the next cycle
 */
export async function recordOutcome(city, signal, triggered, actuallyHappened) {
  const record = {
    ts: Date.now(),
    triggered: triggered ? 1 : 0,
    correct: triggered === actuallyHappened ? 1 : 0,
    signal,
    city
  };

  const key = `outcomes:${city}`;
  await redis.lpush(key, JSON.stringify(record));
  await redis.ltrim(key, 0, MAX_OUTCOMES - 1);

  // Recompute and store rolling accuracy
  await _updateAccuracy(city, signal);
}

/**
 * getAccuracyContext(city, signal)
 * Returns a plain-English summary of past accuracy for injection into Groq prompt.
 * Example: "Last 20 rain triggers in Bengaluru: 14/20 correct (70%). Recommend conservative threshold."
 */
export async function getAccuracyContext(city, signal) {
  try {
    const key = `outcomes:${city}`;
    const raw = await redis.lrange(key, 0, ACCURACY_WINDOW - 1);
    if (!raw || raw.length === 0) {
      return `No historical accuracy data yet for ${signal} in ${city}. Using default thresholds.`;
    }

    const records = raw
      .map(r => { try { return JSON.parse(r); } catch { return null; } })
      .filter(r => r && r.signal === signal);

    if (records.length === 0) {
      return `No historical ${signal} data for ${city} yet. Treat this as first observation.`;
    }

    const total = records.length;
    const correct = records.filter(r => r.correct === 1).length;
    const pct = Math.round((correct / total) * 100);

    const falsePositives = records.filter(r => r.triggered === 1 && r.correct === 0).length;
    const fpRate = total > 0 ? Math.round((falsePositives / total) * 100) : 0;

    let recommendation = '';
    if (pct < 60) recommendation = 'Accuracy is low — recommend raising threshold to reduce false alarms.';
    else if (pct > 85) recommendation = 'Accuracy is high — threshold may be slightly conservative, consider lowering.';
    else recommendation = 'Accuracy is acceptable — maintain current threshold.';

    // Check for season pattern (last 7 days)
    const recent7d = records.filter(r => Date.now() - r.ts < 7 * 24 * 60 * 60 * 1000);
    const recentPct = recent7d.length > 0
      ? Math.round((recent7d.filter(r => r.correct === 1).length / recent7d.length) * 100)
      : null;

    let seasonNote = '';
    if (recentPct !== null && Math.abs(recentPct - pct) > 15) {
      seasonNote = ` Recent 7-day accuracy: ${recentPct}% (${recentPct > pct ? 'improving' : 'degrading'}).`;
    }

    return `Last ${total} ${signal} observations in ${city}: ${correct}/${total} correct (${pct}%). False positive rate: ${fpRate}%.${seasonNote} ${recommendation}`;

  } catch (err) {
    console.error('getAccuracyContext error:', err.message);
    return `Accuracy context unavailable for ${city} ${signal}. Proceed with default thresholds.`;
  }
}

/**
 * adjustThreshold(city, signal)
 * Reads accuracy rate and recommends a threshold adjustment.
 * Stores adjusted threshold to Redis: threshold:{city}:{signal}
 * Returns { threshold, adjusted, reason }
 */
export async function adjustThreshold(city, signal) {
  const base = BASE_THRESHOLDS[signal] || 100;

  try {
    const accKey = `accuracy:${city}:${signal}`;
    const stored = await redis.hgetall(accKey);

    if (!stored || !stored.rate) {
      return { threshold: base, adjusted: false, reason: 'No accuracy data yet — using base threshold.' };
    }

    const rate = parseFloat(stored.rate);
    const currentThreshold = parseFloat(stored.threshold || base);

    let newThreshold = currentThreshold;
    let reason = '';
    let adjusted = false;

    if (rate < 0.60) {
      // Too many false positives — raise threshold by 10%
      newThreshold = Math.round(currentThreshold * 1.10 * 10) / 10;
      reason = `Accuracy ${Math.round(rate * 100)}% — below 60%. Raised threshold from ${currentThreshold} to ${newThreshold}.`;
      adjusted = true;
    } else if (rate > 0.85) {
      // Very accurate — threshold might be too conservative, lower by 5%
      newThreshold = Math.round(currentThreshold * 0.95 * 10) / 10;
      reason = `Accuracy ${Math.round(rate * 100)}% — above 85%. Lowered threshold from ${currentThreshold} to ${newThreshold}.`;
      adjusted = true;
    } else {
      reason = `Accuracy ${Math.round(rate * 100)}% — acceptable range. No adjustment needed.`;
    }

    if (adjusted) {
      await redis.hmset(`threshold:${city}:${signal}`, {
        value: newThreshold,
        base,
        last_adjusted: Date.now(),
        reason
      });
    }

    return { threshold: newThreshold, adjusted, reason };

  } catch (err) {
    console.error('adjustThreshold error:', err.message);
    return { threshold: base, adjusted: false, reason: 'Error reading accuracy — using base threshold.' };
  }
}

/**
 * getEffectiveThreshold(city, signal)
 * Returns the currently active threshold for a city+signal pair.
 * Falls back to base threshold if no adjustment has been stored.
 */
export async function getEffectiveThreshold(city, signal) {
  try {
    const val = await redis.hget(`threshold:${city}:${signal}`, 'value');
    if (val && !isNaN(Number(val))) return Number(val);
  } catch (_) {}
  return BASE_THRESHOLDS[signal] || 100;
}

// ── Internal ──────────────────────────────────────────────

async function _updateAccuracy(city, signal) {
  try {
    const key = `outcomes:${city}`;
    const raw = await redis.lrange(key, 0, ACCURACY_WINDOW - 1);
    const records = raw
      .map(r => { try { return JSON.parse(r); } catch { return null; } })
      .filter(r => r && r.signal === signal);

    if (records.length === 0) return;

    const correct = records.filter(r => r.correct === 1).length;
    const rate = correct / records.length;

    await redis.hmset(`accuracy:${city}:${signal}`, {
      rate: rate.toFixed(4),
      total: records.length,
      correct,
      threshold: BASE_THRESHOLDS[signal] || 100,
      last_updated: Date.now()
    });
  } catch (err) {
    console.error('_updateAccuracy error:', err.message);
  }
}
