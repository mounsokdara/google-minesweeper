(() => {
'use strict';

/* =====================================================================
 *  Constants taken 1:1 from Google's minesweeper source
 * ===================================================================== */
const FLAG_COLORS_CELL = ['#F4C20D','#DB3236','#4885ED','#ED44B5','#B648F2','#48E6F1','#F4840D','#008744']; // hcH (per-cell random colour)
const NUMBER_COLORS    = ['#1976D2','#388E3C','#D32F2F','#7B1FA2','#FF8F00','#0097A7','#424242','#9E9E9E']; // UcH
const MINE_SOUND_ORDER = [0,1,2,3,4,2];                                                                      // QcH
const DESKTOP_CELL  = {EASY:45, MEDIUM:30, HARD:25};
const DESKTOP_GRID  = {EASY:[10,8], MEDIUM:[18,14], HARD:[24,20]};
const DESKTOP_MINES = {EASY:10, MEDIUM:40, HARD:99};
const MOBILE_MINES  = {EASY:10, MEDIUM:35, HARD:75};
const MOBILE_CELLS  = {EASY:80, MEDIUM:200, HARD:360};   // target number of cells on touch devices
const HEADER_H = 60;
const LABELS = {EASY:'Easy', MEDIUM:'Medium', HARD:'Hard'};

const qs = new URLSearchParams(location.search);
/* Mobile vs desktop mode.
 * Google's own test is user-agent based (not "has a touch screen"), so a phone that is switched to
 * "Desktop site" gets the desktop game. A CSS (pointer: coarse) check can't tell the difference,
 * because the hardware is still touch - that was the bug. Overrides: ?mobile=1 / ?mobile=0. */
function detectMobile(){
  if (qs.has('mobile')) return qs.get('mobile') !== '0';
  const ua = navigator.userAgent || '';
  const uad = navigator.userAgentData;
  if (uad && uad.mobile === true) return true;                       // Chrome/Edge: "Request mobile site"
  return /Android|iPhone|iPod|Windows Phone|Mobile|Silk|Opera Mini/i.test(ua);   // iPad/phone "Desktop site" UAs do not match
}
const IS_MOBILE = detectMobile();

/* =====================================================================
 *  Colour helpers (_.FC / _.EC / _.HC / _.kDc / _.lDc / mcH)
 * ===================================================================== */
const clamp01 = t => Math.min(1, Math.max(0, t));
function hex2rgb(h){
  h = h.trim().replace('#','');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const n = parseInt(h, 16);
  return [n >> 16, n >> 8 & 255, n & 255];
}
function rgb2hex(c){ return '#' + ((1 << 24) | (c[0] << 16) | (c[1] << 8) | c[2]).toString(16).slice(1); }
function mixToward(target, from, t){            // HC(target, from, t)
  t = clamp01(t);
  return [0,1,2].map(i => Math.round(from[i] + t * (target[i] - from[i])));
}
function shade(color, amt){                      // mcH: amt<0 lightens, amt>0 darkens
  const rgb = hex2rgb(color);
  return rgb2hex(amt < 0 ? mixToward([255,255,255], rgb, -amt) : mixToward([0,0,0], rgb, amt));
}

/* =====================================================================
 *  Audio (Google's sprite .bin files decoded to mp3 clips at build time)
 * ===================================================================== */
const Sound = {
  ctx:null, master:null, buffers:{}, active:{}, muted:false, ready:false,
  init(){
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try { this.ctx = new AC(); } catch(e){ return; }
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    for (const [name, url] of Object.entries(ASSETS.audio)) {
      fetch(url)
        .then(r => r.arrayBuffer())
        .then(ab => new Promise((res, rej) => {
          const r = this.ctx.decodeAudioData(ab, res, rej);
          if (r && r.then) r.then(res, rej);
        }))
        .then(b => { this.buffers[name] = b; })
        .catch(() => {});
    }
  },
  unlock(){ if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {}); },
  play(name, loop = false){
    if (!this.ctx || !this.buffers[name]) return;
    this.unlock();
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffers[name];
    src.loop = loop;
    src.connect(this.master);
    src.start(0);
    (this.active[name] = this.active[name] || new Set()).add(src);
    src.onended = () => this.active[name] && this.active[name].delete(src);
  },
  stop(name){
    const s = this.active[name];
    if (!s) return;
    for (const n of s) { try { n.stop(0); } catch(e){} }
    s.clear();
  },
  setMuted(m){ this.muted = m; if (this.master) this.master.gain.value = m ? 0 : 1; }
};
const SFX = {
  BIG_DIG:'BIG_DIG', REVEAL:n => 'DIG_REVEAL_' + n, MINE:n => 'MINE_' + n,
  PLANT:'PLANT_FLAG', UNPLANT:'UNPLANT_FLAG',
  LOSE_MUSIC:'LOSE_MUSIC', WIN_HARP:'WIN_WATER_HARP', WIN_MUSIC:'WINNER_MUSIC'
};

/* =====================================================================
 *  Solver (port of ccH / acH / ZbH / YbH / $bH).
 *  Google generates each board and keeps re-rolling (up to 150 ms) until
 *  this solver can finish it without guessing, so boards are no-guess.
 * ===================================================================== */
class Solver {
  nb(p){
    const out = [], x = p[0], y = p[1], W = this.W, H = this.H;
    const add = (a, b) => { if (a >= 0 && a < W && b >= 0 && b < H) out.push([a, b]); };
    add(x-1,y); add(x-1,y-1); add(x-1,y+1); add(x+1,y); add(x+1,y-1); add(x+1,y+1); add(x,y-1); add(x,y+1);
    return out;
  }
  reveal(p){                                    // ZbH
    const c = this.cells[p[0]][p[1]];
    if (c.open) return;
    c.open = true;
    if (!c.mine && c.adj === 0) {
      for (const n of this.nb(p)) if (!this.cells[n[0]][n[1]].open) this.reveal(n);
    }
  }
  flag(p){                                      // $bH
    const c = this.cells[p[0]][p[1]];
    if (!c.flag) { c.flag = true; this.flagged++; }
  }
  solve(start, grid, totalMines){               // acH
    this.W = grid.length; this.H = grid[0].length;
    this.cells = grid.map(col => col.map(c => Object.assign({}, c)));
    this.total = totalMines; this.flagged = 0;
    this.cons = new Map();
    for (let x = 0; x < this.W; x++)
      for (let y = 0; y < this.H; y++)
        if (this.cells[x][y].adj > 0 && !this.cells[x][y].mine) this.cons.set([x, y], this.nb([x, y]));
    this.reveal([start.x, start.y]);

    for (;;) {
      let changed = false;
      for (const [pos, nbs] of this.cons.entries()) {
        const cell = this.cells[pos[0]][pos[1]];
        if (!cell.open) continue;
        let flagged = 0, hidden = 0;
        for (const z of nbs) {
          const n = this.cells[z[0]][z[1]];
          if (n.flag) flagged++; else if (!n.open) hidden++;
        }
        const rem = cell.adj - flagged;
        for (const z of nbs) {
          const n = this.cells[z[0]][z[1]];
          if (!n.open && !n.flag) {
            if (rem === 0) { this.reveal(z); changed = true; }
            else if (rem === hidden) { this.flag(z); changed = true; }
          }
        }
        if (rem === 0) this.cons.delete(pos);
      }
      if (!changed) changed = this.gauss();
      if (!changed) break;
    }
    return this.flagged === this.total;
  }
  gauss(){
    if (this.cons.size === 0) return false;
    const rowsKeys = [];
    for (const k of this.cons.keys()) if (this.cells[k[0]][k[1]].open) rowsKeys.push(k);
    const cols = [];
    for (const k of rowsKeys) {
      for (const t of this.cons.get(k)) {
        const c = this.cells[t[0]][t[1]];
        if (!c.open && !c.flag) {
          let dup = false;
          for (const z of cols) if (z[0] === t[0] && z[1] === t[1]) dup = true;
          if (!dup) cols.push(t);
        }
      }
    }
    const m = new Array(rowsKeys.length);
    for (let h = 0; h < rowsKeys.length; h++) {
      const k = rowsKeys[h];
      const row = new Array(cols.length + 1);
      for (let n = 0; n < cols.length; n++) {
        const q = cols[n];
        row[n] = (Math.abs(k[0] - q[0]) <= 1 && Math.abs(k[1] - q[1]) <= 1) ? 1 : 0;
      }
      let fl = 0;
      for (const r of this.cons.get(k)) if (this.cells[r[0]][r[1]].flag) fl++;
      row[cols.length] = this.cells[k[0]][k[1]].adj - fl;
      m[h] = row;
    }
    // forward Gaussian elimination with partial pivoting
    const f = m.length, g = f > 0 ? m[0].length : 0;
    for (let h = 0, k = 0; h < f && k < g;) {
      let p = h, best = Math.abs(m[p][k]);
      for (let q = h + 1; q < f; q++) if (Math.abs(m[q][k]) > best) { p = q; best = Math.abs(m[q][k]); }
      if (m[p][k] !== 0) {
        const tmp = m[h]; m[h] = m[p]; m[p] = tmp;
        for (let r = h + 1; r < f; r++) {
          const factor = m[r][k] / m[h][k];
          m[r][k] = 0;
          for (let q = k + 1; q < g; q++) m[r][q] -= m[h][q] * factor;
        }
        h += 1;
      }
      k += 1;
    }
    let progress = false;
    for (const row of m) {
      let pos = 0, neg = 0, did = false;
      for (let n = 0; n < row.length - 1; n++) { if (row[n] > 0) pos += row[n]; else if (row[n] < 0) neg += row[n]; }
      const rhs = row[row.length - 1];
      if (rhs === pos) {
        for (let k = 0; k < row.length - 1; k++) {
          if (row[k] > 0) { this.flag(cols[k]); did = true; }
          else if (row[k] < 0) { this.reveal(cols[k]); did = true; }
        }
      } else if (rhs === neg) {
        for (let k = 0; k < row.length - 1; k++) {
          if (row[k] > 0) { this.reveal(cols[k]); did = true; }
          else if (row[k] < 0) { this.flag(cols[k]); did = true; }
        }
      }
      if (did) progress = true;
    }
    return progress;
  }
}

/* =====================================================================
 *  Game
 * ===================================================================== */
const $ = id => document.getElementById(id);
const root = $('game'), canvas = $('cv'), ctx = canvas.getContext('2d');
const overEl = $('over');
const dpr = () => Math.min(2, window.devicePixelRatio || 1);          // _.g6G

// images
const IMG = {};
let pending = 0;
function loadImg(key, uri){
  const im = new Image(); pending++;
  im.onload = im.onerror = () => { if (--pending === 0) onAssetsReady(); };
  im.src = uri; IMG[key] = im; return im;
}
for (const k of ['win','lose','shovel','flag','close','wrong','flagPlant','clock','trophy','refresh']) loadImg(k, ASSETS.img[k]);
$('icoFlag').src = ASSETS.img.flag;   $('icoClock').src = ASSETS.img.clock;
$('ovClock').src = ASSETS.img.clock;  $('ovTrophy').src = ASSETS.img.trophy;  $('ovRefresh').src = ASSETS.img.refresh;
$('tutDig').style.backgroundImage = 'url(' + ASSETS.img.tutDig + ')';
$('tutFlag').style.backgroundImage = 'url(' + ASSETS.img.tutFlag + ')';

const G = {
  difficulty:'MEDIUM',
  W:18, H:14, cs:0, mines:40,
  grid:[],
  started:false, over:false, won:false, markBad:false,
  flags:0, elapsed:0, startTime:0, lastTs:0,
  lockMs:0, overlayShown:false,
  selected:null, btnDig:null, btnFlag:null, btnClose:null, buttonRadius:0,
  offX:0, offY:0,
  shake:0, winFade:0, waveT:-1, mineSeq:0,
  tilesP:[], dirtP:[], flagP:[], flowers:[], timers:[],
  best:{EASY:-1, MEDIUM:-1, HARD:-1},
  sinceInput:0, touchDown:false,
  hover:null, left:false, right:false, middle:false, ctrl:false,
  tutorial:true, muted:false, solver:new Solver(), ready:false
};
try {
  const saved = JSON.parse(localStorage.getItem('minesweeper_best') || 'null');
  if (saved) for (const k of ['EASY','MEDIUM','HARD']) if (typeof saved[k] === 'number') G.best[k] = saved[k];
} catch(e){}
function saveBest(){ try { localStorage.setItem('minesweeper_best', JSON.stringify(G.best)); } catch(e){} }

const later = (fn, ms) => { const id = setTimeout(fn, ms); G.timers.push(id); return id; };
const inBounds = (x, y) => x >= 0 && x < G.W && y >= 0 && y < G.H;      // qcH
const cell = p => G.grid[p.x][p.y];

function neighbours(p){                                                    // pcH
  const out = [];
  for (let x = p.x - 1; x <= p.x + 1; x++)
    for (let y = p.y - 1; y <= p.y + 1; y++)
      if (!(x === p.x && y === p.y) && inBounds(x, y)) out.push({x, y});
  return out;
}
function countMinesAround(p, edgesAreMines){                               // JcH
  const nb = neighbours(p);
  let n = 0;
  for (const q of nb) if (cell(q).mine) n++;
  if (edgesAreMines) n += 8 - nb.length;
  return n;
}
function randomColor(){ return FLAG_COLORS_CELL[Math.floor(Math.random() * FLAG_COLORS_CELL.length)]; }

function initGrid(){                                                       // icH
  G.grid = new Array(G.W);
  for (let x = 0; x < G.W; x++) {
    G.grid[x] = new Array(G.H);
    for (let y = 0; y < G.H; y++)
      G.grid[x][y] = {mine:false, boom:false, boomTime:0, flag:false, flagAnim:-1, open:false, adj:0, color:randomColor()};
  }
}
function placeMines(first){                                                // FcH
  initGrid();
  for (let c = 0; c < G.mines;) {
    const p = {x:Math.floor(Math.random() * G.W), y:Math.floor(Math.random() * G.H)};
    if (cell(p).mine || Math.abs(p.x - first.x) + Math.abs(p.y - first.y) <= 2 || countMinesAround(p, true) === 8) continue;
    cell(p).mine = true; c++;
  }
  for (let x = 0; x < G.W; x++) for (let y = 0; y < G.H; y++) G.grid[x][y].adj = countMinesAround({x, y}, false);
  G.started = true;
}

/* ---------- layout (Nwa) ---------- */
function layout(){
  const d = dpr();
  if (IS_MOBILE) {
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0) return;
    const w = rect.width - 40, h = rect.height - 40;
    if (G.cs) {
      G.cs = Math.min(Math.floor(w / G.W), Math.floor(h / G.H));
    } else {
      const area = w * h / MOBILE_CELLS[G.difficulty];
      G.cs = Math.floor(Math.sqrt(area));
      G.W = Math.floor(w / G.cs); G.H = Math.floor(h / G.cs);
    }
    canvas.width = Math.round(rect.width * d); canvas.height = Math.round(rect.height * d);
    G.cs *= d;
    G.offX = Math.ceil((canvas.width - G.W * G.cs) / 2);
    G.offY = Math.ceil((canvas.height - G.H * G.cs) / 2);
    G.buttonRadius = Math.max(25, G.cs / 2);
  } else {
    [G.W, G.H] = DESKTOP_GRID[G.difficulty];
    G.cs = DESKTOP_CELL[G.difficulty];
    const cw = G.W * G.cs, ch = G.H * G.cs;
    root.style.width = cw + 'px'; root.style.height = (ch + HEADER_H) + 'px';
    canvas.style.width = cw + 'px'; canvas.style.height = ch + 'px';
    canvas.width = cw * d; canvas.height = ch * d;
    G.cs *= d; G.offX = 0; G.offY = 0;
    fitDesktop();
  }
}
function fitDesktop(){
  if (IS_MOBILE) return;
  const w = G.W * G.cs / dpr(), h = G.H * G.cs / dpr() + HEADER_H;
  const s = Math.min(1, (window.innerWidth - 16) / w, (window.innerHeight - 16) / h);
  root.style.transform = s < 1 ? 'scale(' + s + ')' : 'none';
}

