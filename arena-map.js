// Núcleo Abissal — mapa exclusivo da ARENA ("Forja Abissal").
// Fonte única da verdade: o servidor usa estes dados para spawns, itens e validação de tiro,
// e envia a lista de caixas ao cliente, que monta a geometria e as colisões a partir dela.
// Coordenadas de mundo: o mapa fica centrado em (0, ZC), longe das salas do modo cooperativo.
'use strict';

const ZC = 400;          // centro do mapa no eixo Z (as salas cooperativas ficam em z <= 30)
const H = 60;            // meio-lado da área jogável (120 x 120)
// materiais: 0 piso · 1 parede · 2 metal · 3 escuro · 4 caixote enferrujado · 5 brilho vermelho · 6 brilho lava · 7 brilho azul
const boxes = [];        // [x, y, z, w, h, d, material, sólido]
const add = (x, y, z, w, h, d, m, solid) => boxes.push([x, y, ZC + z, w, h, d, m, solid === false ? 0 : 1]);
// y = centro vertical. Helper para blocos apoiados no chão (altura h, base em 0)
const blk = (x, z, w, d, h, m) => add(x, h / 2, z, w, h, d, m);

// ---------- Estrutura externa ----------
add(0, -0.5, 0, 2 * H + 4, 1, 2 * H + 4, 0, false);                 // piso (não sólido; o chão é y=0)
add(0, 7, -H - 1, 2 * H + 4, 14, 2, 1); add(0, 7, H + 1, 2 * H + 4, 14, 2, 1);
add(-H - 1, 7, 0, 2, 14, 2 * H, 1);     add(H + 1, 7, 0, 2, 14, 2 * H, 1);
for (const s of [-1, 1]) {                                          // faixas de aviso e vigas no alto das paredes
  add(0, 13.4, s * (H - 0.2), 2 * H, 0.5, 0.5, 5, false);
  add(s * (H - 0.2), 13.4, 0, 0.5, 0.5, 2 * H, 5, false);
}
for (let i = -2; i <= 2; i++) { add(i * 24, 10, -H + 0.3, 3, 0.6, 0.3, 6, false); add(i * 24, 10, H - 0.3, 3, 0.6, 0.3, 6, false); }

// ---------- Cantos: casulos de nascimento (barreiras em L com abertura diagonal) ----------
for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
  blk(sx * 41, sz * 53.5, 1.6, 13, 3.4, 1);                          // parede ao longo de Z
  blk(sx * 53.5, sz * 41, 13, 1.6, 3.4, 1);                          // parede ao longo de X
  blk(sx * 47.5, sz * 47.5, 2.4, 2.4, 5.2, 2);                       // coluna de reforço no vértice interno
  add(sx * 53, 0.04, sz * 53, 9, 0.08, 9, 5, false);                 // plataforma luminosa de nascimento
  blk(sx * 57, sz * 47, 2.2, 2.2, 2.2, 4);                           // caixote de cobertura dentro do casulo
}

