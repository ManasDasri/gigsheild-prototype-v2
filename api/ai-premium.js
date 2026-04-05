// api/ai-premium.js
// Groq API — free tier, llama3-70b-8192, no card needed
// Env var: GROQ_API_KEY (from console.groq.com)

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { city, platform, hours_per_day, avg_daily_earnings, tier } = req.body || {};

  if (!city || !platform || !hours_per_day || !avg_daily_earnings || !tier) {
    return res.status(400).json({ error: 'Missing required fields: city, platform, hours_per_day, avg_daily_earnings, tier' });
  }

  const key = process.env.GROQ_API_KEY;
  if (!key) return res.status(500).json({ error: 'GROQ_API_KEY not set in Vercel environment variables.' });

  const prompt = `You are an AI actuary for GigShield, a parametric income protection platform for Indian delivery riders.

Rider profile:
- City: ${city}
- Platform: ${platform}
- Hours worked per day: ${hours_per_day}
- Average daily earnings: Rs. ${avg_daily_earnings}
- Coverage tier selected: ${tier}

Calculate a personalised weekly insurance premium using these rules:

CITY RISK (base multiplier):
- Bengaluru: 1.3x (high monsoon, flood prone)
- Chennai: 1.4x (cyclone season, flooding)
- Mumbai: 1.5x (extreme flooding, heavy monsoon)
- Delhi: 1.2x (severe pollution, fog)
- Hyderabad: 1.1x (moderate disruption risk)
- Pune: 1.0x (baseline)

PLATFORM RISK:
- Zomato/Swiggy (food): highest outdoor exposure, 1.3x
- Blinkit/Zepto (grocery): high exposure, 1.2x
- Amazon Flex (ecommerce): moderate, 1.0x

HOURS RISK: more hours = more exposure. Scale linearly from 4hrs (1.0x) to 12hrs (1.5x).

COVERAGE CAP: roughly 3x to 4x the weekly premium, aligned to tier:
- Basic: cap Rs. 1200-1800
- Standard: cap Rs. 2000-3000
- Pro: cap Rs. 3500-5000

Target loss ratio: 60-70%.

Respond ONLY with a single raw JSON object. No markdown. No explanation. No text before or after the JSON:
{"weekly_premium":<integer>,"risk_score":<integer 1-10>,"risk_level":"<Low|Moderate|High|Very High>","coverage_cap":<integer>,"primary_risks":["<risk1>","<risk2>","<risk3>"],"reasoning":"<2 sentences explaining this premium>","discount_applied":"<string or null>","loss_ratio_estimate":"<e.g. 65%>"}`;

  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: 400
      })
    });

    const data = await r.json();
    if (data.error) throw new Error(data.error.message || 'Groq API error');

    const raw = data.choices[0].message.content.trim().replace(/```[a-z]*/g, '').replace(/```/g, '').trim();

    // Extract JSON even if model adds surrounding text
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Model did not return valid JSON');

    const result = JSON.parse(jsonMatch[0]);

    // Validate required fields
    if (!result.weekly_premium || !result.risk_score || !result.coverage_cap) {
      throw new Error('Incomplete response from AI model');
    }

    return res.status(200).json({ success: true, ...result });

  } catch (err) {
    console.error('AI premium error:', err.message);
    return res.status(500).json({ error: 'AI calculation failed: ' + err.message });
  }
}
