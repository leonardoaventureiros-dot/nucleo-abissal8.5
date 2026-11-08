// Servidor multiplayer do Núcleo Abissal.
// COOPERATIVO: relay de salas via WebSocket; a simulação roda no host (jogador que criou a sala).
// ARENA: o SERVIDOR é a autoridade — cronômetro, nascimentos, itens, vida, eliminações e pontuação.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const AM = require('./arena-map.js');
const { performance } = require('perf_hooks');
const NOW = () => performance.now();   // relógio monotônico do servidor (imune a mudança de hora do sistema)

const PORT = process.env.PORT || 8080;
const AL = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
// Procura o index.html na pasta do servidor (e em ./public), aceitando variações de nome como "Index.html" ou "index (1).html"
function findIndex() {
  for (const dir of [__dirname, path.join(__dirname, 'public')]) {
    let files = [];
    try { files = fs.readdirSync(dir); } catch (e) { continue; }
    const f = files.find(n => n === 'index.html') || files.find(n => /^index.*\.html?$/i.test(n)) || files.find(n => /\.html?$/i.test(n));
    if (f) return path.join(dir, f);
  }
  return null;
}
console.log('Pasta do servidor:', __dirname);
try { console.log('Arquivos aqui:', fs.readdirSync(__dirname).join(', ')); } catch (e) {}
console.log('Jogo encontrado:', findIndex() || 'NENHUM (suba o index.html na mesma pasta do server.js)');

// ---------- HTTP: serve o jogo e um health check ----------
const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  if (url === '/' || url === '/index.html') {
    const file = findIndex();
    if (!file) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('index.html não encontrado. Ele precisa estar na mesma pasta do server.js (raiz do repositório). Pasta atual: ' + __dirname); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Erro ao ler o jogo'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
    return;
  }
  // ---------- arquivos de áudio (pasta audio/): somente leitura, sem sair da pasta ----------
  if (url.startsWith('/audio/')) {
    let rel; try { rel = decodeURIComponent(url.slice(7)); } catch (e) { res.writeHead(400); return res.end('Bad request'); }
    const dir = path.join(__dirname, 'audio'), file = path.join(dir, rel);
    const ext = path.extname(file).toLowerCase();
    const types = { '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.js': 'text/javascript; charset=utf-8' };
    if (!file.startsWith(dir + path.sep) || !types[ext]) { res.writeHead(404); return res.end('Not found'); }
    return fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': types[ext], 'Content-Length': data.length, 'Cache-Control': 'public, max-age=86400' });
      res.end(data);
    });
  }
  res.writeHead(404); res.end('Not found');
});

// ---------- Estado ----------
const rooms = new Map();           // code -> { code, name, pass, max, pub, state, players: Map(id -> player) }
const fails = new Map();           // ip -> { n, t } tentativas de senha erradas

