// สร้างแมพ (บ้าน กล่อง ต้นไม้ กำแพงเตี้ย หิน) ด้วย seed ตายตัว -> ได้แมพเดิมทุกครั้งที่เซิร์ฟเวอร์รีสตาร์ท
// เซิร์ฟเวอร์ใช้ชุดกล่องนี้บังกระสุน และส่งให้เกมไปสร้างโมเดล+ชนจริง (ที่เดียวกัน ไม่เพี้ยน)
// type: 0=ผนังบ้าน 1=ลังไม้ 2=ต้นไม้(ลำต้น) 3=กำแพงเตี้ย 4=หิน   c = ดัชนีสีผนัง

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r2 = n => Math.round(n * 100) / 100;

function buildMap(seed) {
  const rnd = mulberry32(seed);
  const R = (a, b) => a + rnd() * (b - a);
  const boxes = [];
  const foot = [];
  const CLEAR = 14;   // เขตโล่งกลางแมพ (ล็อบบี้)
  const EDGE = 92;    // ขอบพื้นที่วางของ (โซนเริ่มที่ 100)
  const free = (x, z, r) =>
    Math.hypot(x, z) > CLEAR + r && Math.hypot(x, z) < EDGE - r &&
    foot.every(f => Math.hypot(f.x - x, f.z - z) > f.r + r);
  const add = (t, c, x, y, z, sx, sy, sz) =>
    boxes.push({ t, c, x: r2(x), y: r2(y), z: r2(z), sx: r2(sx), sy: r2(sy), sz: r2(sz) });
  const pos = (r) => { const a = rnd() * Math.PI * 2, d = Math.sqrt(rnd()) * EDGE; return [Math.cos(a) * d, Math.sin(a) * d]; };

  // ---- บ้าน (ผนัง 4 ด้าน เจาะประตู 1 ด้าน ไม่มีหลังคา) ----
  const H = 4, T = 0.6, G = 3.4;
  const hwall = (cx, cz, len, door, c) => {
    if (!door) return add(0, c, cx, H / 2, cz, len, H, T);
    const seg = (len - G) / 2;
    add(0, c, cx - (G + seg) / 2, H / 2, cz, seg, H, T);
    add(0, c, cx + (G + seg) / 2, H / 2, cz, seg, H, T);
  };
  const vwall = (cx, cz, len, door, c) => {
    if (!door) return add(0, c, cx, H / 2, cz, T, H, len);
    const seg = (len - G) / 2;
    add(0, c, cx, H / 2, cz - (G + seg) / 2, T, H, seg);
    add(0, c, cx, H / 2, cz + (G + seg) / 2, T, H, seg);
  };
  let houses = 0;
  for (let tries = 0; tries < 400 && houses < 9; tries++) {
    const w = R(9, 14), d = R(8, 12), rad = Math.hypot(w, d) / 2 + 3;
    const [px, pz] = pos();
    if (!free(px, pz, rad)) continue;
    const c = Math.floor(rnd() * 6), side = Math.floor(rnd() * 4); // 0:+z 1:-z 2:+x 3:-x
    hwall(px, pz - d / 2, w, side === 1, c);
    hwall(px, pz + d / 2, w, side === 0, c);
    vwall(px - w / 2, pz, d, side === 3, c);
    vwall(px + w / 2, pz, d, side === 2, c);
    // ลังในบ้าน วางชิดผนังด้านตรงข้ามประตู
    const back = [[0, -1], [0, 1], [-1, 0], [1, 0]][side];
    for (let k = 0; k < 2; k++) {
      const lat = R(-2.5, 2.5);
      const cx = px + (back[0] !== 0 ? back[0] * (w / 2 - 1.5) : lat);
      const cz = pz + (back[1] !== 0 ? back[1] * (d / 2 - 1.5) : lat);
      add(1, 0, cx, 0.7, cz, 1.4, 1.4, 1.4);
    }
    foot.push({ x: px, z: pz, r: rad });
    houses++;
  }
  // ---- ลังไม้ ----
  for (let i = 0, n = 0; i < 300 && n < 28; i++) {
    const [x, z] = pos();
    if (!free(x, z, 2.5)) continue;
    add(1, 0, x, 0.9, z, 1.8, 1.8, 1.8);
    foot.push({ x, z, r: 2.5 }); n++;
  }
  // ---- กำแพงเตี้ย (กระโดดข้ามได้) ----
  for (let i = 0, n = 0; i < 300 && n < 12; i++) {
    const [x, z] = pos();
    const len = R(6, 12), alongX = rnd() < 0.5;
    if (!free(x, z, len / 2 + 0.5)) continue;
    add(3, 0, x, 0.45, z, alongX ? len : 0.5, 0.9, alongX ? 0.5 : len);
    foot.push({ x, z, r: len / 2 + 0.5 }); n++;
  }
  // ---- หิน ----
  for (let i = 0, n = 0; i < 300 && n < 12; i++) {
    const [x, z] = pos();
    const s = R(1.6, 3);
    if (!free(x, z, s)) continue;
    add(4, 0, x, s * 0.4, z, s * 1.3, s * 0.8, s * 1.1);
    foot.push({ x, z, r: s }); n++;
  }
  // ---- ต้นไม้ ----
  for (let i = 0, n = 0; i < 600 && n < 45; i++) {
    const [x, z] = pos();
    if (!free(x, z, 1.6)) continue;
    const h = R(3, 4.5);
    add(2, 0, x, h / 2, z, 0.8, h, 0.8);
    foot.push({ x, z, r: 1.6 }); n++;
  }
  return { seed, boxes };
}

// ยิงรังสีชนกล่อง (slab method) คืนระยะ t หรือ Infinity ถ้าไม่โดน
function rayBox(o, d, b) {
  const mn = [b.x - b.sx / 2, b.y - b.sy / 2, b.z - b.sz / 2];
  const mx = [b.x + b.sx / 2, b.y + b.sy / 2, b.z + b.sz / 2];
  let tmin = 0, tmax = Infinity;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) {
      if (o[i] < mn[i] || o[i] > mx[i]) return Infinity;
    } else {
      let t1 = (mn[i] - o[i]) / d[i], t2 = (mx[i] - o[i]) / d[i];
      if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
      tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
      if (tmin > tmax) return Infinity;
    }
  }
  return tmin;
}

module.exports = { buildMap, rayBox };
    