// ---------- Centro: a Forja (plataforma elevada com fornalha e rampas nos 4 lados) ----------
blk(0, 0, 24, 24, 1.65, 2);
blk(0, 0, 7, 7, 5.2 + 1.65 - 1.65, 3);                                // núcleo da fornalha (topo em 5,2)
add(0, 1.65 + 2.6, 0, 7.2, 0.3, 7.2, 6, false);
for (const [sx, sz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
  for (let k = 1; k <= 3; k++) {                                     // degraus de 0,55 m
    const d0 = 12 + (3 - k) * 1.8 + 0.9, hh = 0.55 * k;
    add(sx * d0, hh / 2, sz * d0, sx ? 1.8 : 8, hh, sx ? 8 : 1.8, 2);
  }
  for (const sd of [-1, 1]) {                                        // muretas laterais ao longo da rampa
    if (sx) add(sx * 14.7, 0.55, sd * 4.4, 5.4, 1.1, 0.3, 3); else add(sd * 4.4, 0.55, sz * 14.7, 0.3, 1.1, 5.4, 3);
  }
}
for (const s of [-1, 1]) {                                           // canais de metal fundido (decorativos, sem dano)
  add(0, 0.03, s * 15, 30, 0.06, 0.6, 6, false); add(s * 15, 0.03, 0, 0.6, 0.06, 30, 6, false);
}

// ---------- Flancos norte/sul: pontes elevadas com escadas nas duas pontas ----------
for (const sz of [-1, 1]) {
  blk(0, sz * 36, 26, 8, 2.2, 2);
  blk(0, sz * 39.6, 26, 0.8, 3.3, 3);                                // parapeito do lado da parede
  for (const sx of [-1, 1]) for (let k = 1; k <= 3; k++) {
    const d0 = 13 + 1.8 * (4 - k) - 0.9 + 0.9, hh = 0.55 * k;
    add(sx * (d0 + 0.9), hh / 2, sz * 36, 1.8, hh, 5, 2);
  }
  blk(-8, sz * 52, 4, 4, 2.6, 4); blk(8, sz * 52, 4, 4, 2.6, 4);   // caixotes do cais
  blk(0, sz * 47, 10, 1.2, 1.5, 3);                                  // barreira baixa
}

// ---------- Flancos leste/oeste: pátio de contêineres ----------
for (const sx of [-1, 1]) {
  blk(sx * 32, -10, 3.6, 14, 3.6, 4); blk(sx * 32, 10, 3.6, 14, 3.6, 4);
  blk(sx * 32, 0, 2.2, 2.2, 1.6, 3);
  blk(sx * 25.5, -17, 4, 4, 2.2, 4); blk(sx * 25.5, 17, 4, 4, 2.2, 4);
  blk(sx * 50, -9, 9, 1.4, 3, 1); blk(sx * 50, 9, 9, 1.4, 3, 1);    // bunker de borda
}

// ---------- Quadrantes: fundições (pilar alto + caixotes + barreiras) ----------
for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
  const qx = sx * 24, qz = sz * 24;
  blk(qx, qz, 4, 4, 14, 3);
  add(qx, 3, qz, 4.3, 0.25, 4.3, 5, false); add(qx, 7, qz, 4.3, 0.25, 4.3, 5, false);
  blk(sx * 17, sz * 27, 2.4, 2.4, 2.4, 4);
  blk(sx * 31, sz * 21, 3.2, 3.2, 3.2, 4);
  blk(sx * 22, sz * 33, 7, 1.2, 1.6, 2);
  blk(sx * 12, sz * 31, 1.4, 6, 1.6, 2);
}

// ---------- Luzes (poucas, para rodar bem em 4 jogadores no celular) ----------
const lights = [[0, 9, ZC, 0xff6a1a, 2.4, 52]];
for (const sx of [-1, 1]) for (const sz of [-1, 1]) lights.push([sx * 40, 6, ZC + sz * 40, 0xff3a1a, 1.2, 36]);

// ---------- Nascimentos: slot 0 = sup. esq., 1 = sup. dir., 2 = inf. esq., 3 = inf. dir. ----------
// "superior" = norte = -Z (o jogo olha para -Z por padrão)
const SPAWN_XZ = [[-53, -53], [53, -53], [-53, 53], [53, 53]];
const EXTRA_XZ = [[0, -56], [0, 56], [-56, 0], [56, 0]];       // usados só em reaparecimentos
const mkSp = ([x, z]) => ({ x, y: 0, z: ZC + z, yaw: Math.atan2(-(0 - x), -(ZC - (ZC + z))) });
const spawns = SPAWN_XZ.map(mkSp);
const respawns = SPAWN_XZ.concat(EXTRA_XZ).map(mkSp);

