// api/send-otp.js
// Fast2SMS Quick SMS + Upstash Redis for cross-function OTP persistence
// Env vars: FAST2SMS_KEY, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN

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

  if (!process.env.FAST2SMS_KEY) return res.status(500).json({ error: 'FAST2SMS_KEY not set.' });
  if (!process.env.UPSTASH_REDIS_REST_URL) return res.status(500).json({ error: 'UPSTASH_REDIS_REST_URL not set.' });
  if (!process.env.UPSTASH_REDIS_REST_TOKEN) return res.status(500).json({ error: 'UPSTASH_REDIS_REST_TOKEN not set.' });

  const otp = String(Math.floor(1000 + Math.random() * 9000));

  // Store OTP in Redis with 5 min TTL
  await redisSet(`otp:${clean}`, otp, 300);

  try {
    const r = await fetch('https://www.fast2sms.com/dev/bulkV2', {
      method: 'POST',
      headers: {
        'authorization': process.env.FAST2SMS_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        route: 'q',
        message: `Your GigShield OTP is ${otp}. Valid for 5 minutes. Do not share with anyone.`,
        numbers: clean,
        flash: 0
      })
    });

    const data = await r.json();

    if (!data.return) {
      console.error('Fast2SMS error:', JSON.stringify(data));
      return res.status(500).json({ error: 'SMS delivery failed: ' + (data.message?.[0] || 'Unknown error') });
    }

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('send-otp error:', err.message);
    return res.status(500).json({ error: 'SMS gateway error: ' + err.message });
  }
}
