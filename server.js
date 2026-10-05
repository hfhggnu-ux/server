// Animal Battle Royale - authoritative WebSocket server (Node.js)
// รันบน Render เป็น Web Service: Build = npm install, Start = npm start
const http = require('http');
const { WebSocketServer } = require('ws');
const { buildMap, rayBox } = require('./map');

const PORT = process.env.PORT || 10000;

const CFG = {
  tick: 20,
  maxPlayers: 20,
  minPlayers: +(process.env.MIN_PLAYERS || 2), // ตอนเทสคนเดียวตั้ง MIN_PLAYERS=1
  lobbyWait: 15,
  endWait: 8,
  spawnRadius: 80,
  zoneStart: 100,
  zoneMin: 8,
  zoneShrink: 0.8,   // เมตร/วินาที
  zoneDps: 4,
  fireCooldown: 0.25,
  range: 100,
  hitRadius: 0.8,
  damage: 20,
};

const ANIMALS = {
  lion:      { hp: 110, speed: 7.0 },
  tiger:     { hp: 100, speed: 7.5 },
  wolf:      { hp: 90,  speed: 8.0 },
  bear:      { hp: 140, speed: 6.0 },
  gorilla:   { hp: 130, speed: 6.3 },
  crocodile: { hp: 120, speed: 6.5 },
  rhino:     { hp: 150, speed: 5.8 },
  eagle:     { hp: 80,  speed: 8.5 },
  tam:       { hp: 95,  speed: 8.0 },   // OC Tam
};

// ตัวเลือกแต่งตัว (ค่าสูงสุดของแต่ละช่อง) - ต้องตรงกับ AnimalFactory.gd
const LOOK_MAX = { skin: 4, color: 7, hat: 4, top: 1, acc: 3 };   // top: 0 ไม่ใส่ / 1 เสื้อกั๊ก (เกราะต้องไปหาในเกม)
function cleanLook(l) {
  const out = {};
  for (const k in LOOK_MAX) {
    const v = l && Number.isInteger(l[k]) ? l[k] : 0;
    out[k] = Math.min(LOOK_MAX[k], Math.max(0, v));
  }
  return out;
}

// ---- แมพ: บ้าน ลัง ต้นไม้ ฯลฯ (ใช้บังกระสุน + ส่งให้เกมสร้าง) ----
const MAP_SEED = +(process.env.MAP_SEED || 20260930);
const MAP = buildMap(MAP_SEED);
const MAP_WIRE = MAP.boxes.map(b => [b.t, b.c, b.x, b.y, b.z, b.sx, b.sy, b.sz]);

function blocked(x, z, m) {
  return MAP.boxes.some(b => Math.abs(x - b.x) < b.sx / 2 + m && Math.abs(z - b.z) < b.sz / 2 + m);
}
function safeSpawn(minR, maxR) {
  for (let i = 0; i < 60; i++) {
    const a = Math.random() * Math.PI * 2, d = minR + Math.random() * (maxR - minR);
    const x = Math.cos(a) * d, z = Math.sin(a) * d;
    if (!blocked(x, z, 1.3)) return [x, 1, z];
  }
  return [(Math.random() - 0.5) * 10, 1, (Math.random() - 0.5) * 10];
}

// ---- อาวุธ 4 ตระกูล (ตัวเลขต้องตรงกับ WeaponFactory.gd ฝั่งเกม: cd = วินาทีต่อนัด) ----
const WEAPON_ORDER = ['pistol', 'rifle', 'shotgun', 'sniper', 'sword', 'spartan', 'dagger'];
const WEAPONS = {
  pistol:  { dmg: 18, cd: 0.30, range: 70,  spread: 0.010, pellets: 1 },
  rifle:   { dmg: 12, cd: 0.11, range: 100, spread: 0.020, pellets: 1 },
  shotgun: { dmg: 9,  cd: 0.90, range: 32,  spread: 0.070, pellets: 8 },
  sniper:  { dmg: 70, cd: 1.40, range: 200, spread: 0.000, pellets: 1 },
  // อาวุธระยะประชิด: range = ระยะ (เมตร), arc = มุมกวาดรวม (องศา), delay = วินาทีจากเริ่มท่าถึงจังหวะโดน
  sword:   { melee: true, dmg: 55, cd: 0.80, range: 2.7, arc: 110, delay: 0.30 },                  // ดาบอัศวิน: ฟันกวาดกว้าง แรง ช้า
  spartan: { melee: true, dmg: 34, cd: 0.45, range: 2.3, arc: 50,  delay: 0.17 },                  // มีดสปาร์ตัน: แทงตรง
  dagger:  { melee: true, dmg: 17, cd: 0.28, range: 1.7, arc: 75,  delay: 0.10, backstab: true },  // มีดสั้น: เร็ว แทงข้างหลังดาเมจ x2
};

