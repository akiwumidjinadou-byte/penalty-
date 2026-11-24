const ID = /^[A-Z0-9]{8,12}$/;
const MAX_PER_IP = 5;
const json = (o, s = 200) => new Response(JSON.stringify(o), {
  status: s,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
});
let ready = null;
function init(env) {
  if (!ready) {
    ready = env.DB.batch([
      env.DB.prepare('CREATE TABLE IF NOT EXISTS players (pid TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0, created INTEGER)'),
      env.DB.prepare('CREATE TABLE IF NOT EXISTS joins (pid TEXT PRIMARY KEY, ref TEXT, ts INTEGER)'),
      env.DB.prepare('CREATE TABLE IF NOT EXISTS ipref (k TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0)')
    ]).catch(e => { ready = null; throw e; });
  }
  return ready;
}
async function hash(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].slice(0, 8).map(x => x.toString(16).padStart(2, '0')).join('');
}
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    try {
      await init(env);
      if (url.pathname === '/api/me' && req.method === 'GET') {
        const pid = (url.searchParams.get('pid') || '').toUpperCase();
        if (!ID.test(pid)) return json({ error: 'bad' }, 400);
        const row = await env.DB.prepare('SELECT count FROM players WHERE pid = ?').bind(pid).first();
        if (!row) {
          await env.DB.prepare('INSERT OR IGNORE INTO players (pid, count, created) VALUES (?, 0, ?)').bind(pid, Date.now()).run();
          return json({ count: 0 });
        }
        return json({ count: row.count });
      }
      if (url.pathname === '/api/join' && req.method === 'POST') {
        let b;
        try { b = await req.json(); } catch (e) { return json({ error: 'bad' }, 400); }
        const pid = String(b.pid || '').toUpperCase();
        const ref = String(b.ref || '').toUpperCase();
        if (!ID.test(pid) || !ID.test(ref) || pid === ref) return json({ ok: false, reason: 'invalid' });
        const done = await env.DB.prepare('SELECT 1 AS x FROM joins WHERE pid = ?').bind(pid).first();
        if (done) return json({ ok: false, reason: 'already' });
        const ik = ref + ':' + await hash((req.headers.get('CF-Connecting-IP') || '') + ':' + ref);
        const ip = await env.DB.prepare('SELECT n FROM ipref WHERE k = ?').bind(ik).first();
        if (ip && ip.n >= MAX_PER_IP) return json({ ok: false, reason: 'limit' });
        await env.DB.batch([
          env.DB.prepare('INSERT INTO joins (pid, ref, ts) VALUES (?, ?, ?)').bind(pid, ref, Date.now()),
          env.DB.prepare('INSERT OR IGNORE INTO players (pid, count, created) VALUES (?, 0, ?)').bind(ref, Date.now()),
          env.DB.prepare('UPDATE players SET count = count + 1 WHERE pid = ?').bind(ref),
          env.DB.prepare('INSERT INTO ipref (k, n) VALUES (?, 1) ON CONFLICT(k) DO UPDATE SET n = n + 1').bind(ik)
        ]);
        return json({ ok: true });
      }
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: 'server' }, 500);
    }
  }
};