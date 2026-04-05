// api/aqi.js
// OpenAQ v3 API — completely free, no key needed
// Fetches latest PM2.5 readings for Indian cities and converts to AQI

const CITY_SEARCH = {
  Bengaluru: 'Bengaluru',
  Chennai:   'Chennai',
  Mumbai:    'Mumbai',
  Hyderabad: 'Hyderabad',
  Delhi:     'Delhi',
  Pune:      'Pune'
};

// US EPA PM2.5 breakpoints → AQI
function pm25ToAQI(pm) {
  const bp = [
    [0.0,   12.0,  0,  50],
    [12.1,  35.4, 51, 100],
    [35.5,  55.4,101, 150],
    [55.5, 150.4,151, 200],
    [150.5,250.4,201, 300],
    [250.5,350.4,301, 400],
    [350.5,500.4,401, 500]
  ];
  for (const [clo, chi, ilo, ihi] of bp) {
    if (pm >= clo && pm <= chi) {
      return Math.round(((ihi - ilo) / (chi - clo)) * (pm - clo) + ilo);
    }
  }
  return 500;
}

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
  const cityName = CITY_SEARCH[city];
  if (!cityName) return res.status(400).json({ error: 'Invalid city' });

  try {
    // OpenAQ v3 — fetch latest PM2.5 readings for city
    const url = `https://api.openaq.org/v3/locations?city=${encodeURIComponent(cityName)}&country_id=IN&parameters_id=2&limit=5&order_by=lastUpdated&sort_order=desc`;
    const r = await fetch(url, {
      headers: { 'Accept': 'application/json', 'X-API-Key': '' }
    });

    if (!r.ok) throw new Error(`OpenAQ returned ${r.status}`);
    const data = await r.json();

    if (!data.results || data.results.length === 0) {
      return res.status(200).json({ city, pm25: null, aqi: null, category: 'No sensor data', updated: new Date().toISOString() });
    }

    // Find most recent PM2.5 value across locations
    let bestPM = null;
    let bestTime = null;
    let sourceName = null;

    for (const loc of data.results) {
      if (!loc.parameters) continue;
      for (const param of loc.parameters) {
        if (param.parameter === 'pm25' && param.lastValue != null && param.lastValue > 0) {
          const t = new Date(param.lastUpdated);
          if (!bestTime || t > bestTime) {
            bestPM = param.lastValue;
            bestTime = t;
            sourceName = loc.name;
          }
        }
      }
    }

    if (bestPM === null) {
      return res.status(200).json({ city, pm25: null, aqi: null, category: 'No recent PM2.5 data', updated: new Date().toISOString() });
    }

    const pm25 = Math.round(bestPM);
    const aqi  = pm25ToAQI(pm25);

    return res.status(200).json({
      city,
      pm25,
      aqi,
      category:    aqiCategory(aqi),
      source:      sourceName || 'OpenAQ',
      last_sensor: bestTime ? bestTime.toISOString() : null,
      updated:     new Date().toISOString()
    });

  } catch (err) {
    console.error('AQI error:', err.message);
    return res.status(200).json({ city, pm25: null, aqi: null, category: 'Sensor unavailable', updated: new Date().toISOString() });
  }
}
