// api/weather.js
// WeatherAPI.com free tier — 1M calls/month, no card needed
// Env var: WEATHERAPI_KEY

const CITY_MAP = {
  Bengaluru: 'Bangalore,India',
  Chennai:   'Chennai,India',
  Mumbai:    'Mumbai,India',
  Hyderabad: 'Hyderabad,India',
  Delhi:     'New Delhi,India',
  Pune:      'Pune,India'
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { city } = req.query;
  const q = CITY_MAP[city];
  if (!q) return res.status(400).json({ error: 'Invalid city. Valid: Bengaluru, Chennai, Mumbai, Hyderabad, Delhi, Pune' });

  const key = process.env.WEATHERAPI_KEY;
  if (!key) return res.status(500).json({ error: 'WEATHERAPI_KEY not set in Vercel environment variables.' });

  try {
    const url = `https://api.weatherapi.com/v1/current.json?key=${key}&q=${encodeURIComponent(q)}&aqi=no`;
    const r = await fetch(url);
    const d = await r.json();

    if (d.error) return res.status(502).json({ error: `WeatherAPI: ${d.error.message}` });

    return res.status(200).json({
      city,
      temp:        Math.round(d.current.temp_c),
      feels_like:  Math.round(d.current.feelslike_c),
      humidity:    d.current.humidity,
      description: d.current.condition.text,
      rain_mm:     d.current.precip_mm || 0,
      wind_kph:    d.current.wind_kph,
      uv:          d.current.uv,
      updated:     new Date().toISOString()
    });
  } catch (err) {
    console.error('Weather fetch error:', err.message);
    return res.status(500).json({ error: 'Weather service unavailable. Try again.' });
  }
}
