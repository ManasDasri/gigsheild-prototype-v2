// api/lib/redis.js
// Upstash Redis REST client — no npm install needed, pure fetch
// Env vars: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN

const BASE = () => process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = () => process.env.UPSTASH_REDIS_REST_TOKEN;

async function cmd(...args) {
  const r = await fetch(`${BASE()}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN()}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(args)
  });
  if (!r.ok) throw new Error(`Redis error ${r.status}: ${await r.text()}`);
  const d = await r.json();
  return d.result;
}

export const redis = {
  // String ops
  async get(key) { return cmd('GET', key); },
  async set(key, val, ...opts) { return cmd('SET', key, typeof val === 'object' ? JSON.stringify(val) : String(val), ...opts); },
  async del(key) { return cmd('DEL', key); },

  // List ops
  async lpush(key, ...vals) { return cmd('LPUSH', key, ...vals.map(v => typeof v === 'object' ? JSON.stringify(v) : String(v))); },
  async lrange(key, start, stop) { return cmd('LRANGE', key, start, stop); },
  async ltrim(key, start, stop) { return cmd('LTRIM', key, start, stop); },
  async llen(key) { return cmd('LLEN', key); },

  // Hash ops
  async hset(key, ...pairs) { return cmd('HSET', key, ...pairs.map(String)); },
  async hget(key, field) { return cmd('HGET', key, field); },
  async hgetall(key) { return cmd('HGETALL', key); },
  async hmset(key, obj) {
    const pairs = Object.entries(obj).flat().map(String);
    return cmd('HMSET', key, ...pairs);
  },

  // Utility
  async exists(key) { return cmd('EXISTS', key); },
  async expire(key, secs) { return cmd('EXPIRE', key, secs); },

  // Pipeline: run multiple commands at once
  async pipeline(commands) {
    const r = await fetch(`${BASE()}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN()}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(commands)
    });
    if (!r.ok) throw new Error(`Redis pipeline error ${r.status}`);
    const d = await r.json();
    return d.map(x => x.result);
  }
};

export default redis;
