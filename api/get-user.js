// api/get-user.js
// Fetches enrolled user profile from Redis by phone number
// Env vars: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { phone } = req.query;
  const clean = String(phone || '').replace(/\D/g, '').slice(-10);

  if (!clean) return res.status(400).json({ error: 'Phone required.' });
  if (!process.env.UPSTASH_REDIS_REST_URL) return res.status(500).json({ error: 'Redis not configured.' });

  try {
    const url = `${process.env.UPSTASH_REDIS_REST_URL}/get/user:${clean}`;
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` }
    });
    if (!r.ok) throw new Error('Redis GET failed');
    const data = await r.json();
    if (!data.result) return res.status(404).json({ error: 'User not found.' });
    return res.status(200).json({ success: true, user: JSON.parse(decodeURIComponent(data.result)) });
  } catch (err) {
    console.error('get-user error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch profile.' });
  }
}