/* ---------- state reset (resetState) ---------- */
function resetState(){
  for (const t of G.timers) clearTimeout(t);
  G.timers = [];
  initGrid();
  G.mines = (IS_MOBILE ? MOBILE_MINES : DESKTOP_MINES)[G.difficulty];
  G.started = G.won = G.over = G.markBad = false;
  G.flags = G.elapsed = G.lockMs = 0;
  G.ctrl = G.middle = G.right = G.left = false;
  G.hover = null; G.sinceInput = 0; G.touchDown = false;
  G.waveT = -1; G.mineSeq = 0; G.winFade = 0; G.shake = 0;
  G.tilesP = []; G.dirtP = []; G.flagP = []; G.flowers = [];
  clearSelection();
  setOverlay(false);
  updateHud();
}
function reset(){ G.cs = 0; layout(); resetState(); }

/* ---------- HUD ---------- */
function fmtTime(ms){                                                      // jcH
  const s = Math.floor(ms / 1000);
  let t = (s < 100 ? '0' : '') + (s < 10 ? '0' : '') + s;
  if (s > 999) t = '999';
  return t;
}
function updateHud(){                                                      // kcH
  $('flagNum').textContent = String(G.mines - G.flags);
  const t = fmtTime(G.elapsed);
  $('timeNum').textContent = t;
  if (overEl.style.visibility === 'hidden') {
    $('ovTime').textContent = G.won ? t : '\u2013\u2013\u2013';
    const b = G.best[G.difficulty];
    $('ovBest').textContent = b > 0 ? fmtTime(b) : '\u2013\u2013\u2013';
  }
}

