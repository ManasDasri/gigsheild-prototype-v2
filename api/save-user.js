// api/save-user.js
// Saves enrolled user profile to Redis after onboarding completes
// Env vars: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { phone, name, city, platform, earn, plan, premium, coverage } = req.body || {};
  const clean = String(phone || '').replace(/\D/g, '').slice(-10);

  if (!clean || !name || !city || !plan) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }

  if (!process.env.UPSTASH_REDIS_REST_URL) return res.status(500).json({ error: 'Redis not configured.' });

  const user = { phone: clean, name, city, platform, earn, plan, premium, coverage, enrolled_at: new Date().toISOString() };

  try {
    const url = `${process.env.UPSTASH_REDIS_REST_URL}/set/user:${clean}/${encodeURIComponent(JSON.stringify(user))}`;
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` }
    });
    if (!r.ok) throw new Error('Redis SET failed');
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('save-user error:', err.message);
    return res.status(500).json({ error: 'Failed to save profile.' });
  }
}
