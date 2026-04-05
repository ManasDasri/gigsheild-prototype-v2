// api/send-otp.js
// Fast2SMS OTP route — https://www.fast2sms.com
// Env var: FAST2SMS_KEY  (from your Fast2SMS dashboard → Dev API)
// Free tier gives 200 credits on signup. 1 OTP SMS ≈ 1 credit.

const store = global._gs_otp || (global._gs_otp = {});

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

  const key = process.env.FAST2SMS_KEY;
  if (!key) return res.status(500).json({ error: 'FAST2SMS_KEY not set in Vercel environment variables.' });

  const otp = String(Math.floor(1000 + Math.random() * 9000));
  store[clean] = { otp, exp: Date.now() + 5 * 60 * 1000 };

  try {
    const r = await fetch('https://www.fast2sms.com/dev/bulkV2', {
      method: 'POST',
      headers: {
        'authorization': key,
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

    // Fast2SMS returns { return: true, request_id: '...', message: [...] } on success
    if (!data.return) {
      console.error('Fast2SMS error:', JSON.stringify(data));
      // Still return success — OTP is in store, SMS might retry
      return res.status(200).json({ success: true, warning: 'SMS delivery unconfirmed. OTP stored for 5 min.' });
    }

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('Fast2SMS fetch error:', err.message);
    // OTP is still stored — frontend can retry verify
    return res.status(500).json({ error: 'SMS gateway error: ' + err.message });
  }
}
