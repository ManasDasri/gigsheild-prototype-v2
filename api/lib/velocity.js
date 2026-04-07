// api/lib/velocity.js
// Computes velocity (rate of change) and acceleration (rate of rate of change)
// from a time-series of sensor readings.
// Used by pulse.js to decide when to wake the AI analyser.

// Thresholds — base values, can be overridden by Redis threshold:{city}:{signal}
export const BASE_THRESHOLDS = {
  rain: 35,   // mm/hr
  aqi: 300,   // AQI units
  heat: 42    // °C
};

// How much of the threshold must velocity cover in one cycle to wake AI
const VELOCITY_WAKE_RATIO = 0.15; // 15% of threshold per cycle
const MIN_READINGS_FOR_VELOCITY = 3;

/**
 * computeVelocity(readings)
 * readings: array of numbers, newest first
 * Returns { velocity, acceleration, trend }
 */
export function computeVelocity(readings) {
  if (!readings || readings.length < 2) {
    return { velocity: 0, acceleration: 0, trend: 'stable' };
  }

  const nums = readings.map(Number).filter(n => !isNaN(n));
  if (nums.length < 2) return { velocity: 0, acceleration: 0, trend: 'stable' };

  // Velocity = average change per step over last 3 readings (newest first)
  const recent = nums.slice(0, Math.min(6, nums.length));
  let totalDelta = 0;
  for (let i = 0; i < recent.length - 1; i++) {
    totalDelta += recent[i] - recent[i + 1]; // newer - older
  }
  const velocity = totalDelta / (recent.length - 1);

  // Acceleration = change in velocity (compare first half vs second half)
  let acceleration = 0;
  if (nums.length >= 4) {
    const half = Math.floor(nums.length / 2);
    const recentHalf = nums.slice(0, half);
    const olderHalf = nums.slice(half, half * 2);
    const recentV = (recentHalf[0] - recentHalf[recentHalf.length - 1]) / recentHalf.length;
    const olderV = (olderHalf[0] - olderHalf[olderHalf.length - 1]) / olderHalf.length;
    acceleration = recentV - olderV;
  }

  const trend = velocity > 0.5 ? 'rising' : velocity < -0.5 ? 'falling' : 'stable';

  return { velocity, acceleration, trend };
}

/**
 * shouldWakeAI(signal, latest, velocity, acceleration, threshold)
 * Returns true if the AI analyser should be woken for this reading.
 */
export function shouldWakeAI(signal, latest, velocity, acceleration, threshold) {
  const thr = threshold || BASE_THRESHOLDS[signal] || 100;
  const wakeVelocity = thr * VELOCITY_WAKE_RATIO;

  // Wake if:
  // 1. Already above 70% of threshold and rising
  const nearThreshold = latest >= thr * 0.70 && velocity > 0;
  // 2. Velocity is significant (moving fast toward threshold)
  const fastApproach = velocity >= wakeVelocity;
  // 3. Acceleration is strongly positive (accelerating toward threshold)
  const accelerating = acceleration >= wakeVelocity * 0.5;
  // 4. Already over threshold
  const overThreshold = latest >= thr;

  return overThreshold || nearThreshold || fastApproach || accelerating;
}

/**
 * getSignalThreshold(signal, customThreshold)
 * Returns the effective threshold for a signal.
 */
export function getSignalThreshold(signal, customThreshold) {
  if (customThreshold && !isNaN(Number(customThreshold))) {
    return Number(customThreshold);
  }
  return BASE_THRESHOLDS[signal] || 100;
}