/* ---------- overlay (ocH / GcH) ---------- */
function setOverlay(show){
  if (show && !G.overlayShown) {
    overEl.style.visibility = 'visible'; overEl.style.opacity = '1';
    Sound.play(G.won ? SFX.WIN_MUSIC : SFX.LOSE_MUSIC, true);
  } else if (!show && overEl.style.opacity !== '0' && G.overlayShown) {
    overEl.style.opacity = '0';
    setTimeout(() => { if (!G.overlayShown) overEl.style.visibility = 'hidden'; }, 300);
    Sound.stop(SFX.WIN_MUSIC); Sound.stop(SFX.LOSE_MUSIC);
  }
  G.overlayShown = show;
}
function styleOverlayCard(){
  $('card').style.backgroundImage = 'url(' + (G.won ? IMG.win.src : IMG.lose.src) + ')';
  $('againTxt').textContent = G.won ? 'Play again' : 'Try again';
}

/* ---------- particles ---------- */
function cornerOf(p){ return {x:p.x * G.cs, y:p.y * G.cs}; }
function spawnTile(p, isMine){                                             // KcH
  G.tilesP.push({
    pos:cornerOf(p),
    vel:isMine ? {x:0, y:-30} : {x:Math.random() * 20 - 10, y:Math.random() * -20},
    angle:0, spin:Math.random() * 20 - 10,
    color:(p.x + p.y) % 2 === 0 ? '#AAD751' : '#A2D149',
    size:1 + Math.random() * 0.2, midpoint:0
  });
}
function spawnDirt(p){                                                     // NcH
  for (let i = 0; i < 10; i++) {
    const c = cornerOf(p);
    const pos = {x:c.x + Math.random() * G.cs, y:c.y + Math.random() * G.cs};
    const vel = {x:Math.random() * 20 - 10, y:Math.random() * -35};
    if (vel.y > -15) vel.y = -15;
    if (Math.abs(vel.x) < 5) vel.x = 5 * (vel.x > 0 ? 1 : -1);
    G.dirtP.push({pos, vel, angle:0, spin:0, color:shade(cell(p).color, Math.random() * 0.2), size:2 + Math.random() * 2, midpoint:pos.x + vel.x * 2});
  }
}
function spawnFlagParticle(p){                                             // rcH
  const vel = {x:Math.random() * 20 - 10, y:Math.random() * -30};
  if (vel.y > -15) vel.y = -15;
  if (Math.abs(vel.x) < 5) vel.x = 5 * (vel.x > 0 ? 1 : -1);
  G.flagP.push({
    pos:cornerOf(p), vel, angle:0, spin:Math.random() * 40 - 20, color:'',
    size:(G.over && !G.won) ? 3 : 1.5 + Math.random() * 0.5, midpoint:0
  });
}

