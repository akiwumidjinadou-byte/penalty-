// Serveur de parrainage (anonyme) : compte les amis qui jouent via un lien d'invitation.
// Les autres requêtes (le jeu lui-même) sont servies directement par Cloudflare.
const ID = /^[A-Z0-9]{8,12}$/;
const MAX_PER_IP = 5; // max d'invitations comptées par ami-parrain et par adresse réseau
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
      env.DB.prepare('CREATE TABLE IF NOT EXISTS ipref (k TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0)'),
      env.DB.prepare('CREATE TABLE IF NOT EXISTS names (pid TEXT PRIMARY KEY, name TEXT)'),
      env.DB.prepare('CREATE INDEX IF NOT EXISTS joins_ref_ts ON joins (ref, ts)'),
      env.DB.prepare('CREATE TABLE IF NOT EXISTS scores2 (game TEXT, week INTEGER, pid TEXT, best INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0, n INTEGER NOT NULL DEFAULT 0, ts INTEGER NOT NULL DEFAULT 0, last INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (game, week, pid))')
    ]).catch(e => { ready = null; throw e; });
  }
  return ready;
}
async function hash(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].slice(0, 8).map(x => x.toString(16).padStart(2, '0')).join('');
}
const WAT = 3600000; // heure du Bénin (UTC+1)
function weekRange() {
  const d = new Date(Date.now() + WAT);
  const day = (d.getUTCDay() + 6) % 7;
  const a = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day) - WAT; // lundi 00 h (Bénin)
  return [a, a + 6 * 86400000 + 14 * 3600000, a + 7 * 86400000]; // début, fin du concours (dimanche 14 h), fin de semaine
}
const CAPS = { penalty: 5, cosmic: 1000000, enquete: 1 };
const METRIC = { penalty: 'total', cosmic: 'best', enquete: 'total' };
const iso = t => new Date(t + WAT).toISOString().slice(0, 10);
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
      if (url.pathname === '/api/board' && req.method === 'GET') {
        const pid = (url.searchParams.get('pid') || '').toUpperCase();
        if (!ID.test(pid)) return json({ error: 'bad' }, 400);
        const [a, dl] = weekRange();
        const z = dl;
        const top = await env.DB.prepare('SELECT ref, COUNT(*) AS n FROM joins WHERE ts >= ? AND ts < ? GROUP BY ref ORDER BY n DESC, MIN(ts) ASC LIMIT 10').bind(a, z).all();
        const rows = top.results || [];
        const ids = rows.map(r => r.ref);
        const nm = {};
        if (ids.length) {
          const q = await env.DB.prepare('SELECT pid, name FROM names WHERE pid IN (' + ids.map(() => '?').join(',') + ')').bind(...ids).all();
          (q.results || []).forEach(r => { nm[r.pid] = r.name; });
        }
        const me = await env.DB.prepare('SELECT COUNT(*) AS n FROM joins WHERE ref = ? AND ts >= ? AND ts < ?').bind(pid, a, z).first();
        const n = me ? me.n : 0;
        let rank = 0;
        if (n > 0) {
          const r = await env.DB.prepare('SELECT COUNT(*) AS c FROM (SELECT ref FROM joins WHERE ts >= ? AND ts < ? GROUP BY ref HAVING COUNT(*) > ?)').bind(a, z, n).first();
          rank = (r ? r.c : 0) + 1;
        }
        const mine = await env.DB.prepare('SELECT name FROM names WHERE pid = ?').bind(pid).first();
        return json({
          start: iso(a), end: iso(a + 6 * 86400000), deadline: dl, now: Date.now(), closed: Date.now() >= dl,
          top: rows.map(r => ({ name: nm[r.ref] || ('Joueur ' + r.ref.slice(0, 4)), n: r.n })),
          me: { n: n, rank: rank }, myname: mine ? mine.name : ''
        });
      }
      if (url.pathname === '/api/name' && req.method === 'POST') {
        let b;
        try { b = await req.json(); } catch (e) { return json({ error: 'bad' }, 400); }
        const pid = String(b.pid || '').toUpperCase();
        const name = String(b.name || '').trim();
        if (!ID.test(pid) || !/^[\p{L}\p{N} _.\-]{3,14}$/u.test(name)) return json({ ok: false });
        await env.DB.prepare('INSERT INTO names (pid, name) VALUES (?, ?) ON CONFLICT(pid) DO UPDATE SET name = excluded.name').bind(pid, name).run();
        return json({ ok: true });
      }
      if (url.pathname === '/api/score' && req.method === 'POST') {
        let b;
        try { b = await req.json(); } catch (e) { return json({ error: 'bad' }, 400); }
        const pid = String(b.pid || '').toUpperCase();
        const game = String(b.game || '');
        const v = Math.floor(Number(b.value));
        if (!ID.test(pid) || !CAPS[game] || !(v >= 1) || v > CAPS[game]) return json({ ok: false });
        const [a, dl] = weekRange();
        const now = Date.now();
        if (now >= dl) return json({ ok: false, reason: 'closed' });
        await env.DB.prepare("INSERT INTO scores2 (game, week, pid, best, total, n, ts, last) VALUES (?, ?, ?, ?, ?, 1, ?, ?) ON CONFLICT(game, week, pid) DO UPDATE SET ts = CASE WHEN (? = 'best' AND excluded.best <= best) THEN ts ELSE excluded.ts END, best = MAX(best, excluded.best), total = total + excluded.total, n = n + 1, last = excluded.last WHERE scores2.last <= excluded.last - 15000").bind(game, a, pid, v, v, now, now, METRIC[game]).run();
        return json({ ok: true });
      }
      if (url.pathname === '/api/scores' && req.method === 'GET') {
        const pid = (url.searchParams.get('pid') || '').toUpperCase();
        const game = url.searchParams.get('game') || '';
        if (!ID.test(pid) || !CAPS[game]) return json({ error: 'bad' }, 400);
        const col = METRIC[game] === 'best' ? 'best' : 'total';
        const [a, dl] = weekRange();
        const top = await env.DB.prepare('SELECT pid, ' + col + ' AS v FROM scores2 WHERE game = ? AND week = ? ORDER BY v DESC, ts ASC LIMIT 10').bind(game, a).all();
        const rows = top.results || [];
        const ids = rows.map(r => r.pid);
        const nm = {};
        if (ids.length) {
          const q = await env.DB.prepare('SELECT pid, name FROM names WHERE pid IN (' + ids.map(() => '?').join(',') + ')').bind(...ids).all();
          (q.results || []).forEach(r => { nm[r.pid] = r.name; });
        }
        const mine = await env.DB.prepare('SELECT ' + col + ' AS v, ts FROM scores2 WHERE game = ? AND week = ? AND pid = ?').bind(game, a, pid).first();
        const mv = mine ? mine.v : 0;
        let rank = 0;
        if (mv > 0) {
          const r = await env.DB.prepare('SELECT COUNT(*) AS c FROM scores2 WHERE game = ? AND week = ? AND (' + col + ' > ? OR (' + col + ' = ? AND ts < ?))').bind(game, a, mv, mv, mine.ts).first();
          rank = (r ? r.c : 0) + 1;
        }
        return json({
          metric: METRIC[game], deadline: dl, now: Date.now(), closed: Date.now() >= dl,
          top: rows.map(r => ({ name: nm[r.pid] || ('Joueur ' + r.pid.slice(0, 4)), v: r.v })),
          me: { v: mv, rank: rank }
        });
      }
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: 'server' }, 500);
    }
  }
};
