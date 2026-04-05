// api/verify-otp.js
const store = global._gs_otp || (global._gs_otp = {});

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { phone, otp } = req.body || {};
  const clean = String(phone || '').replace(/\D/g, '').slice(-10);
  const rec = store[clean];

  if (!rec) {
    return res.status(400).json({ error: 'No OTP found. Please request a new one.' });
  }
  if (Date.now() > rec.exp) {
    delete store[clean];
    return res.status(400).json({ error: 'OTP expired. Please request a new one.' });
  }
  if (rec.otp !== String(otp).trim()) {
    return res.status(400).json({ error: 'Incorrect OTP. Try again.' });
  }

  delete store[clean];
  return res.status(200).json({ success: true });
}