// ---- ของที่เก็บได้: กระสุนต่อชนิดปืน + เกราะ 5 เลเวล (ไม่เซฟข้ามเกม: ตาย/ออกเกม/จบแมตช์ = หายหมด) ----
const AMMO = {                      // start = กระสุนตอนเริ่มแมตช์, max = เก็บได้สูงสุด, pack = ได้ต่อ 1 ชิ้นจากกล่อง
  pistol:  { start: 15, max: 60,  pack: 12 },
  rifle:   { start: 30, max: 120, pack: 30 },
  shotgun: { start: 6,  max: 24,  pack: 8 },
  sniper:  { start: 4,  max: 20,  pack: 5 },
};
const AMMO_ORDER = ['pistol', 'rifle', 'shotgun', 'sniper'];
const ARMOR = [                     // เลเวล 1-5: red = สัดส่วนดาเมจที่เกราะรับไว้, dur = ความทนทาน (ดาเมจที่รับได้ก่อนพัง)
  { red: 0.15, dur: 40 }, { red: 0.25, dur: 60 }, { red: 0.35, dur: 80 }, { red: 0.45, dur: 100 }, { red: 0.55, dur: 120 },
];
const LOOT_CFG = {
  emptyChance: 0.15,                // กล่องที่ "ถูกเก็บไปก่อนแล้ว" ตั้งแต่เริ่ม
  ammoChance: 0.70, armorChance: 0.40,
  ammoWeights: { pistol: 0.30, rifle: 0.35, shotgun: 0.20, sniper: 0.15 },
  armorWeights: [0.35, 0.28, 0.20, 0.12, 0.05],
  reach: 2.8,                       // เมตร
};
const LOOT = (MAP.loot || []).map((l, i) => ({ id: i, x: l.x, z: l.z, items: [] }));

function pickWeighted(weights) {
  let r = Math.random() * (Array.isArray(weights) ? weights.reduce((a, b) => a + b, 0) : Object.values(weights).reduce((a, b) => a + b, 0));
  const entries = Array.isArray(weights) ? weights.map((w, i) => [i, w]) : Object.entries(weights);
  for (const [k, w] of entries) { if ((r -= w) <= 0) return k; }
  return entries[entries.length - 1][0];
}
function rollLoot() {
  for (const b of LOOT) {
    b.items = [];
    if (Math.random() < LOOT_CFG.emptyChance) continue;
    if (Math.random() < LOOT_CFG.ammoChance) { const w = pickWeighted(LOOT_CFG.ammoWeights); b.items.push({ k: 'ammo', w, n: AMMO[w].pack }); }
    if (Math.random() < LOOT_CFG.armorChance) b.items.push({ k: 'armor', lv: pickWeighted(LOOT_CFG.armorWeights) + 1 });
    if (b.items.length === 0) b.items.push({ k: 'ammo', w: 'rifle', n: AMMO.rifle.pack });   // ไม่ให้กล่องที่ "ไม่ว่าง" ว่างจริง
  }
}
const lootWire = () => LOOT.map(b => [b.id, b.x, b.z, b.items.length > 0 ? 1 : 0]);
const lootStateWire = () => LOOT.map(b => [b.id, b.items.length > 0 ? 1 : 0]);

