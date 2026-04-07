// api/monitor-stream.js
// Layer 4 — Real-time SSE stream for the frontend monitor screen
// Uses Vercel edge runtime with Server-Sent Events
// Reads from Redis every 5 seconds and streams updates to the client
// No Pusher, no WebSocket — pure SSE

export const config = { runtime: 'edge' };

const CITIES = ['Bengaluru', 'Chennai', 'Mumbai', 'Hyderabad', 'Delhi', 'Pune'];
const POLL_INTERVAL_MS = 5000;

const BASE_URL = () => process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = () => process.env.UPSTASH_REDIS_REST_TOKEN;

// Minimal Redis fetch for edge runtime (no Node.js modules allowed)
async function redisGet(key) {
  const r = await fetch(`${BASE_URL()}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN()}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(['GET', key])
  });
  const d = await r.json();
  return d.result;
}

async function redisHgetall(key) {
  const r = await fetch(`${BASE_URL()}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN()}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(['HGETALL', key])
  });
  const d = await r.json();
  // HGETALL returns flat array: [field, val, field, val, ...]
  const result = d.result;
  if (!result || result.length === 0) return {};
  const obj = {};
  for (let i = 0; i < result.length; i += 2) {
    obj[result[i]] = result[i + 1];
  }
  return obj;
}

async function redisLrange(key, start, stop) {
  const r = await fetch(`${BASE_URL()}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN()}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(['LRANGE', key, start, stop])
  });
  const d = await r.json();
  return d.result || [];
}

async function buildSnapshot(city) {
  const [status, eventsRaw] = await Promise.all([
    redisHgetall(`status:${city}`),
    redisLrange(`events:${city}`, 0, 4)
  ]);

  const events = eventsRaw
    .map(e => { try { return JSON.parse(e); } catch { return null; } })
    .filter(Boolean);

  return { city, status, events };
}

async function buildPayload() {
  const snapshots = await Promise.all(CITIES.map(buildSnapshot));
  return {
    ts: Date.now(),
    cities: snapshots.reduce((acc, s) => { acc[s.city] = { status: s.status, events: s.events }; return acc; }, {})
  };
}

export default async function handler(req) {
  const url = new URL(req.url);
  const requestedCity = url.searchParams.get('city') || 'Bengaluru';

  if (!process.env.UPSTASH_REDIS_REST_URL) {
    return new Response('Redis not configured', { status: 500 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let open = true;

      const send = (data) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch (_) { open = false; }
      };

      // Send initial snapshot immediately
      try {
        const payload = await buildPayload();
        send({ type: 'snapshot', ...payload });
      } catch (e) {
        send({ type: 'error', message: e.message });
      }

      // Poll every 5 seconds
      const interval = setInterval(async () => {
        if (!open) { clearInterval(interval); return; }
        try {
          const payload = await buildPayload();
          send({ type: 'update', ...payload });
        } catch (e) {
          send({ type: 'error', message: e.message });
        }
      }, POLL_INTERVAL_MS);

      // Vercel edge functions time out — client will reconnect automatically
      setTimeout(() => {
        open = false;
        clearInterval(interval);
        try { controller.close(); } catch (_) {}
      }, 25000); // 25s — just under Vercel's 30s edge limit
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*'
    }
  });
}