const clean = (s, n) => String(s == null ? '' : s).replace(/[<>]/g, '').slice(0, n);
const nick = s => String(s || '').replace(/[^\w\- \u00C0-\u00FF]/g, '').trim().slice(0, 16) || 'Jogador';
const hex = h => (typeof h === 'string' && /^#[0-9a-fA-F]{6}$/.test(h));
const look = l => ({ shirt: hex(l && l.shirt) ? l.shirt : '#3a8a3a', pants: hex(l && l.pants) ? l.pants : '#6e6e74', helm: hex(l && l.helm) ? l.helm : '#6e6e74' });
const send = (ws, o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
const newCode = () => { let c; do { c = Array.from({ length: 5 }, () => AL[crypto.randomInt(AL.length)]).join(''); } while (rooms.has(c)); return c; };
const info = r => ({ name: r.name, max: r.max, mode: r.mode, dur: r.dur | 0, pub: r.pub ? 1 : 0, state: r.state, lock: r.pass ? 1 : 0 });
const roster = r => [...r.players.values()].map(p => ({ id: p.id, nick: p.nick, look: p.look, host: p.host ? 1 : 0 }));
const abc = (r, o) => { for (const p of r.players.values()) send(p.ws, { t: 'a', ...o }); };   // broadcast de mensagens da Arena
const clampN = (v, a, b, d) => { v = +v; return Number.isFinite(v) ? Math.min(b, Math.max(a, v)) : d; };
const bcast = (r, o, except) => { for (const p of r.players.values()) if (p.ws !== except) send(p.ws, o); };

function blocked(ip) { const f = fails.get(ip); return f && Date.now() - f.t < 60000 && f.n >= 6; }
function fail(ip) { const f = fails.get(ip); if (!f || Date.now() - f.t >= 60000) fails.set(ip, { n: 1, t: Date.now() }); else f.n++; }

function leave(ws) {
  const r = ws.room; if (!r) return;
  const me = r.players.get(ws.pid);
  ws.room = null; ws.pid = null;
  if (!me) return;
  if (arenaOf(r)) {                                   // Arena: o servidor manda; a saída do host não derruba a sala
    r.players.delete(me.id);
    if (r.m && r.state === 'play' && me.a) {          // guarda o placar de quem saiu durante a partida
      r.m.gone.push({ id: me.id, nick: me.nick, look: me.look, score: me.a.score, kills: me.a.kills, deaths: me.a.deaths, slot: me.a.slot });
      abc(r, { k: 'left', id: me.id, sc: arenaScores(r) });
    }
    if (!r.players.size) { arenaStop(r); rooms.delete(r.code); return; }
    if (me.host) { const nh = r.players.values().next().value; nh.host = true; }
    bcast(r, { t: 'roster', roster: roster(r), info: info(r) });
    if (r.state === 'play' && r.players.size < 2) arenaFinish(r, 'abandono');   // sobrou só 1 jogador
    return;
  }
  if (me.host) {
    for (const p of r.players.values()) if (p.ws !== ws) { send(p.ws, { t: 'closed', msg: 'O host encerrou a sala' }); p.ws.room = null; p.ws.pid = null; }
    rooms.delete(r.code);
  } else {
    r.players.delete(me.id);
    bcast(r, { t: 'roster', roster: roster(r), info: info(r) });
  }
}

// =====================================================================
//  ARENA — motor autoritativo (tudo que vale ponto é decidido aqui)
// =====================================================================
const A_CD = 3000;            // contagem regressiva antes da partida (ms)
const A_RESP = 3000;          // tempo de espera para reaparecer (ms)
const A_INV = 2500;           // invulnerabilidade após reaparecer (ms)
const A_ITEM_EVERY = 10000;   // novos suprimentos a cada 10 s
const A_ITEM_MAX = 10;        // limite de itens simultâneos no mapa
const A_ITEM_REACH = 3.4;     // distância máxima (servidor) p/ aceitar a coleta
const A_PTS_KILL = 100, A_PTS_HEAD = 25;
// tabela de armas (espelha WD do cliente): dano, mult. de cabeça, cadência, alcance
const AW = [
  { d: 24, hm: 2, rate: .26, rng: 130 },
  { d: 10, hm: 2, rate: .8, rng: 40, pel: 11 },
  { d: 11, hm: 2, rate: .085, rng: 130 },
  { d: 130, rate: .9, rad: 6, expl: 1 },
  { d: 10, rate: .09, rng: 4.6, saw: 1 },
  { d: 9, hm: 2, rate: .045, rng: 130 },
  { d: 55, hm: 4.7, rate: 1.3, rng: 320 },
  null,
  { d: 150, rate: 6, rad: 7, expl: 1 }
];
const arenaOf = r => r && r.mode === 'arena';
const aAlive = r => [...r.players.values()].filter(p => p.a && p.a.alive);

function arenaReset(r) {
  const ps = [...r.players.values()];
  ps.forEach((p, i) => {
    const sp = AM.spawns[i % 4];
    p.a = { slot: i % 4, score: 0, kills: 0, deaths: 0, hp: 100, ar: 50, alive: true, respawnAt: 0, inv: 0,
            x: sp.x, y: sp.y, z: sp.z, t: NOW(), bucket: {}, lastHit: 0 };
  });
}

function arenaStart(r) {
  arenaReset(r);
  const t = NOW();
  r.state = 'play';
  r.m = { phase: 'cd', t0: t, startAt: t + A_CD, endAt: t + A_CD + r.dur * 1000, items: new Map(), nid: 0, nextItem: 0,
          kid: 0, gone: [], lastTick: 0, iv: null };
  const sp = {}; for (const p of r.players.values()) { const s = AM.spawns[p.a.slot]; sp[p.id] = [s.x, s.y, s.z, +s.yaw.toFixed(3)]; }
  const msg = { k: 'start', cd: A_CD, dur: r.dur,
    map: { b: AM.boxes.map(b => b.map(v => typeof v === 'number' ? Math.round(v * 100) / 100 : v)), l: AM.lights, zc: AM.ZC },
    sp, ros: [...r.players.values()].map(p => ({ id: p.id, nick: p.nick, look: p.look, slot: p.a.slot, host: p.host ? 1 : 0 })) };
  abc(r, msg);
  r.m.iv = setInterval(() => arenaTick(r), 100);
}

function arenaScores(r) {
  const o = [];
  for (const p of r.players.values()) if (p.a) o.push([p.id, p.a.score, p.a.kills, p.a.deaths]);
  for (const g of r.m.gone) o.push([g.id, g.score, g.kills, g.deaths]);
  return o;
}
const itemList = r => [...r.m.items.values()].map(i => [i.id, i.k, i.x, i.y, i.z]);

function arenaPickSpawn(r, p) {
  // reaparecimento: ponto mais distante dos adversários vivos
  const others = aAlive(r).filter(q => q !== p);
  let best = null, bs = -1;
  for (const s of AM.respawns) {
    let md = 1e9; for (const q of others) md = Math.min(md, Math.hypot(q.a.x - s.x, q.a.z - s.z));
    const sc = md + Math.random() * 6;
    if (md > 4 && sc > bs) { bs = sc; best = s; }
  }
  return best || AM.respawns[Math.floor(Math.random() * AM.respawns.length)];
}

function arenaSpawnItems(r) {
  const m = r.m, want = r.players.size >= 4 ? 3 : 2, kinds = ['hp', 'ar', 'am'].sort(() => Math.random() - .5), added = [];
  for (let n = 0; n < want && m.items.size < A_ITEM_MAX; n++) {
    let pt = null;
    for (let tries = 0; tries < 40 && !pt; tries++) {
      const c = AM.itemPts[Math.floor(Math.random() * AM.itemPts.length)];
      let ok = true;
      for (const it of m.items.values()) if (Math.hypot(it.x - c.x, it.z - c.z) < (tries < 30 ? 12 : 4)) { ok = false; break; }
      if (ok) for (const q of aAlive(r)) if (Math.hypot(q.a.x - c.x, q.a.z - c.z) < 3) { ok = false; break; }
      if (ok) pt = c;
    }
    if (!pt) continue;
    const it = { id: ++m.nid, k: kinds[n % 3], x: pt.x, y: pt.y, z: pt.z };
    m.items.set(it.id, it); added.push([it.id, it.k, it.x, it.y, it.z]);
  }
  if (added.length) abc(r, { k: 'iadd', it: added });
}

function arenaTick(r) {
  const m = r.m; if (!m || r.state !== 'play') return;
  const t = NOW();
  if (m.phase === 'cd' && t >= m.startAt) { m.phase = 'run'; m.nextItem = t + A_ITEM_EVERY; abc(r, { k: 'go', rem: Math.round(m.endAt - t) }); }
  if (m.phase === 'run') {
    for (const p of r.players.values()) {                       // reaparecimentos
      const a = p.a; if (a.alive || t < a.respawnAt) continue;
      const s = arenaPickSpawn(r, p);
      Object.assign(a, { alive: true, hp: 100, ar: 25, inv: t + A_INV, x: s.x, y: s.y, z: s.z, t });
      abc(r, { k: 'resp', id: p.id, x: s.x, y: s.y, z: s.z, yaw: +s.yaw.toFixed(3), hp: a.hp, ar: a.ar });
    }
    if (t >= m.nextItem) { m.nextItem += A_ITEM_EVERY; arenaSpawnItems(r); }
    if (t >= m.endAt) return arenaFinish(r, 'tempo');
  }
  if (t - m.lastTick >= 1000) {                                 // sincronismo a cada 1 s (tempo restante, placar e itens)
    m.lastTick = t;
    abc(r, { k: 'tick', ph: m.phase, rem: Math.max(0, Math.round((m.phase === 'cd' ? m.startAt : m.endAt) - t)), sc: arenaScores(r), it: itemList(r) });
  }
}

function arenaRank(r) {
  const rows = [];
  for (const p of r.players.values()) rows.push({ id: p.id, nick: p.nick, look: p.look, score: p.a.score, kills: p.a.kills, deaths: p.a.deaths, gone: 0, slot: p.a.slot });
  for (const g of r.m.gone) rows.push({ id: g.id, nick: g.nick, look: g.look, score: g.score, kills: g.kills, deaths: g.deaths, gone: 1, slot: g.slot });
  rows.sort((a, b) => b.score - a.score || b.kills - a.kills || a.slot - b.slot);
  let pl = 0;
  rows.forEach((x, i) => { const pv = rows[i - 1]; x.pl = (pv && pv.score === x.score && pv.kills === x.kills) ? pv.pl : i + 1; });
  return rows;
}

function arenaFinish(r, why) {
  const m = r.m; if (!m || r.state !== 'play') return;
  clearInterval(m.iv); m.iv = null; m.phase = 'end';
  r.state = 'over';
  abc(r, { k: 'end', why, rank: arenaRank(r) });
  bcast(r, { t: 'roster', roster: roster(r), info: info(r) });
}

function arenaStop(r) { if (r.m && r.m.iv) { clearInterval(r.m.iv); r.m.iv = null; } }

// ---- dano: o cliente apenas REPORTA acertos; o servidor valida e decide ----
function arenaHits(ws, list) {
  const r = ws.room; if (!arenaOf(r) || r.state !== 'play' || !r.m || r.m.phase !== 'run' || !Array.isArray(list)) return;
  const me = r.players.get(ws.pid); if (!me || !me.a || !me.a.alive) return;
  const t = NOW();
  for (const h of list.slice(0, 8)) {
    if (!Array.isArray(h)) continue;
    const vic = r.players.get(String(h[0])), w = h[1] | 0, wd = AW[w];
    if (!vic || vic === me || !wd || !vic.a.alive || t < vic.a.inv) continue;
    let n = clampN(h[2], 1, wd.pel || 14, 1) | 0, hn = clampN(h[3], 0, n, 0) | 0;
    // limite de cadência (balde de fichas por jogador e arma): impede disparos impossíveis
    const b = me.a.bucket[w] || (me.a.bucket[w] = { tk: 4, t });
    b.tk = Math.min(4, b.tk + (t - b.t) / 1000 / wd.rate * 1.15); b.t = t;
    const cost = wd.pel || wd.expl ? 1 : n;
    if (b.tk < cost - 0.01) continue;
    b.tk -= cost;
    const dx = vic.a.x - me.a.x, dz = vic.a.z - me.a.z, dist = Math.hypot(dx, dz), dy = vic.a.y - me.a.y;
    let dmg = 0, head = hn > 0;
    if (wd.expl) {
      const ex = clampN(h[4], -90, 90, NaN), ez = clampN(h[5], AM.ZC - 90, AM.ZC + 90, NaN);
      if (!Number.isFinite(ex) || !Number.isFinite(ez)) continue;
      if (Math.hypot(ex - me.a.x, ez - me.a.z) > 100) continue;            // explosão longe demais do atirador
      const dv = Math.hypot(ex - vic.a.x, ez - vic.a.z);
      if (dv > wd.rad + 2) continue;                                       // vítima fora do raio (com folga p/ latência)
      dmg = wd.d * Math.max(.25, 1 - .7 * Math.min(1, dv / wd.rad)); head = false;
    } else {
      if (dist > wd.rng + 8 || Math.abs(dy) > 14) continue;
      if (dist > 2.8) {                                                    // sem atravessar paredes (3 pontos do corpo)
        const ey = me.a.y + 1.6, ax = me.a.x, az = me.a.z;
        if (!(AM.segClear(ax, ey, az, vic.a.x, vic.a.y + 1.5, vic.a.z) || AM.segClear(ax, ey, az, vic.a.x, vic.a.y + 1.0, vic.a.z) || AM.segClear(ax, ey, az, vic.a.x, vic.a.y + .4, vic.a.z))) continue;
      }
      const fall = wd.pel ? 1 - Math.min(.7, Math.max(0, dist / 25)) : 1;
      dmg = wd.d * ((n - hn) + hn * (wd.hm || 2)) * fall;
    }
    dmg = Math.min(dmg, 300);
    arenaDamage(r, me, vic, dmg, head);
    if (r.state !== 'play') return;
  }
}

function arenaDamage(r, killer, vic, dmg, head) {
  const a = vic.a, t = NOW();
  const ab = Math.min(a.ar, dmg * .6); a.ar -= ab; a.hp -= dmg - ab; a.lastHit = t;
  if (a.hp > 0) { send(vic.ws, { t: 'a', k: 'ap', hp: Math.ceil(a.hp), ar: Math.ceil(a.ar) }); return; }
  // eliminação: registrada UMA vez (a vítima fica morta até o reaparecimento; novos tiros são ignorados)
  a.hp = 0; a.alive = false; a.deaths++; a.respawnAt = t + A_RESP;
  killer.a.kills++; killer.a.score += A_PTS_KILL + (head ? A_PTS_HEAD : 0);
  const kid = ++r.m.kid;
  abc(r, { k: 'kill', kid, kr: killer.id, vc: vic.id, h: head ? 1 : 0, sc: arenaScores(r), rs: A_RESP });
}

function arenaPick(ws, id) {
  const r = ws.room; if (!arenaOf(r) || r.state !== 'play' || !r.m || r.m.phase !== 'run') return;
  const p = r.players.get(ws.pid); if (!p || !p.a.alive) return;
  const it = r.m.items.get(id | 0); if (!it) return;                        // já coletado por outro jogador
  if (Math.hypot(it.x - p.a.x, it.z - p.a.z) > A_ITEM_REACH || Math.abs(it.y - p.a.y) > 3.5) return;
  const a = p.a;
  if (it.k === 'hp') { if (a.hp >= 100) return; a.hp = Math.min(100, a.hp + 35); }
  else if (it.k === 'ar') { if (a.ar >= 100) return; a.ar = Math.min(100, a.ar + 35); }
  r.m.items.delete(it.id);                                                 // remove ANTES de responder: coleta única
  abc(r, { k: 'idel', id: it.id, by: p.id });
  send(ws, { t: 'a', k: 'give', kind: it.k, hp: Math.ceil(a.hp), ar: Math.ceil(a.ar) });
}

// posição do jogador conforme o próprio cliente informa, limitada por velocidade (anti-teleporte)
function arenaTrack(r, p, m) {
  const a = p.a, t = NOW(), dt = Math.min(1, Math.max(.05, (t - a.t) / 1000));
  const x = clampN(m.x, -62, 62, a.x), y = clampN(m.y, -2, 30, a.y), z = clampN(m.z, AM.ZC - 62, AM.ZC + 62, a.z);
  if (Math.hypot(x - a.x, z - a.z) <= 48 * dt + 2.5) { a.x = x; a.y = y; a.z = z; a.t = t; }
}

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server, maxPayload: 32 * 1024 });

