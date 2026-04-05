// api/send-otp.js
// Simulated OTP for demo — generates a real 4-digit code server-side,
// returns it in the JSON response so the frontend can show it in an alert.
// In production this would call an SMS provider instead.

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

  const otp = String(Math.floor(1000 + Math.random() * 9000));
  store[clean] = { otp, exp: Date.now() + 5 * 60 * 1000 };

  // Return OTP in response — frontend shows it in an alert for demo
  return res.status(200).json({ success: true, otp });
}