// ---------- Geometria p/ validação: altura do terreno e acessibilidade ----------
const solids = boxes.filter(b => b[7]).map(b => ({ x0: b[0] - b[3] / 2, x1: b[0] + b[3] / 2, y0: b[1] - b[4] / 2, y1: b[1] + b[4] / 2, z0: b[2] - b[5] / 2, z1: b[2] + b[5] / 2 }));
function groundH(x, z) {                                        // topo mais alto sob (x,z); blocos sólidos do chão ao topo
  let h = 0;
  for (const c of solids) if (x > c.x0 && x < c.x1 && z > c.z0 && z < c.z1 && c.y1 > h) h = c.y1;
  return h;
}
const inside = (x, z) => Math.abs(x) < H - 0.5 && Math.abs(z - ZC) < H - 0.5;
// ponto livre para um jogador (raio 0,4 / altura 1,78) em y = chão
function clearAt(x, z, rad) {
  const r = rad || 0.45, h0 = groundH(x, z);
  if (!inside(x, z)) return false;
  for (const c of solids)
    if (x + r > c.x0 && x - r < c.x1 && z + r > c.z0 && z - r < c.z1 && c.y1 > h0 + 0.6 && c.y0 < h0 + 1.78) return false;
  return true;
}
// varredura de acessibilidade (grade de 0,5 m, degrau máximo 0,6 m como o movimento do jogo)
function reach(startX, startZ) {
  const S = 0.5, W = Math.round(2 * H / S), key = (i, j) => i * (W + 2) + j;
  const toI = x => Math.round((x + H) / S), toJ = z => Math.round((z - ZC + H) / S);
  const seen = new Set(), q = [[toI(startX), toJ(startZ)]];
  seen.add(key(q[0][0], q[0][1]));
  const wx = i => i * S - H, wz = j => ZC + j * S - H;
  while (q.length) {
    const [i, j] = q.pop(), x = wx(i), z = wz(j), h = groundH(x, z);
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
      const ni = i + di, nj = j + dj, k = key(ni, nj);
      if (seen.has(k)) continue;
      const nx = wx(ni), nz = wz(nj);
      if (!clearAt(nx, nz, 0.4)) continue;
      if (groundH(nx, nz) - h > 0.6) continue;
      seen.add(k); q.push([ni, nj]);
    }
  }
  return { has: (x, z) => seen.has(key(toI(x), toJ(z))), size: seen.size };
}

// ---------- Pontos de itens: grade de 6 m, só células livres e acessíveis dos 4 nascimentos ----------
const r0 = reach(spawns[0].x, spawns[0].z);
const itemPts = [];
for (let x = -54; x <= 54; x += 6) for (let z = -54; z <= 54; z += 6) {
  const wz = ZC + z;
  if (!clearAt(x, wz, 1.0) || !r0.has(x, wz)) continue;
  if (Math.hypot(Math.abs(x) - 53, Math.abs(z) - 53) < 6) continue;    // não nas plataformas de nascimento
  itemPts.push({ x, y: groundH(x, wz), z: wz });
}

function validate() {
  const errs = [];
  const rs = SPAWN_XZ.map((_, i) => reach(spawns[i].x, spawns[i].z));
  respawns.forEach((s, i) => {
    if (!clearAt(s.x, s.z, 0.6)) errs.push('spawn ' + i + ' dentro de obstáculo ou fora do mapa');
    if (!inside(s.x, s.z)) errs.push('spawn ' + i + ' fora do mapa');
    if (!rs[0].has(s.x, s.z)) errs.push('spawn ' + i + ' inacessível a partir do canto 1');
  });
  for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++)
    if (Math.hypot(spawns[a].x - spawns[b].x, spawns[a].z - spawns[b].z) < 20) errs.push('spawns ' + a + '/' + b + ' sobrepostos');
  for (const p of itemPts) if (!clearAt(p.x, p.z, 0.8)) errs.push('item inválido em ' + p.x + ',' + p.z);
  if (itemPts.length < 20) errs.push('poucos pontos de item: ' + itemPts.length);
  return errs;
}

// ---------- Teste de linha de visão segmento x caixas (usado pelo servidor p/ validar tiros) ----------
function segClear(ax, ay, az, bx, by, bz) {
  const dx = bx - ax, dy = by - ay, dz = bz - az, M = 0.18;       // M: tolerância nas quinas (latência)
  for (const c of solids) {
    if (c.y1 - c.y0 > 20) { /* paredes externas: nada a testar dentro do mapa */ }
    let t0 = 0, t1 = 1, ok = true;
    for (const [o, d, lo, hi] of [[ax, dx, c.x0 + M, c.x1 - M], [ay, dy, c.y0, c.y1], [az, dz, c.z0 + M, c.z1 - M]]) {
      if (hi <= lo) { ok = false; break; }
      if (Math.abs(d) < 1e-9) { if (o < lo || o > hi) { ok = false; break; } }
      else { let ta = (lo - o) / d, tb = (hi - o) / d; if (ta > tb) { const t = ta; ta = tb; tb = t; } t0 = Math.max(t0, ta); t1 = Math.min(t1, tb); if (t0 > t1) { ok = false; break; } }
    }
    if (ok) return false;
  }
  return true;
}

module.exports = { ZC, H, boxes, lights, spawns, respawns, itemPts, validate, segClear, clearAt, groundH, reach, inside };