/* ---------- game logic ---------- */
function toggleFlag(p){                                                    // scH
  if (inBounds(p.x, p.y) && !cell(p).open) {
    const c = cell(p);
    c.flag = !c.flag;
    if (c.flag) { c.flagAnim = 0; G.flags++; Sound.play(SFX.PLANT); }
    else { c.flagAnim = -1; G.flags--; spawnFlagParticle(p); Sound.play(SFX.UNPLANT); }
  }
}
function nearestHiddenMine(p){                                             // LcH
  const ok = q => inBounds(q.x, q.y) && cell(q).mine && !cell(q).boom && !cell(q).flag;   // PcH
  for (let r = 1; r < 15; r++) {
    for (let x = p.x - r; x <= p.x + r; x++) if (ok({x, y:p.y - r})) return {x, y:p.y - r};
    for (let x = p.x - r; x <= p.x + r; x++) if (ok({x, y:p.y + r})) return {x, y:p.y + r};
    for (let y = p.y - r + 1; y < p.y + r; y++) if (ok({x:p.x - r, y})) return {x:p.x - r, y};
    for (let y = p.y - r + 1; y <= p.y + r; y++) if (ok({x:p.x + r, y})) return {x:p.x + r, y};
  }
  for (let x = 0; x < G.W; x++) for (let y = 0; y < G.H; y++) if (ok({x, y})) return {x, y};
  return null;
}
function removeWrongFlags(){                                               // McH
  let any = false;
  for (let x = 0; x < G.W; x++) for (let y = 0; y < G.H; y++) {
    const c = G.grid[x][y];
    if (c.flag && !c.mine) { spawnFlagParticle({x, y}); any = true; }
  }
  if (any) Sound.play(SFX.UNPLANT);
  G.markBad = true;
  return any;
}
function playMineSound(){                                                  // OcH
  Sound.play(SFX.MINE(MINE_SOUND_ORDER[G.mineSeq] + 1));
  G.mineSeq++;
  if (G.mineSeq >= MINE_SOUND_ORDER.length) G.mineSeq = 0;
}
function revealCell(p){                                                    // CcH
  if (!inBounds(p.x, p.y) || cell(p).open || cell(p).flag) return {count:0, maxAdj:0};
  const c = cell(p);
  c.open = true;
  const res = {count:1, maxAdj:c.adj};
  spawnTile(p, c.mine);
  if (c.mine) {
    c.boom = true; c.boomTime = Date.now();
    const next = nearestHiddenMine(p);
    if (next) {
      later(() => revealCell(next), 150 + Math.random() * 550);
      if (Math.random() < 0.5) {
        const next2 = nearestHiddenMine(next);
        if (next2) later(() => revealCell(next2), 150 + Math.random() * 550);
      }
    } else {
      later(() => {
        const delay = removeWrongFlags() ? 3250 : 2250;
        later(() => setOverlay(true), delay);
      }, 750);
    }
    spawnDirt(p);
    if (!G.overlayShown) playMineSound();
  }
  if (!c.mine && c.adj === 0) {
    for (const q of neighbours(p)) {
      if (!cell(q).open) {
        const r = revealCell(q);
        res.count += r.count; res.maxAdj = Math.max(res.maxAdj, r.maxAdj);
      }
    }
  }
  return res;
}
function playDigSound(r){                                                  // DcH
  if (r.count >= 9) { Sound.play(SFX.BIG_DIG); return; }
  if (r.maxAdj >= 1 && r.maxAdj <= 8) Sound.play(SFX.REVEAL(r.maxAdj));
}
function removeAllFlags(){                                                 // EcH
  for (let x = 0; x < G.W; x++) for (let y = 0; y < G.H; y++)
    if (G.grid[x][y].flag) spawnFlagParticle({x, y});
  G.flags = 0;
}
function endGame(){                                                        // zcH
  if (G.won) later(() => { Sound.play(SFX.WIN_HARP); G.winFade = 800; }, 10);
  else G.shake = 1000;
  G.over = true; G.lockMs = 2000;
  styleOverlayCard();
}
function dig(p){                                                           // xcH
  if (!(inBounds(p.x, p.y) && !cell(p).flag)) return;
  if (G.started) {
    if (!cell(p).open) {
      const r = revealCell(p);
      if (!cell(p).mine) playDigSound(r);
    }
    if (!cell(p).flag && cell(p).mine) endGame();
  } else {
    removeAllFlags();
    const t0 = Date.now();
    let solved = false;
    do {
      placeMines(p);
      solved = G.solver.solve(p, G.grid, G.mines);
    } while (!solved && Date.now() - t0 < 150);
    later(() => { playDigSound(revealCell(p)); G.shake = 1000; }, 0);
  }
}
function chord(p){                                                         // wcH
  if (inBounds(p.x, p.y) && cell(p).open && cell(p).adj !== 0) {
    const nb = neighbours(p);
    let flagged = 0;
    for (const q of nb) if (cell(q).flag) flagged++;
    let hitMine = false;
    const agg = {count:0, maxAdj:0};
    if (flagged === cell(p).adj) {
      for (const q of nb) {
        const r = revealCell(q);
        agg.count += r.count; agg.maxAdj = Math.max(agg.maxAdj, r.maxAdj);
        if (cell(q).mine && !cell(q).flag) hitMine = true;
      }
    }
    if (hitMine) endGame(); else playDigSound(agg);
  }
}
function unopenedCount(){                                                  // ycH
  let n = 0;
  for (let x = 0; x < G.W; x++) for (let y = 0; y < G.H; y++) if (!G.grid[x][y].open) n++;
  return n;
}
function celebrate(){                                                      // AcH
  G.waveT = 0;
  for (let x = 0; x < G.W; x++) for (let y = 0; y < G.H; y++)
    if (G.grid[x][y].flag) later(() => { G.grid[x][y].flag = false; spawnFlagParticle({x, y}); }, (y + 0.5) * 165);
  later(() => {
    for (let x = 0; x < G.W; x++) for (let y = 0; y < G.H; y++) {
      if (!G.grid[x][y].mine) continue;
      const n = 2 + Math.floor(Math.random() * 3), list = [];
      const corner = cornerOf({x, y});
      for (let tries = 0; list.length < n && tries < 15; tries++) {
        const k = G.cs / 8, m = G.cs / 8;
        const pos = {x:corner.x + m + Math.random() * (G.cs - 2 * m), y:corner.y + m + Math.random() * (G.cs - 2 * m)};
        let okPos = true;
        for (const f of list) if (Math.hypot(pos.x - f.pos.x, pos.y - f.pos.y) < k * 3.5) okPos = false;
        if (okPos) list.push({
          pos, angle:Math.random() * Math.PI / 2, flip:Math.random() < 0.5, type:Math.floor(Math.random() * 4),
          color:shade(randomColor(), Math.random() * 0.1), size:Math.random() * -3, radius:(1 + Math.random() * 0.75) * k
        });
      }
      G.flowers.push(...list);
    }
  }, 1200);
  later(() => setOverlay(true), 5500);
}

