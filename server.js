// Animal Battle Royale - authoritative WebSocket server (Node.js)
// รันบน Render เป็น Web Service: Build = npm install, Start = npm start
const http = require('http');
const { WebSocketServer } = require('ws');

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
};

// ตัวเลือกแต่งตัว (ค่าสูงสุดของแต่ละช่อง) - ต้องตรงกับ AnimalFactory.gd
const LOOK_MAX = { skin: 4, color: 7, hat: 4, top: 2, acc: 3 };
function cleanLook(l) {
  const out = {};
  for (const k in LOOK_MAX) {
    const v = l && Number.isInteger(l[k]) ? l[k] : 0;
    out[k] = Math.min(LOOK_MAX[k], Math.max(0, v));
  }
  return out;
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
  p.hp -= amt;
  if (p.hp <= 0) {
    p.hp = 0;
    p.alive = false;
    if (killer) killer.kills++;
    broadcast({ t: 'kill', victim: p.id, killer: killer ? killer.id : 0 });
  }
}

function startMatch() {
  match.state = 'playing';
  match.zone = { x: 0, z: 0, r: CFG.zoneStart };
  match.startCount = players.size;
  for (const p of players.values()) {
    p.alive = true; p.hp = p.maxHp; p.kills = 0;
    const a = Math.random() * Math.PI * 2;
    const d = CFG.spawnRadius * (0.3 + Math.random() * 0.7);
    teleport(p, [Math.cos(a) * d, 1, Math.sin(a) * d]);
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
  match.timer = CFG.lobbyWait;
  for (const p of players.values()) {
    p.alive = true; p.hp = p.maxHp;
    teleport(p, [(Math.random() - 0.5) * 20, 1, (Math.random() - 0.5) * 20]);
  }
}

function shoot(p, m) {
  if (match.state !== 'playing' || !p.alive) return;
  const now = Date.now() / 1000;
  if (now - p.lastShot < CFG.fireCooldown * 0.9) return;
  if (!isVec(m.o) || !isVec(m.d)) return;
  const o = m.o;
  if (Math.hypot(o[0] - p.pos[0], o[1] - p.pos[1], o[2] - p.pos[2]) > 4) return;
  const len = Math.hypot(...m.d);
  if (len < 0.001) return;
  const d = m.d.map(v => v / len);
  p.lastShot = now;
  broadcast({ t: 'shot', id: p.id, o, d });

  let best = null, bestT = CFG.range;
  const R = CFG.hitRadius;
  for (const q of players.values()) {
    if (q === p || !q.alive) continue;
    const oc = [q.pos[0] - o[0], q.pos[1] + 1 - o[1], q.pos[2] - o[2]];
    const tca = dot(oc, d);
    if (tca < 0) continue;
    const d2 = dot(oc, oc) - tca * tca;
    if (d2 > R * R) continue;
    const t = tca - Math.sqrt(R * R - d2);
    if (t < bestT) { bestT = t; best = q; }
  }
  if (best) {
    damage(best, CFG.damage, p);
    send(p.ws, { t: 'hit', target: best.id, hp: best.hp });
    send(best.ws, { t: 'hurt', by: p.id, hp: best.hp });
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
    send(p.ws, { t: 'welcome', id: p.id, animal: p.animal, look: p.look, cfg: CFG, animals: ANIMALS, state: match.state });
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
    s.push([p.id, r2(p.pos[0]), r2(p.pos[1]), r2(p.pos[2]), r2(p.ry), p.anim, Math.ceil(p.hp)]);
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
    lastShot: 0, lastState: Date.now(), kills: 0, isAlive: true,
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

let last = Date.now();
setInterval(() => {
  const now = Date.now();
  tick((now - last) / 1000);
  last = now;
}, 1000 / CFG.tick);

server.listen(PORT, () => console.log('Animal BR server on port', PORT));
