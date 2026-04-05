// api/send-otp.js
// 2Factor.in OTP API — fast DND-bypass OTP for India
// Env vars: TWOFACTOR_KEY, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN

async function redisSet(key, value, ttlSeconds) {
  const url = `${process.env.UPSTASH_REDIS_REST_URL}/set/${key}/${value}/ex/${ttlSeconds}`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` }
  });
  if (!r.ok) throw new Error('Redis SET failed');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { phone } = req.body || {};
  const clean = String(phone || '').replace(/\D/g, '').slice(-10);

  if (!/^[6-9]\d{9}$/.test(clean)) {
    return res.status(400).json({ error: 'Enter a valid 10-digit Indian mobile number.' });
  }

  const key = process.env.TWOFACTOR_KEY;
  if (!key) return res.status(500).json({ error: 'TWOFACTOR_KEY not set.' });
  if (!process.env.UPSTASH_REDIS_REST_URL) return res.status(500).json({ error: 'UPSTASH_REDIS_REST_URL not set.' });

  const otp = String(Math.floor(1000 + Math.random() * 9000));

  // Store in Redis with 5 min TTL
  await redisSet(`otp:${clean}`, otp, 300);

  try {
    // 2Factor API: GET /API/V1/{apikey}/SMS/{phone}/{otp}/{template_name}
    const url = `https://2factor.in/API/V1/${key}/SMS/${clean}/${otp}/Gigshield`;
    const r = await fetch(url);
    const data = await r.json();

    if (data.Status !== 'Success') {
      console.error('2Factor error:', JSON.stringify(data));
      return res.status(500).json({ error: 'SMS delivery failed: ' + (data.Details || 'Unknown error') });
    }

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('send-otp error:', err.message);
    return res.status(500).json({ error: 'SMS gateway error: ' + err.message });
  }
}