/* ---------- mobile selection UI (ecH) ---------- */
function clearSelection(){ G.selected = null; G.btnDig = null; G.btnFlag = null; G.btnClose = null; }   // gcH
function computeButtons(){
  const b = G.selected;
  const cx = b.x * G.cs + G.cs / 2, cy = b.y * G.cs + G.cs / 2;
  const d = G.buttonRadius + Math.max(25, G.cs * 0.75);
  const e = Math.sqrt(2 * d * d);
  const atLeft = b.x === 0, atTop = b.y === 0;
  const open = cell(b).open, flagged = cell(b).flag;
  const nb = neighbours(b);
  let nFlag = 0, q = 8 - nb.length;
  for (const t of nb) { if (cell(t).flag) nFlag++; if (cell(t).open) q++; }
  const chordable = nFlag === cell(b).adj && nFlag + q !== 8;
  if ((!open && !flagged) || (open && chordable)) {
    const a = atTop ? Math.PI / 2 : 3 * Math.PI / 2;
    G.btnDig = {x:G.offX + cx + Math.cos(a) * d, y:G.offY + cy + Math.sin(a) * d};
  } else G.btnDig = null;
  if (!open && G.started) {
    const a = atLeft ? 0 : Math.PI;
    G.btnFlag = {x:G.offX + cx + Math.cos(a) * d, y:G.offY + cy + Math.sin(a) * d};
  } else G.btnFlag = null;
  if (G.btnDig || G.btnFlag) {
    let a = 5 * Math.PI / 4;
    if (atLeft && atTop) a = Math.PI / 4; else if (atLeft) a = 7 * Math.PI / 4; else if (atTop) a = 3 * Math.PI / 4;
    G.btnClose = {x:G.offX + cx + Math.cos(a) * e, y:G.offY + cy + Math.sin(a) * e};
  } else G.btnClose = null;
}
function hitButton(x, y, btn){                                             // ucH
  if (!btn) return false;
  let r = G.buttonRadius;
  if (btn === G.btnClose) r *= 0.75;
  const d = dpr();
  return Math.abs(btn.x - x * d) <= r && Math.abs(btn.y - y * d) <= r;
}

/* ---------- input (BcH) ---------- */
function cellAt(x, y){                                                     // tcH
  const d = dpr();
  return {x:Math.floor((x * d - G.offX) / G.cs), y:Math.floor((y * d - G.offY) / G.cs)};
}
function handlePress(x, y){
  const lmb = G.left && !G.ctrl;
  const rmb = G.right || (G.left && G.ctrl);
  const mmb = G.middle;
  if (G.over) {
    if (G.lockMs === 0 && (lmb || IS_MOBILE)) { styleOverlayCard(); setOverlay(true); }
    else if (G.lockMs > 0) G.lockMs = Math.max(0, G.lockMs - 1000);
    return;
  }
  const g = cellAt(x, y);
  if (IS_MOBILE) {
    let used = false;
    if (G.selected) {
      if (hitButton(x, y, G.btnDig)) {
        const s = G.selected;
        if (cell(s).open && cell(s).adj > 0) chord(s); else dig(s);
        used = true;
      } else if (hitButton(x, y, G.btnFlag)) { toggleFlag(G.selected); used = true; }
      else if (hitButton(x, y, G.btnClose)) used = true;
    }
    if (used) clearSelection();
    else if (!G.started && inBounds(g.x, g.y)) dig(g);
    else if (!inBounds(g.x, g.y) || (cell(g).open && cell(g).adj === 0)) clearSelection();
    else if (G.selected && G.selected.x === g.x && G.selected.y === g.y) {
      if (G.sinceInput < 350) { if (cell(G.selected).open && cell(G.selected).adj > 0) chord(G.selected); else dig(G.selected); }
      clearSelection();
    } else {
      G.selected = g; computeButtons();
      if (!G.btnDig && !G.btnFlag && !G.btnClose) clearSelection();
    }
  } else {
    if (mmb || (lmb && rmb)) chord(g);
    else if (rmb) toggleFlag(g);
    else if (lmb) dig(g);
  }
  if (unopenedCount() === G.mines && !G.over) {
    G.won = true; endGame();
    const t = G.elapsed;
    if (G.best[G.difficulty] < 0 || t < G.best[G.difficulty]) { G.best[G.difficulty] = t; saveBest(); }
    later(celebrate, 800);
  }
  G.sinceInput = 0; G.touchDown = true;
}
function localXY(clientX, clientY){
  const r = canvas.getBoundingClientRect();
  return {x:(clientX - r.left) * (canvas.clientWidth / r.width), y:(clientY - r.top) * (canvas.clientHeight / r.height)};
}
function hideTutorial(){                                                   // tfb
  if (G.tutorial) {
    G.tutorial = false;
    const t = $('tut'); t.style.opacity = '0';
    setTimeout(() => { t.style.visibility = 'hidden'; }, 200);
  }
}
function toggleMute(){                                                     // Oo
  G.muted = !G.muted;
  Sound.setMuted(G.muted);
  const b = $('mute');
  $('mutePath').setAttribute('d', G.muted ? ICON_OFF : ICON_ON);
  b.setAttribute('aria-label', G.muted ? 'Unmute audio' : 'Mute audio');
  b.title = G.muted ? 'Unmute audio' : 'Mute audio';
}
const ICON_ON  = 'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z';
const ICON_OFF = 'M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z';