wss.on('connection', (ws, req) => {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  ws.isAlive = true; ws.room = null; ws.pid = null; ws.cnt = 0; ws.cntT = Date.now();
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', raw => {
    // limite de taxa: ~300 msgs/s por conexão
    const now = Date.now();
    if (now - ws.cntT > 1000) { ws.cnt = 0; ws.cntT = now; }
    if (++ws.cnt > 300) return;

    let o; try { o = JSON.parse(raw); } catch (e) { return; }
    if (!o || typeof o.t !== 'string') return;

    // repasse de mensagens do jogo
    if (o.t === 'g') {
      const r = ws.room; if (!r || !o.m || typeof o.m !== 'object') return;
      o.m.f = ws.pid;                       // impede falsificar remetente
      if (arenaOf(r)) {                     // Arena: só estado ('s') e foguetes visuais ('r'); servidor sobrescreve vida/morte
        if (r.state !== 'play' || (o.m.t !== 's' && o.m.t !== 'r')) return;
        const me = r.players.get(ws.pid); if (!me || !me.a) return;
        if (o.m.t === 's') { if (me.a.alive) arenaTrack(r, me, o.m); o.m.h = Math.ceil(me.a.hp); o.m.d = me.a.alive ? 0 : 1; }
        else if (!me.a.alive) return;
        delete o.m.to;
      }
      const out = { t: 'g', m: o.m };
      if (o.m.to) { const p = r.players.get(String(o.m.to)); if (p) send(p.ws, out); }
      else bcast(r, out, ws);
      return;
    }

    switch (o.t) {
      case 'create': {
        if (ws.room) return;
        const code = newCode(), id = crypto.randomBytes(4).toString('hex');
        const mode = o.mode === 'arena' ? 'arena' : 'coop', dur = Math.round(clampN(o.dur, 60, 3600, 600));   // duração em segundos (1 a 60 min)
        const r = { code, name: clean(o.name, 24) || 'Sala', pass: clean(o.pass, 32), max: Math.min(4, Math.max(2, o.max | 0 || 4)), pub: !!o.pub, mode, dur: mode === 'arena' ? dur : 0, state: 'wait', players: new Map() };
        r.players.set(id, { id, ws, nick: nick(o.nick), look: look(o.look), host: true });
        rooms.set(code, r); ws.room = r; ws.pid = id;
        send(ws, { t: 'created', id, code, info: info(r), roster: roster(r) });
        break;
      }
      case 'join': {
        if (ws.room) return;
        if (blocked(ip)) return send(ws, { t: 'err', c: 'muitas_tentativas' });
        const r = rooms.get(String(o.code || '').toUpperCase());
        if (!r) return send(ws, { t: 'err', c: 'nao_existe' });
        if (r.state !== 'wait' && !(arenaOf(r) && r.state === 'over')) return send(ws, { t: 'err', c: 'em_partida' });
        if (r.players.size >= r.max) return send(ws, { t: 'err', c: 'cheia' });
        if (r.pass && clean(o.pass, 32) !== r.pass) { fail(ip); return send(ws, { t: 'err', c: 'senha' }); }
        const id = crypto.randomBytes(4).toString('hex');
        r.players.set(id, { id, ws, nick: nick(o.nick), look: look(o.look), host: false });
        ws.room = r; ws.pid = id;
        send(ws, { t: 'joined', id, code: r.code, info: info(r), roster: roster(r) });
        bcast(r, { t: 'roster', roster: roster(r), info: info(r) }, ws);
        break;
      }
      case 'list': {
        const list = [];
        for (const r of rooms.values()) if (r.pub && (r.state === 'wait' || (arenaOf(r) && r.state === 'over'))) list.push({ code: r.code, name: r.name, n: r.players.size, max: r.max, lock: r.pass ? 1 : 0, mode: r.mode, dur: r.dur | 0 });
        send(ws, { t: 'list', rooms: list.slice(0, 20) });
        break;
      }
      case 'start': {
        const r = ws.room; if (!r) return;
        const me = r.players.get(ws.pid); if (!me || !me.host) return;
        if (arenaOf(r)) {                                         // ARENA: iniciar (ou jogar novamente) — mínimo de 2 jogadores
          if (r.state !== 'wait' && r.state !== 'over') return;
          if (r.players.size < 2) return send(ws, { t: 'err', c: 'poucos' });
          arenaStart(r); break;
        }
        if (r.state !== 'wait') return;
        r.state = 'play';
        bcast(r, { t: 'start', sd: crypto.randomInt(1e9), sw: Math.min(29, Math.max(0, o.sw | 0)), df: Math.min(2, Math.max(0, o.df | 0)) });
        break;
      }
      case 'ah': arenaHits(ws, o.a); break;                       // acertos reportados (validados no servidor)
      case 'apick': arenaPick(ws, o.id); break;                    // pedido de coleta de item
      case 'tolobby': {                                            // host devolve a sala ao lobby
        const r = ws.room; if (!arenaOf(r)) return;
        const me = r.players.get(ws.pid); if (!me || !me.host || r.state !== 'over') return;
        r.state = 'wait'; r.m = null;
        abc(r, { k: 'lobby' }); bcast(r, { t: 'roster', roster: roster(r), info: info(r) });
        break;
      }
      case 'leave': leave(ws); break;
    }
  });

  ws.on('close', () => leave(ws));
  ws.on('error', () => {});
});

// mantém conexões vivas (importante no Render) e derruba as mortas
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false; try { ws.ping(); } catch (e) {}
  }
}, 25000);

{ const e = AM.validate(); console.log('Mapa da Arena:', AM.boxes.length, 'caixas,', AM.itemPts.length, 'pontos de item,', e.length ? 'ERROS: ' + e.join('; ') : 'validado OK'); }
server.listen(PORT, () => console.log('Núcleo Abissal rodando na porta ' + PORT));