function resetInventory(p) {
  p.ammo = {}; for (const w of AMMO_ORDER) p.ammo[w] = AMMO[w].start;
  p.armor = { lv: 0, dur: 0 };
}
function sendInv(p) {
  const A = p.armor.lv > 0 ? ARMOR[p.armor.lv - 1] : { dur: 0 };
  send(p.ws, { t: 'inv', ammo: p.ammo, armor: { lv: p.armor.lv, dur: Math.ceil(p.armor.dur), max: A.dur } });
}
// เกราะรับดาเมจส่วนหนึ่ง (โซนแดงไม่ผ่านเกราะ) ความทนทานลดตามที่รับไว้ หมดแล้วเกราะพัง
function absorb(p, amt) {
  if (p.armor.lv <= 0 || p.armor.dur <= 0) return amt;
  const A = ARMOR[p.armor.lv - 1];
  const soaked = Math.min(amt * A.red, p.armor.dur);
  p.armor.dur -= soaked;
  if (p.armor.dur <= 0.01) { p.armor.lv = 0; p.armor.dur = 0; }
  sendInv(p);
  return amt - soaked;
}
function tryLoot(p, m) {
  if (match.state !== 'playing' || !p.alive) return;
  const b = LOOT[m.id | 0];
  if (!b || Math.hypot(b.x - p.pos[0], b.z - p.pos[2]) > LOOT_CFG.reach) return;
  const got = [], left = [];
  for (const it of b.items) {
    if (it.k === 'ammo') {
      const room = AMMO[it.w].max - p.ammo[it.w];
      if (room <= 0) { left.push(it); continue; }
      const n = Math.min(room, it.n);
      p.ammo[it.w] += n; got.push({ k: 'ammo', w: it.w, n });
      if (n < it.n) left.push({ ...it, n: it.n - n });
    } else if (it.k === 'armor') {
      if (it.lv > p.armor.lv || (it.lv === p.armor.lv && p.armor.dur < ARMOR[it.lv - 1].dur)) {
        p.armor = { lv: it.lv, dur: ARMOR[it.lv - 1].dur }; got.push({ k: 'armor', lv: it.lv });
      } else left.push(it);
    }
  }
  b.items = left;
  send(p.ws, { t: 'got', items: got });
  if (got.length) { sendInv(p); broadcast({ t: 'loot_state', id: b.id, has: left.length > 0 ? 1 : 0 }); }
}

let nextId = 1;
const players = new Map();
const match = { state: 'lobby', timer: CFG.lobbyWait, zone: { x: 0, z: 0, r: CFG.zoneStart }, startCount: 0 };