if (!IS_MOBILE) {
  canvas.addEventListener('mousedown', ev => {
    Sound.unlock(); hideTutorial(); closeMenu();
    ev.preventDefault();
    if (ev.button === 0) G.left = true; else if (ev.button === 2) G.right = true; else if (ev.button === 1) G.middle = true;
    const p = localXY(ev.clientX, ev.clientY);
    handlePress(p.x, p.y);
  });
  window.addEventListener('mouseup', ev => {
    if (ev.button === 0) G.left = false; else if (ev.button === 2) G.right = false; else if (ev.button === 1) G.middle = false;
  });
  canvas.addEventListener('mousemove', ev => { const p = localXY(ev.clientX, ev.clientY); G.hover = cellAt(p.x, p.y); });
  canvas.addEventListener('mouseout', () => { G.hover = null; G.middle = G.right = G.left = false; });
  canvas.addEventListener('contextmenu', ev => ev.preventDefault());
  document.addEventListener('keyup', ev => { if (ev.keyCode === 17) G.ctrl = false; });

  /* Touch screen used in desktop mode (phone with "Desktop site", touch laptop): taps arrive as mouse clicks
     (= dig); there is no right button, so a long press plants/removes a flag. */
  let lpTimer = null, lpFired = false;
  canvas.addEventListener('touchstart', ev => {
    lpFired = false; clearTimeout(lpTimer);
    if (ev.touches.length !== 1 || G.over) return;
    const t = ev.touches[0], p = localXY(t.clientX, t.clientY);
    lpTimer = setTimeout(() => {
      const c = cellAt(p.x, p.y);
      if (inBounds(c.x, c.y)) { lpFired = true; Sound.unlock(); hideTutorial(); toggleFlag(c); }
    }, 450);
  }, {passive:true});
  canvas.addEventListener('touchmove', () => { clearTimeout(lpTimer); }, {passive:true});
  canvas.addEventListener('touchend', ev => {
    clearTimeout(lpTimer);
    if (lpFired) { ev.preventDefault(); lpFired = false; }   // swallow the emulated click after a long press
  }, {passive:false});
  canvas.addEventListener('touchcancel', () => clearTimeout(lpTimer));
} else {
  canvas.addEventListener('touchstart', ev => {
    Sound.unlock(); hideTutorial(); closeMenu();
    ev.preventDefault();
    const t = ev.changedTouches[0], p = localXY(t.clientX, t.clientY);
    handlePress(p.x, p.y);
  }, {passive:false});
  canvas.addEventListener('touchmove', ev => {
    ev.preventDefault();
    const t = ev.changedTouches[0], p = localXY(t.clientX, t.clientY), c = cellAt(p.x, p.y);
    if (G.selected && !(G.selected.x === c.x && G.selected.y === c.y)) G.touchDown = false;
  }, {passive:false});
  canvas.addEventListener('touchend', ev => { ev.preventDefault(); G.touchDown = false; }, {passive:false});
  canvas.addEventListener('touchcancel', () => { G.touchDown = false; });
  canvas.addEventListener('contextmenu', ev => ev.preventDefault());
  const ro = window.ResizeObserver ? new ResizeObserver(() => { layout(); if (G.selected) computeButtons(); }) : null;
  if (ro) ro.observe(root); else window.addEventListener('resize', () => { layout(); if (G.selected) computeButtons(); });
}
document.addEventListener('keydown', ev => {
  Sound.unlock();
  switch (ev.keyCode) {
    case 77: toggleMute(); break;                                // M
    case 32: case 13:                                            // space / enter
      if (G.over) { reset(); break; }
      return;
    case 82: reset(); break;                                     // R
    case 17: G.ctrl = true; return;                              // Ctrl
    default: return;
  }
  ev.preventDefault();
});
window.addEventListener('blur', () => { G.left = G.right = G.middle = G.ctrl = false; });
window.addEventListener('resize', fitDesktop);
$('again').addEventListener('click', () => reset());
$('mute').addEventListener('click', toggleMute);
$('mutePath').setAttribute('d', ICON_ON);

/* ---------- difficulty dropdown ---------- */
const ddmenu = $('ddmenu'), ddbtn = $('ddbtn');
function closeMenu(){ ddmenu.classList.remove('open'); ddbtn.setAttribute('aria-expanded', 'false'); }
function toggleMenu(){
  const open = ddmenu.classList.toggle('open');
  ddbtn.setAttribute('aria-expanded', String(open));
}
ddbtn.addEventListener('click', ev => { ev.stopPropagation(); toggleMenu(); });
ddbtn.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'ArrowDown') { ev.preventDefault(); ev.stopPropagation(); toggleMenu(); } });
document.addEventListener('click', closeMenu);
for (const item of ddmenu.querySelectorAll('.mi')) {
  item.addEventListener('click', ev => { ev.stopPropagation(); setDifficulty(item.dataset.difficulty); closeMenu(); });
  item.addEventListener('keydown', ev => {
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); ev.stopPropagation(); setDifficulty(item.dataset.difficulty); closeMenu(); ddbtn.focus(); }
    if (ev.key === 'Escape') { closeMenu(); ddbtn.focus(); }
  });
}
function setDifficulty(d){                                                 // fu
  if (G.difficulty === d) return;
  hideTutorial();
  G.difficulty = d;
  $('ddlabel').textContent = LABELS[d];
  for (const item of ddmenu.querySelectorAll('.mi')) item.setAttribute('aria-checked', String(item.dataset.difficulty === d));
  reset();
}

/* =====================================================================
 *  Update loop (gB) and rendering (ncH / lcH / RcH / ScH / TcH)
 * ===================================================================== */
function update(now){
  const dt = now - G.lastTs; G.lastTs = now;
  G.sinceInput += dt;
  if (G.started) { if (!G.over) G.elapsed = now - G.startTime; } else G.startTime = now;
  let a = dt * 0.01;
  for (let i = 0; i < G.dirtP.length; i++) {
    const p = G.dirtP[i];
    if (p.vel.y < 0) p.vel.y += 4 * a;
    else { p.vel.x += 1.2 * a * (p.pos.x < p.midpoint ? 1 : -1); p.vel.y = Math.abs(p.vel.x) * 0.5; }
    p.pos.x += p.vel.x * a; p.pos.y += p.vel.y * a;
    p.size = Math.max(0, p.size - a * 0.1);
    if (p.size <= 0) { G.dirtP.splice(i, 1); i--; }
  }
  for (let i = 0; i < G.tilesP.length; i++) {
    const p = G.tilesP[i];
    p.vel.y += 4 * a; p.pos.x += p.vel.x * a; p.pos.y += p.vel.y * a; p.angle += p.spin * a;
    p.color = rgb2hex(mixToward([0,0,0], hex2rgb(p.color), a * 0.01));
    p.size = Math.max(0, p.size - a * 0.125);
    if (p.size <= 0) { G.tilesP.splice(i, 1); i--; }
  }
  for (let i = 0; i < G.flagP.length; i++) {
    const p = G.flagP[i];
    p.vel.y += 4 * a; p.pos.x += p.vel.x * a; p.pos.y += p.vel.y * a; p.angle += p.spin * a;
    p.size = Math.max(0, p.size - a * 0.125);
    if (p.size <= 0 || p.pos.y > canvas.height * 1.1) { G.flagP.splice(i, 1); i--; }
  }
  a = dt * 0.075;
  for (let x = 0; x < G.W; x++) for (let y = 0; y < G.H; y++) if (G.grid[x][y].flag) G.grid[x][y].flagAnim += a;
  a = dt * 0.001;
  if (G.won && G.waveT >= 0) G.waveT += a;
  for (const f of G.flowers) f.size = Math.min(1, f.size + a);
  if (G.lockMs > 0) G.lockMs = Math.max(0, G.lockMs - dt);
  if (G.shake > 0) G.shake = Math.max(0, G.shake - dt);
  if (G.winFade > 0) G.winFade = Math.max(0, G.winFade - dt);
  if (IS_MOBILE && G.touchDown && G.selected && G.sinceInput > 700) {      // long-press = flag
    G.touchDown = false; toggleFlag(G.selected); clearSelection();
  }
  draw(); updateHud();
}

