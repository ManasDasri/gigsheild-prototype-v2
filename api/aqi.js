// api/aqi.js
// WAQI (World Air Quality Index) API — free tier, 1000 calls/day
// Get token at: https://aqicn.org/api/
// Env var: WAQI_TOKEN

const CITY_SLUG = {
  Bengaluru: 'bengaluru',
  Chennai:   'chennai',
  Mumbai:    'mumbai',
  Hyderabad: 'hyderabad',
  Delhi:     'delhi',
  Pune:      'pune'
};

function aqiCategory(aqi) {
  if (aqi <= 50)  return 'Good';
  if (aqi <= 100) return 'Moderate';
  if (aqi <= 150) return 'Unhealthy for Sensitive Groups';
  if (aqi <= 200) return 'Unhealthy';
  if (aqi <= 300) return 'Very Unhealthy';
  return 'Hazardous';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { city } = req.query;
  const slug = CITY_SLUG[city];
  if (!slug) return res.status(400).json({ error: 'Invalid city. Valid: Bengaluru, Chennai, Mumbai, Hyderabad, Delhi, Pune' });

  const token = process.env.WAQI_TOKEN;
  if (!token) return res.status(500).json({ error: 'WAQI_TOKEN not set in Vercel environment variables. Get one free at https://aqicn.org/api/' });

  try {
    const url = `https://api.waqi.info/feed/${slug}/?token=${token}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`WAQI returned HTTP ${r.status}`);

    const data = await r.json();

    if (data.status !== 'ok') {
      return res.status(200).json({
        city, pm25: null, aqi: null,
        category: 'Sensor unavailable',
        updated: new Date().toISOString()
      });
    }

    const aqi = data.data.aqi;
    // Extract PM2.5 from WAQI's iaqi block if available
    const pm25 = data.data.iaqi?.pm25?.v ?? null;
    const stationName = data.data.city?.name ?? slug;
    const stationTime = data.data.time?.s ?? null;

    return res.status(200).json({
      city,
      aqi:      typeof aqi === 'number' ? Math.round(aqi) : null,
      pm25:     pm25 !== null ? Math.round(pm25) : null,
      category: typeof aqi === 'number' ? aqiCategory(aqi) : 'No data',
      source:   stationName,
      last_sensor: stationTime ? new Date(stationTime).toISOString() : null,
      updated:  new Date().toISOString()
    });

  } catch (err) {
    console.error('AQI error:', err.message);
    return res.status(200).json({
      city, pm25: null, aqi: null,
      category: 'Sensor unavailable',
      updated: new Date().toISOString()
    });
  }
}