const r2 = n => Math.round(n * 100) / 100;
const isVec = v => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const send = (ws, o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
const broadcast = o => {
  const s = JSON.stringify(o);
  for (const p of players.values()) if (p.ws.readyState === 1) p.ws.send(s);
};
const sendRoster = () => broadcast({
  t: 'roster',
  list: [...players.values()].map(p => ({ id: p.id, name: p.name, animal: p.animal, look: p.look })),
});

function teleport(p, pos) {
  p.pos = pos;
  p.lastState = Date.now();
  send(p.ws, { t: 'spawn', p: pos });
}

function damage(p, amt, killer) {
  if (!p.alive) return;
  if (killer) amt = absorb(p, amt);
  p.hp -= amt;
  if (p.hp <= 0) {
    p.hp = 0;
    p.alive = false;
    resetInventory(p); for (const w of AMMO_ORDER) p.ammo[w] = 0; sendInv(p);   // ตาย = ของที่เก็บมาหายหมด
    if (killer) killer.kills++;
    broadcast({ t: 'kill', victim: p.id, killer: killer ? killer.id : 0 });
  }
}

function startMatch() {
  match.state = 'playing';
  rollLoot();
  for (const p of players.values()) { resetInventory(p); sendInv(p); }
  broadcast({ t: 'loot_reset', boxes: lootStateWire() });
  match.zone = { x: 0, z: 0, r: CFG.zoneStart };
  match.startCount = players.size;
  for (const p of players.values()) {
    p.alive = true; p.hp = p.maxHp; p.kills = 0;
    teleport(p, safeSpawn(CFG.spawnRadius * 0.3, CFG.spawnRadius));
  }
  broadcast({ t: 'start' });
}

function endMatch(winner) {
  match.state = 'ended';
  match.timer = CFG.endWait;
  broadcast({ t: 'end', winner: winner ? winner.id : 0 });
}

function resetLobby() {
  match.state = 'lobby';
  rollLoot();
  for (const p of players.values()) { resetInventory(p); sendInv(p); }
  broadcast({ t: 'loot_reset', boxes: lootStateWire() });
  match.timer = CFG.lobbyWait;
  for (const p of players.values()) {
    p.alive = true; p.hp = p.maxHp;
    teleport(p, [(Math.random() - 0.5) * 20, 1, (Math.random() - 0.5) * 20]);
  }
}

function melee(p, m, W) {
  const dl = Math.hypot(m.d[0], m.d[2]);
  if (dl < 0.001) return;
  const dir = [m.d[0] / dl, m.d[2] / dl];
  broadcast({ t: 'shot', id: p.id, o: p.pos, w: WEAPON_ORDER[p.weapon], rays: [] });
  setTimeout(() => {
    if (match.state !== 'playing' || !p.alive) return;
    const half = Math.cos((W.arc * Math.PI) / 360);
    for (const q of [...players.values()]) {
      if (q === p || !q.alive) continue;
      const vx = q.pos[0] - p.pos[0], vz = q.pos[2] - p.pos[2];
      const dist = Math.hypot(vx, vz);
      if (dist > W.range + 0.4 || Math.abs(q.pos[1] - p.pos[1]) > 1.6) continue;
      const cosang = dist < 0.01 ? 1 : (vx * dir[0] + vz * dir[1]) / dist;
      if (cosang < half) continue;
      // กำแพง/สิ่งก่อสร้างคั่นระหว่างกัน = ฟันไม่โดน
      let wallT = Infinity;
      if (dist > 0.01) {
        const o = [p.pos[0], 1.2, p.pos[2]], dd = [vx / dist, 0, vz / dist];
        for (const b of MAP.boxes) { const t = rayBox(o, dd, b); if (t < wallT) wallT = t; }
      }
      if (wallT < dist) continue;
      let dmg = W.dmg;
      if (W.backstab) {  // ผู้ถูกแทงหันหลังให้ = ดาเมจ x2
        const fx = -Math.sin(q.ry), fz = -Math.cos(q.ry);
        if (fx * dir[0] + fz * dir[1] > 0.5) dmg *= 2;
      }
      damage(q, dmg, p);
      send(p.ws, { t: 'hit', target: q.id, hp: q.hp });
      send(q.ws, { t: 'hurt', by: p.id, hp: q.hp });
    }
  }, W.delay * 1000);
}

function shoot(p, m) {
  if (match.state !== 'playing' || !p.alive) return;
  const W = WEAPONS[WEAPON_ORDER[p.weapon]];
  const now = Date.now() / 1000;
  if (now - p.lastShot < W.cd * 0.85) return;
  if (W.melee) {
    if (!isVec(m.d)) return;
    p.lastShot = now;
    return melee(p, m, W);
  }
  if (!isVec(m.o) || !isVec(m.d)) return;
  const wname = WEAPON_ORDER[p.weapon];
  if (p.ammo[wname] <= 0) { send(p.ws, { t: 'noammo', w: wname }); return; }
  const o = m.o;
  if (Math.hypot(o[0] - p.pos[0], o[1] - p.pos[1], o[2] - p.pos[2]) > 4) return;
  const len = Math.hypot(...m.d);
  if (len < 0.001) return;
  const base = m.d.map(v => v / len);
  p.lastShot = now;
  p.ammo[wname]--; sendInv(p);   // ลูกซองหักครั้งละ 1 นัด (ไม่ใช่ต่อเม็ด)

  const rays = [];
  const dmgMap = new Map();
  const R = CFG.hitRadius;
  for (let k = 0; k < W.pellets; k++) {
    let d = base;
    if (W.spread > 0) {
      d = base.map(v => v + (Math.random() - 0.5) * 2 * W.spread);
      const l = Math.hypot(...d); d = d.map(v => v / l);
    }
    // กระสุนชนสิ่งก่อสร้างก่อน = โดนบัง
    let wallT = W.range;
    for (const b of MAP.boxes) { const t = rayBox(o, d, b); if (t < wallT) wallT = t; }
    let best = null, bestT = wallT;
    for (const q of players.values()) {
      if (q === p || !q.alive) continue;
  // ย่อตัว = เป้าเตี้ยลงและเล็กลง (ยิงเหนือหัวพลาด / กำแพงเตี้ยบังได้)
      const cy = q.crouch ? 0.65 : 1.0, rr = q.crouch ? 0.6 : R;
      const oc = [q.pos[0] - o[0], q.pos[1] + cy - o[1], q.pos[2] - o[2]];
      const tca = dot(oc, d);
      if (tca < 0) continue;
      const d2 = dot(oc, oc) - tca * tca;
      if (d2 > rr * rr) continue;
      const t = tca - Math.sqrt(rr * rr - d2);
      if (t < bestT) { bestT = t; best = q; }
    }
    if (best) dmgMap.set(best, (dmgMap.get(best) || 0) + W.dmg);
    rays.push([r2(d[0]), r2(d[1]), r2(d[2]), r2(best ? bestT : wallT)]);
  }
  broadcast({ t: 'shot', id: p.id, o, w: WEAPON_ORDER[p.weapon], rays });
  for (const [q, dm] of dmgMap) {
    damage(q, dm, p);
    send(p.ws, { t: 'hit', target: q.id, hp: q.hp });
    send(q.ws, { t: 'hurt', by: p.id, hp: q.hp });
  }
}

function handle(p, m) {
  if (!m || typeof m !== 'object') return;
  if (m.t === 'join' && !p.joined) {
    p.joined = true;
    p.name = String(m.name || 'Player').slice(0, 16);
    p.animal = ANIMALS[m.animal] ? m.animal : 'lion';
    p.look = cleanLook(m.look);
    p.maxHp = ANIMALS[p.animal].hp;
    p.hp = p.maxHp;
    players.set(p.id, p);
    send(p.ws, { t: 'welcome', id: p.id, animal: p.animal, look: p.look, cfg: CFG, animals: ANIMALS, state: match.state, mapSeed: MAP_SEED, map: MAP_WIRE, weapons: WEAPONS, loot: lootWire(), ammoCfg: AMMO, armorCfg: ARMOR });
    resetInventory(p); sendInv(p);
    if (match.state === 'lobby') {
      p.alive = true;
      teleport(p, [(Math.random() - 0.5) * 20, 1, (Math.random() - 0.5) * 20]);
    } // เข้ามากลางแมตช์ = ผู้ชม รอรอบหน้า
    sendRoster();
  } else if (m.t === 'loadout' && p.joined && match.state === 'lobby') {
    // เปลี่ยนสัตว์/ชุดได้เฉพาะตอนอยู่ล็อบบี้
    if (ANIMALS[m.animal]) p.animal = m.animal;
    p.look = cleanLook(m.look);
    p.maxHp = ANIMALS[p.animal].hp;
    p.hp = p.maxHp;
    send(p.ws, { t: 'loadout', animal: p.animal, look: p.look, speed: ANIMALS[p.animal].speed });
    sendRoster();
  } else if (m.t === 'state' && p.joined && p.alive) {
    if (!isVec(m.p)) return;
    const now = Date.now();
    const dt = Math.max(0.05, (now - p.lastState) / 1000);
    p.lastState = now;
    const maxD = ANIMALS[p.animal].speed * 1.6 * dt + 1.5;
    const far = Math.hypot(m.p[0] - p.pos[0], m.p[2] - p.pos[2]) > maxD;
    if (far || Math.abs(m.p[0]) > 250 || Math.abs(m.p[2]) > 250 || m.p[1] > 60 || m.p[1] < -20) {
      teleport(p, p.pos); // ดึงกลับ (กันโกงความเร็ว)
      return;
    }
    p.pos = m.p;
    p.ry = Number(m.ry) || 0;
    p.anim = m.a | 0;
    p.pitch = Math.max(-1.3, Math.min(1.3, Number(m.rp) || 0));
    p.crouch = m.c === 1;
  } else if (m.t === 'loot' && p.joined) {
    tryLoot(p, m);
  } else if (m.t === 'weapon' && p.joined) {
    const wi = WEAPON_ORDER.indexOf(m.w);
    if (wi >= 0) p.weapon = wi;
  } else if (m.t === 'shoot' && p.joined) {
    shoot(p, m);
  }
}

function tick(dt) {
  if (match.state === 'lobby') {
    if (players.size >= CFG.minPlayers) {
      match.timer -= dt;
      if (match.timer <= 0) startMatch();
    } else match.timer = CFG.lobbyWait;
  } else if (match.state === 'playing') {
    const z = match.zone;
    z.r = Math.max(CFG.zoneMin, z.r - CFG.zoneShrink * dt);
    const alive = [];
    for (const p of players.values()) {
      if (!p.alive) continue;
      if (Math.hypot(p.pos[0] - z.x, p.pos[2] - z.z) > z.r) damage(p, CFG.zoneDps * dt, null);
      if (p.alive) alive.push(p);
    }
    if (alive.length === 0 || (match.startCount > 1 && alive.length <= 1)) endMatch(alive[0]);
  } else if (match.state === 'ended') {
    match.timer -= dt;
    if (match.timer <= 0) resetLobby();
  }

  const s = [];
  let aliveCount = 0;
  for (const p of players.values()) {
    if (!p.alive) continue;
    aliveCount++;
    s.push([p.id, r2(p.pos[0]), r2(p.pos[1]), r2(p.pos[2]), r2(p.ry), p.anim, Math.ceil(p.hp), p.weapon, r2(p.pitch), p.crouch ? 1 : 0, p.armor.lv]);
  }
  broadcast({
    t: 'snap', s, alive: aliveCount, state: match.state, timer: Math.ceil(Math.max(0, match.timer)),
    zone: { x: match.zone.x, z: match.zone.z, r: r2(match.zone.r) },
  });
}

// หน้าทดสอบ: เปิด https://<โดเมน>/test เพื่อดูว่า WebSocket ต่อติดไหม
const TEST_PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<body style="font-family:sans-serif;padding:24px;background:#0d1412;color:#fff">
<h2>WebSocket test</h2><p id="s">กำลังต่อ...</p>
<script>
const s = document.getElementById('s');
const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
const w = new WebSocket(url);
const t = setTimeout(() => { s.textContent = '⏳ ยังไม่ตอบ (เซิร์ฟเวอร์อาจเพิ่งตื่น รอสักครู่แล้วรีเฟรช)'; }, 15000);
w.onopen = () => { s.textContent = '✅ ต่อติดแล้ว: ' + url; w.send(JSON.stringify({ t: 'join', name: 'WebTest', animal: 'lion' })); };
w.onmessage = e => { const m = JSON.parse(e.data); if (m.t === 'welcome') { clearTimeout(t); s.textContent = '✅ ต่อติด และเซิร์ฟเวอร์ตอบรับแล้ว (id ' + m.id + ') ใช้ ' + url + ' ใน Net.gd ได้'; w.close(); } };
w.onerror = () => { clearTimeout(t); s.textContent = '❌ ต่อไม่ติด: ' + url; };
</script></body>`;

const server = http.createServer((req, res) => {
  if (req.url === '/test') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(TEST_PAGE);
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(req.url === '/health' ? 'ok' : 'Animal BR server');
});
const wss = new WebSocketServer({ server });

wss.on('connection', ws => {
  if (players.size >= CFG.maxPlayers) { send(ws, { t: 'full' }); return ws.close(); }
  const p = {
    id: nextId++, ws, joined: false, name: 'Player', animal: 'lion', look: cleanLook(null),
    pos: [0, 1, 0], ry: 0, anim: 0, hp: 100, maxHp: 100, alive: false,
    lastShot: 0, lastState: Date.now(), kills: 0, isAlive: true, weapon: 1, pitch: 0, crouch: false, ammo: {}, armor: { lv: 0, dur: 0 },
  };
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    handle(p, m);
  });
  ws.on('close', () => { if (players.delete(p.id)) sendRoster(); });
  ws.on('error', () => {});
});

// ping กัน connection หลุดเวลา idle (Render)
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false; ws.ping();
  }
}, 30000);

rollLoot();
let last = Date.now();
setInterval(() => {
  const now = Date.now();
  tick((now - last) / 1000);
  last = now;
}, 1000 / CFG.tick);

server.listen(PORT, () => console.log('Animal BR server on port', PORT));