function waveColor(base, blue, p){                                         // TcH
  let d = G.waveT - p.y * 0.05;
  if (d < 0) return base;
  if (d > 1) {
    d = Math.max(1, G.waveT - p.y * 0.2);
    d = 2 * Math.PI * ((d - 1) % 8 / 8);
    d = (Math.sin(d + 3 * Math.PI / 2) + 1) / 2;
    const alt = blue === '#83C4F7' ? '#90CAF9' : '#83C4F7';
    return rgb2hex(mixToward(hex2rgb(alt), hex2rgb(blue), d));
  }
  return rgb2hex(mixToward(hex2rgb(blue), hex2rgb(base), d));
}
function fillCell(p, base){                                                // ScH
  const c = cell(p), same = (a, b) => a && b && a.x === b.x && a.y === b.y;
  const hov = same(p, G.hover) && (!c.open || c.adj > 0);
  let near;
  if (G.hover === null || !(G.middle || (G.left && !G.ctrl && (G.right || (G.left && G.ctrl)))) || c.open || c.flag) {
    near = (G.selected === null || !cell(G.selected).open || c.open || c.flag) ? false
         : Math.abs(p.x - G.selected.x) <= 1 && Math.abs(p.y - G.selected.y) <= 1;
  } else near = Math.abs(p.x - G.hover.x) <= 1 && Math.abs(p.y - G.hover.y) <= 1;
  let col = base;
  if (G.over || (!hov && !near)) {
    if (G.winFade > 0 && !c.open) col = shade(col, -(G.winFade / 800) / 2);
    else if (G.over && c.boom) {
      const k = (1 - (Date.now() - c.boomTime) / 600) * 0.85;
      if (k > 0) col = shade(col, Math.min(0, -k));
    }
  } else col = shade(col, -0.25);
  ctx.fillStyle = col;
  ctx.fillRect(p.x * G.cs, p.y * G.cs, G.cs, G.cs);
}
function drawCell(p){                                                      // lcH + RcH
  const c = cell(p);
  let state;
  if (G.over) state = (c.mine && c.open && !c.flag) ? 'DETONATED_MINE' : c.flag ? ((!c.mine && G.markBad) ? 'BAD_FLAG' : 'FLAG') : c.open ? (c.adj > 0 ? 'ADJACENT' : 'DUG') : 'GRASS';
  else state = c.open ? (c.adj > 0 ? 'ADJACENT' : 'DUG') : c.flag ? 'FLAG' : 'GRASS';
  paint(p, state);
  if (G.selected && G.selected.x === p.x && G.selected.y === p.y) {
    ctx.strokeStyle = '#578A34'; ctx.lineWidth = G.cs / 10;
    ctx.beginPath(); ctx.rect(p.x * G.cs, p.y * G.cs, G.cs, G.cs); ctx.stroke();
  }
}
function paint(p, state){
  const even = (p.x + p.y) % 2 === 0, c = cell(p);
  switch (state) {
    case 'GRASS': fillCell(p, even ? '#AAD751' : '#A2D149'); break;
    case 'DUG': fillCell(p, even ? waveColor('#E5C29F', '#90CAF9', p) : waveColor('#D7B899', '#83C4F7', p)); break;
    case 'ADJACENT': {
      paint(p, 'DUG');
      const size = G.cs * 0.62;
      ctx.font = 'bold ' + size + 'pt Roboto, "Helvetica Neue", Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = waveColor(NUMBER_COLORS[c.adj - 1], even ? '#90CAF9' : '#83C4F7', p);
      ctx.fillText(String(c.adj), p.x * G.cs + G.cs / 2, p.y * G.cs + size + (G.cs - size) / 2.1);
      break;
    }
    case 'FLAG': {
      paint(p, 'GRASS');
      const sheet = IMG.flagPlant, frames = 10, w = sheet.width, h = sheet.height / frames;
      const frame = Math.min(Math.floor(c.flagAnim), 9), s = G.cs / w;
      ctx.drawImage(sheet, 0, h * Math.max(0, frame), w, h, p.x * G.cs, p.y * G.cs, w * s, h * s);
      break;
    }
    case 'BAD_FLAG': paint(p, 'GRASS'); ctx.drawImage(IMG.wrong, p.x * G.cs, p.y * G.cs, G.cs, G.cs); break;
    case 'DETONATED_MINE':
      fillCell(p, c.color);
      paint(p, 'MINE');
      break;
    case 'MINE':
      ctx.fillStyle = shade(c.color, 0.35);
      ctx.beginPath(); ctx.arc(p.x * G.cs + G.cs / 2, p.y * G.cs + G.cs / 2, G.cs / 4, 0, 2 * Math.PI); ctx.fill();
      break;
  }
}
function drawFlower(f){
  ctx.save();
  ctx.translate(Math.round(f.pos.x), Math.round(f.pos.y));
  let ang = f.angle * Math.PI / 180;
  ang += (f.flip ? 1 : -1) * f.size;
  ctx.rotate(ang);
  let d = f.radius * f.size;
  const dark = shade(f.color, 0.2);
  switch (f.type) {
    case 0:
      ctx.fillStyle = f.color; ctx.beginPath(); ctx.arc(0, 0, d, 0, 2 * Math.PI); ctx.fill();
      ctx.fillStyle = dark; ctx.beginPath(); ctx.arc(0, 0, d * 0.3, 0, 2 * Math.PI); ctx.fill();
      break;
    case 1: {
      const e = d * 2, h = e / 3;
      ctx.fillStyle = f.color;
      ctx.fillRect(-e / 2, -h / 2, e, h);
      ctx.rotate(Math.PI / 3); ctx.fillRect(-e / 2, -h / 2, e, h); ctx.rotate(-Math.PI / 3);
      ctx.rotate(2 * Math.PI / 3); ctx.fillRect(-e / 2, -h / 2, e, h); ctx.rotate(-2 * Math.PI / 3);
      ctx.fillStyle = dark; ctx.beginPath(); ctx.arc(0, 0, d * 0.4, 0, 2 * Math.PI); ctx.fill();
      break;
    }
    case 2:
      d *= 2 / 3;
      ctx.fillStyle = f.color;
      ctx.scale(2, 1); ctx.beginPath(); ctx.arc(0, 0, d, 0, 2 * Math.PI); ctx.fill();
      ctx.scale(0.5, 2); ctx.beginPath(); ctx.arc(0, 0, d, 0, 2 * Math.PI); ctx.fill();
      ctx.scale(1, 0.5);
      ctx.fillStyle = dark; ctx.beginPath(); ctx.arc(0, 0, d * 0.5, 0, 2 * Math.PI); ctx.fill();
      break;
    case 3: {
      const e = d * 2;
      ctx.fillStyle = f.color;
      ctx.fillRect(-e / 2, -e / 2, e, e);
      ctx.rotate(Math.PI / 4); ctx.fillRect(-e / 2, -e / 2, e, e); ctx.rotate(-Math.PI / 4);
      ctx.fillStyle = dark; ctx.beginPath(); ctx.arc(0, 0, d * 0.5, 0, 2 * Math.PI); ctx.fill();
      break;
    }
  }
  ctx.restore();
}
function circleButton(pt, radius, icon, iconScale, dx){
  ctx.fillStyle = '#578A34';
  ctx.beginPath(); ctx.arc(pt.x, pt.y, radius, 0, 2 * Math.PI); ctx.fill();
  const s = radius * iconScale;
  ctx.drawImage(icon, pt.x - s / (dx || 2), pt.y - s / 2, s, s);
}
function draw(){                                                           // ncH
  ctx.setTransform(1, 0, 0, 1, G.offX, G.offY);
  if (G.started) {
    for (let x = 0; x < G.W; x++) for (let y = 0; y < G.H; y++)
      if (G.grid[x][y].open && !G.grid[x][y].boom) drawCell({x, y});
    ctx.fillStyle = '#87AF3A';
    const b = Math.round(G.cs * 0.08);
    for (let x = 0; x < G.W; x++) for (let y = 0; y < G.H; y++) {
      const c = G.grid[x][y];
      if (!c.open || c.boom) {
        if ((x > 0 && G.grid[x-1][y].open) || (y > 0 && G.grid[x][y-1].open) ||
            (x < G.W - 1 && G.grid[x+1][y].open) || (y < G.H - 1 && G.grid[x][y+1].open))
          ctx.fillRect(x * G.cs - b, y * G.cs - b, G.cs + 2 * b, G.cs + 2 * b);
      }
    }
  }
  for (let x = 0; x < G.W; x++) for (let y = 0; y < G.H; y++) {
    const c = G.grid[x][y];
    if (c.open && !c.boom) continue;
    drawCell({x, y});
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#578A34';
  ctx.fillRect(0, 0, G.offX, canvas.height);
  ctx.fillRect(canvas.width - G.offX, 0, G.offX, canvas.height);
  ctx.fillRect(0, 0, canvas.width, G.offY);
  ctx.fillRect(0, canvas.height - G.offY, canvas.width, G.offY);
  ctx.setTransform(1, 0, 0, 1, G.offX, G.offY);
  if (IS_MOBILE && G.selected) drawCell(G.selected);

  for (const f of G.flowers) { if (f.size > 0) drawFlower(f); }
  for (const p of G.dirtP) {
    ctx.save();
    ctx.translate(Math.round(p.pos.x + G.cs / 6), Math.round(p.pos.y + G.cs / 9));
    ctx.rotate(p.vel.x * 0.025);
    const s = Math.min(1, p.size);
    ctx.fillStyle = p.color;
    ctx.fillRect(-(G.cs / 6) * s, -(G.cs / 9) * s, G.cs / 3 * s, G.cs / 4.5 * s);
    ctx.restore();
  }
  for (const p of G.tilesP) {
    ctx.save();
    ctx.translate(Math.round(p.pos.x + G.cs / 2), Math.round(p.pos.y + G.cs / 2));
    ctx.rotate(p.angle * Math.PI / 180);
    const s = Math.min(1, p.size);
    ctx.fillStyle = p.color;
    ctx.fillRect(-(G.cs / 2) * s, -(G.cs / 2) * s, G.cs * s, G.cs * s);
    ctx.restore();
  }
  for (const p of G.flagP) {
    ctx.save();
    ctx.translate(Math.round(p.pos.x + G.cs / 2), Math.round(p.pos.y + G.cs / 2));
    ctx.rotate(p.angle * Math.PI / 180);
    const s = Math.min(1, p.size);
    ctx.drawImage(IMG.flag, -(G.cs / 2) * s, -(G.cs / 2) * s, G.cs * s, G.cs * s);
    ctx.restore();
  }
  if (G.shake > 0) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const m = G.shake / 1000 * 8, sx = Math.random() * m - m / 2, sy = Math.random() * m - m / 2;
    if (canvas.height > 0 && canvas.width > 0) {
      ctx.drawImage(canvas, sx, sy);
      ctx.setTransform(1, 0, 0, 1, G.offX, G.offY);
    }
  }
  if (IS_MOBILE) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (G.btnDig)   circleButton(G.btnDig, G.buttonRadius, IMG.shovel, 2.4, 2);
    if (G.btnFlag)  circleButton(G.btnFlag, G.buttonRadius, IMG.flag, 2.25, 2.25);
    if (G.btnClose) circleButton(G.btnClose, G.buttonRadius * 0.75, IMG.close, 1.5, 2);
    ctx.setTransform(1, 0, 0, 1, G.offX, G.offY);
  }
}

/* =====================================================================
 *  Boot
 * ===================================================================== */
function frame(){ update(Date.now()); requestAnimationFrame(frame); }
function onAssetsReady(){
  if (G.ready) return;
  G.ready = true;
  if (IS_MOBILE) $('tut').style.display = 'block';
  $('loader').style.visibility = 'hidden';
  G.lastTs = Date.now();
  requestAnimationFrame(frame);
}
root.classList.toggle('mobile', IS_MOBILE);
Sound.init();
reset();
window.minesweeper = {G, Solver, reset, dig, toggleFlag, chord};   // handy for debugging in the console
})();
