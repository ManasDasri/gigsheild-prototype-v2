// api/verify-otp.js
// Verifies OTP stored in Upstash Redis
// Env vars: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN

async function redisGet(key) {
  const url = `${process.env.UPSTASH_REDIS_REST_URL}/get/${key}`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` }
  });
  if (!r.ok) throw new Error('Redis GET failed');
  const data = await r.json();
  return data.result; // null if key doesn't exist or expired
}

async function redisDel(key) {
  const url = `${process.env.UPSTASH_REDIS_REST_URL}/del/${key}`;
  await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` }
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { phone, otp } = req.body || {};
  const clean = String(phone || '').replace(/\D/g, '').slice(-10);

  if (!clean || !otp) {
    return res.status(400).json({ error: 'Phone and OTP are required.' });
  }

  try {
    const stored = await redisGet(`otp:${clean}`);

    if (!stored) {
      return res.status(400).json({ error: 'No OTP found. Please request a new one.' });
    }

    if (stored !== String(otp).trim()) {
      return res.status(400).json({ error: 'Incorrect OTP. Try again.' });
    }

    // OTP matched — delete it so it can't be reused
    await redisDel(`otp:${clean}`);

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('verify-otp error:', err.message);
    return res.status(500).json({ error: 'Verification failed. Try again.' });
  }
}
