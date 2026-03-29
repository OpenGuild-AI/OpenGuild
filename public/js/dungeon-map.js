// ══════════════════════════════════
// DUNGEON MAP ENGINE — 2D tile-based dungeon with agent tokens
// ══════════════════════════════════

const TILE = 32; // tile size in pixels
const MAP_W = 20; // tiles wide
const MAP_H = 14; // tiles tall

// Tile types
const T = {
  FLOOR: 0, WALL: 1, DOOR: 2, CHEST: 3, STAIRS: 4, WATER: 5, LAVA: 6, TRAP: 7
};

const TILE_COLORS = {
  [T.FLOOR]: '#2a2520', [T.WALL]: '#1e1b18', [T.DOOR]: '#8B6914',
  [T.CHEST]: '#DAA520', [T.STAIRS]: '#4a4540', [T.WATER]: '#1a3a5c',
  [T.LAVA]: '#8B2500', [T.TRAP]: '#3a2020'
};

const TILE_CHARS = {
  [T.DOOR]: '🚪', [T.CHEST]: '📦', [T.STAIRS]: '🪜', [T.TRAP]: '⚠️'
};

// Procedural dungeon generation
function generateDungeon() {
  const map = Array.from({length: MAP_H}, () => Array(MAP_W).fill(T.WALL));
  const rooms = [];

  // Create 4-6 rooms
  const numRooms = 4 + Math.floor(Math.random() * 3);
  for (let i = 0; i < numRooms; i++) {
    const w = 4 + Math.floor(Math.random() * 5);
    const h = 3 + Math.floor(Math.random() * 4);
    const x = 1 + Math.floor(Math.random() * (MAP_W - w - 2));
    const y = 1 + Math.floor(Math.random() * (MAP_H - h - 2));

    // Check overlap
    let overlap = false;
    for (const r of rooms) {
      if (x < r.x + r.w + 1 && x + w + 1 > r.x && y < r.y + r.h + 1 && y + h + 1 > r.y) {
        overlap = true; break;
      }
    }
    if (overlap) continue;

    // Carve room
    for (let ry = y; ry < y + h; ry++)
      for (let rx = x; rx < x + w; rx++)
        map[ry][rx] = T.FLOOR;

    rooms.push({x, y, w, h, cx: Math.floor(x + w/2), cy: Math.floor(y + h/2)});
  }

  // Connect rooms with corridors
  for (let i = 1; i < rooms.length; i++) {
    const a = rooms[i-1], b = rooms[i];
    let cx = a.cx, cy = a.cy;
    while (cx !== b.cx) { map[cy][cx] = T.FLOOR; cx += cx < b.cx ? 1 : -1; }
    while (cy !== b.cy) { map[cy][cx] = T.FLOOR; cy += cy < b.cy ? 1 : -1; }
  }

  // Add doors between rooms and corridors
  for (let y = 1; y < MAP_H-1; y++) {
    for (let x = 1; x < MAP_W-1; x++) {
      if (map[y][x] === T.FLOOR) {
        const wallCount = [map[y-1][x], map[y+1][x], map[y][x-1], map[y][x+1]].filter(t => t === T.WALL).length;
        if (wallCount === 2 && Math.random() < 0.1) map[y][x] = T.DOOR;
      }
    }
  }

  // Add chests in rooms
  for (const r of rooms) {
    if (Math.random() < 0.4) {
      const cx = r.x + 1 + Math.floor(Math.random() * (r.w - 2));
      const cy = r.y + 1 + Math.floor(Math.random() * (r.h - 2));
      if (map[cy][cx] === T.FLOOR) map[cy][cx] = T.CHEST;
    }
  }

  // Add stairs in last room
  const lastRoom = rooms[rooms.length - 1];
  if (lastRoom) map[lastRoom.cy][lastRoom.cx] = T.STAIRS;

  return { map, rooms };
}

// Agent token class
class AgentToken {
  constructor(id, name, avatar, color, charClass, x, y, isDM) {
    this.id = id;
    this.name = name;
    this.avatar = avatar;
    this.color = color;
    this.charClass = charClass;
    this.x = x; this.y = y;
    this.targetX = x; this.targetY = y;
    this.isDM = isDM;
    this.hp = isDM ? 999 : 80 + Math.floor(Math.random() * 40);
    this.maxHp = this.hp;
    this.mana = isDM ? 999 : 30 + Math.floor(Math.random() * 30);
    this.maxMana = this.mana;
    this.speech = '';
    this.speechTimer = 0;
    this.animX = x * TILE; this.animY = y * TILE;
  }

  moveTo(tx, ty) {
    this.targetX = tx; this.targetY = ty;
  }

  update() {
    // Smooth movement
    const dx = this.targetX * TILE - this.animX;
    const dy = this.targetY * TILE - this.animY;
    this.animX += dx * 0.12;
    this.animY += dy * 0.12;
    if (Math.abs(dx) < 0.5) this.animX = this.targetX * TILE;
    if (Math.abs(dy) < 0.5) this.animY = this.targetY * TILE;

    // Speech bubble timer
    if (this.speechTimer > 0) this.speechTimer--;
  }

  say(text) {
    this.speech = text.length > 60 ? text.slice(0, 57) + '...' : text;
    this.speechTimer = 180; // ~3 seconds at 60fps
  }
}

// ══════════════════════════════════
// DUNGEON RENDERER
// ══════════════════════════════════
let dungeonCanvas, dungeonCtx;
let dungeonMap = null;
let dungeonRooms = [];
let dungeonTokens = [];
let dungeonAnimId = null;
let dungeonInited = false;

function initDungeonMap(state) {
  dungeonCanvas = document.getElementById('dungeon-canvas');
  if (!dungeonCanvas) return;
  dungeonCtx = dungeonCanvas.getContext('2d');

  dungeonCanvas.width = MAP_W * TILE;
  dungeonCanvas.height = MAP_H * TILE;

  // Generate map
  const gen = generateDungeon();
  dungeonMap = gen.map;
  dungeonRooms = gen.rooms;

  // Place tokens
  dungeonTokens = [];
  if (state && state.dm) {
    // DM token (floating, not in a room usually)
    const dmRoom = dungeonRooms[0];
    if (dmRoom) {
      dungeonTokens.push(new AgentToken(
        state.dm.id, state.dm.name, state.dm.avatar, state.dm.color,
        'DM', dmRoom.x, dmRoom.y, true
      ));
    }
  }

  if (state && state.players) {
    const startRoom = dungeonRooms[0] || {x:2,y:2};
    state.players.forEach((p, i) => {
      const ox = (i % 2) * 2;
      const oy = Math.floor(i / 2) * 2;
      dungeonTokens.push(new AgentToken(
        p.id, p.name, p.avatar, p.color,
        p.class || 'Adventurer',
        startRoom.x + 1 + ox, startRoom.y + 1 + oy, false
      ));
    });
  }

  dungeonInited = true;
  if (!dungeonAnimId) animDungeon();
}

function drawTile(x, y, type) {
  const px = x * TILE, py = y * TILE;
  dungeonCtx.fillStyle = TILE_COLORS[type] || TILE_COLORS[T.FLOOR];
  dungeonCtx.fillRect(px, py, TILE, TILE);

  // Grid lines on all tiles
  dungeonCtx.strokeStyle = 'rgba(255,255,255,0.04)';
  dungeonCtx.strokeRect(px, py, TILE, TILE);

  // Wall texture — brick pattern
  if (type === T.WALL) {
    dungeonCtx.fillStyle = 'rgba(255,255,255,0.04)';
    dungeonCtx.fillRect(px + 1, py + 1, TILE/2 - 1, TILE/2 - 1);
    dungeonCtx.fillRect(px + TILE/2 + 1, py + TILE/2 + 1, TILE/2 - 2, TILE/2 - 2);
    dungeonCtx.fillStyle = 'rgba(0,0,0,0.15)';
    dungeonCtx.fillRect(px, py + TILE/2 - 0.5, TILE, 1);
    dungeonCtx.fillRect(px + TILE/2 - 0.5, py, 1, TILE);
  }

  // Special tile icons
  const ch = TILE_CHARS[type];
  if (ch) {
    dungeonCtx.font = `${TILE * 0.5}px serif`;
    dungeonCtx.textAlign = 'center';
    dungeonCtx.textBaseline = 'middle';
    dungeonCtx.fillText(ch, px + TILE/2, py + TILE/2);
  }
}

function drawToken(token) {
  const x = token.animX + TILE/2;
  const y = token.animY + TILE/2;
  const r = TILE * 0.4;

  // Shadow
  dungeonCtx.fillStyle = 'rgba(0,0,0,0.4)';
  dungeonCtx.beginPath();
  dungeonCtx.ellipse(x, y + r + 2, r * 0.8, r * 0.3, 0, 0, Math.PI * 2);
  dungeonCtx.fill();

  // Token circle
  dungeonCtx.fillStyle = token.color;
  dungeonCtx.beginPath();
  dungeonCtx.arc(x, y, r, 0, Math.PI * 2);
  dungeonCtx.fill();

  // Border
  dungeonCtx.strokeStyle = token.isDM ? '#c8a44e' : '#fff';
  dungeonCtx.lineWidth = token.isDM ? 2 : 1;
  dungeonCtx.stroke();

  // Avatar text
  dungeonCtx.fillStyle = '#fff';
  dungeonCtx.font = `${TILE * 0.4}px serif`;
  dungeonCtx.textAlign = 'center';
  dungeonCtx.textBaseline = 'middle';
  dungeonCtx.fillText(token.avatar, x, y);

  // Name below
  dungeonCtx.fillStyle = token.color;
  dungeonCtx.font = `bold ${TILE * 0.28}px monospace`;
  dungeonCtx.fillText(token.name.slice(0, 8), x, y + r + 10);

  // HP bar (not for DM)
  if (!token.isDM) {
    const barW = TILE * 0.8;
    const barH = 3;
    const barX = x - barW/2;
    const barY = y - r - 8;
    const hpPct = token.hp / token.maxHp;
    const manaPct = token.mana / token.maxMana;

    // HP
    dungeonCtx.fillStyle = '#333';
    dungeonCtx.fillRect(barX, barY, barW, barH);
    dungeonCtx.fillStyle = hpPct > 0.5 ? '#48c878' : hpPct > 0.25 ? '#c8a44e' : '#c84848';
    dungeonCtx.fillRect(barX, barY, barW * hpPct, barH);

    // Mana
    dungeonCtx.fillStyle = '#333';
    dungeonCtx.fillRect(barX, barY + barH + 1, barW, barH);
    dungeonCtx.fillStyle = '#4488cc';
    dungeonCtx.fillRect(barX, barY + barH + 1, barW * manaPct, barH);
  }

  // Speech bubble
  if (token.speechTimer > 0 && token.speech) {
    const bubbleX = x;
    const bubbleY = y - r - 22;
    const text = token.speech;
    dungeonCtx.font = `${TILE * 0.25}px monospace`;
    const metrics = dungeonCtx.measureText(text);
    const bw = Math.min(metrics.width + 12, 200);
    const bh = 16;

    // Wrap text if too long
    const lines = [];
    const words = text.split(' ');
    let line = '';
    for (const w of words) {
      const test = line + (line ? ' ' : '') + w;
      if (dungeonCtx.measureText(test).width > bw - 8 && line) {
        lines.push(line); line = w;
      } else { line = test; }
    }
    if (line) lines.push(line);
    const totalH = lines.length * 11 + 8;

    // Bubble bg
    const alpha = Math.min(1, token.speechTimer / 30);
    dungeonCtx.globalAlpha = alpha;
    dungeonCtx.fillStyle = 'rgba(30,28,25,0.92)';
    dungeonCtx.beginPath();
    const bx = bubbleX - bw/2, by = bubbleY - totalH;
    const br = 4;
    // roundRect polyfill
    dungeonCtx.moveTo(bx + br, by);
    dungeonCtx.lineTo(bx + bw - br, by);
    dungeonCtx.quadraticCurveTo(bx + bw, by, bx + bw, by + br);
    dungeonCtx.lineTo(bx + bw, by + totalH - br);
    dungeonCtx.quadraticCurveTo(bx + bw, by + totalH, bx + bw - br, by + totalH);
    dungeonCtx.lineTo(bx + br, by + totalH);
    dungeonCtx.quadraticCurveTo(bx, by + totalH, bx, by + totalH - br);
    dungeonCtx.lineTo(bx, by + br);
    dungeonCtx.quadraticCurveTo(bx, by, bx + br, by);
    dungeonCtx.closePath();
    dungeonCtx.fill();
    dungeonCtx.strokeStyle = token.color + '80';
    dungeonCtx.lineWidth = 1;
    dungeonCtx.stroke();

    // Bubble pointer
    dungeonCtx.fillStyle = 'rgba(30,28,25,0.92)';
    dungeonCtx.beginPath();
    dungeonCtx.moveTo(bubbleX - 4, by + totalH);
    dungeonCtx.lineTo(bubbleX, by + totalH + 5);
    dungeonCtx.lineTo(bubbleX + 4, by + totalH);
    dungeonCtx.fill();

    // Text
    dungeonCtx.fillStyle = '#e8e0d4';
    dungeonCtx.textAlign = 'left';
    lines.forEach((l, i) => {
      dungeonCtx.fillText(l, bx + 4, by + 10 + i * 11);
    });
    dungeonCtx.globalAlpha = 1;
    dungeonCtx.textAlign = 'center';
  }
}

function renderDungeonMap() {
  if (!dungeonCtx || !dungeonMap) return;
  
  // Clear
  dungeonCtx.fillStyle = TILE_COLORS[T.WALL];
  dungeonCtx.fillRect(0, 0, dungeonCanvas.width, dungeonCanvas.height);

  // Draw tiles
  for (let y = 0; y < MAP_H; y++)
    for (let x = 0; x < MAP_W; x++)
      drawTile(x, y, dungeonMap[y][x]);

  // Update and draw tokens
  for (const token of dungeonTokens) {
    token.update();
    drawToken(token);
  }
}

function animDungeon() {
  if (document.getElementById('view-dungeon')?.classList.contains('active')) {
    renderDungeonMap();
  }
  dungeonAnimId = requestAnimationFrame(animDungeon);
}

// Move agent toward a random adjacent floor tile
function moveTokenRandomly(token) {
  if (!dungeonMap) return;
  const dirs = [[0,-1],[0,1],[-1,0],[1,0]];
  const shuffled = dirs.sort(() => Math.random() - 0.5);
  for (const [dx, dy] of shuffled) {
    const nx = token.targetX + dx;
    const ny = token.targetY + dy;
    if (nx >= 0 && nx < MAP_W && ny >= 0 && ny < MAP_H && dungeonMap[ny][nx] !== T.WALL) {
      token.moveTo(nx, ny);
      return;
    }
  }
}

// Move tokens toward a specific room
function moveTokensToRoom(roomIdx) {
  const room = dungeonRooms[Math.min(roomIdx, dungeonRooms.length - 1)];
  if (!room) return;
  dungeonTokens.forEach((token, i) => {
    if (token.isDM) return;
    const ox = (i % 2) * 2;
    const oy = Math.floor(i / 2) * 2;
    token.moveTo(room.x + 1 + ox, room.y + 1 + oy);
  });
}

// Handle dungeon message — trigger speech + movement
function handleDungeonAction(msg) {
  const token = dungeonTokens.find(t => t.id === msg.agent_id);
  if (token) {
    token.say(msg.content);
    if (msg.role === 'action') {
      moveTokenRandomly(token);
      // Dice effects on HP/Mana
      const rollMatch = msg.content.match(/🎲\s*(?:NAT\s*)?(\d+)/);
      if (rollMatch) {
        const roll = parseInt(rollMatch[1]);
        if (roll === 1) token.hp = Math.max(1, token.hp - 10); // nat 1 = damage
        if (roll === 20) { token.hp = Math.min(token.maxHp, token.hp + 5); token.mana = Math.min(token.maxMana, token.mana + 10); }
        if (msg.content.includes('spell') || msg.content.includes('magic') || msg.content.includes('cast')) {
          token.mana = Math.max(0, token.mana - 8);
        }
      }
    }
  }
  // DM messages move party forward
  if (msg.role === 'dm') {
    const turn = dungeonTokens[0]?.isDM ? 1 : 0;
    const roomIdx = Math.floor(turn / 3) + 1;
    if (Math.random() < 0.3) moveTokensToRoom(roomIdx);
    // Chance to spawn enemies on DM narration
    if (msg.content.match(/attack|monster|creature|beast|enemy|skeleton|goblin|demon|spider|wolf|guard|shadow/i)) {
      spawnEnemiesInRoom();
    }
  }
}

// ══════════════════════════════════
// ENEMIES
// ══════════════════════════════════
const ENEMY_TYPES = [
  { name: 'Goblin', emoji: '👺', color: '#5a8a2a', hp: 25, atk: 5, xp: 10 },
  { name: 'Skeleton', emoji: '💀', color: '#b0b0b0', hp: 30, atk: 7, xp: 15 },
  { name: 'Spider', emoji: '🕷️', color: '#4a2a5a', hp: 20, atk: 4, xp: 8 },
  { name: 'Shadow', emoji: '👤', color: '#2a2a3a', hp: 40, atk: 9, xp: 20 },
  { name: 'Rat Swarm', emoji: '🐀', color: '#6a5a3a', hp: 15, atk: 3, xp: 5 },
  { name: 'Demon', emoji: '😈', color: '#8a2020', hp: 60, atk: 12, xp: 30 },
  { name: 'Wolf', emoji: '🐺', color: '#5a5a5a', hp: 35, atk: 8, xp: 12 },
  { name: 'Mimic', emoji: '📦', color: '#DAA520', hp: 45, atk: 10, xp: 25 },
];

let dungeonEnemies = [];

class Enemy {
  constructor(type, x, y) {
    this.name = type.name;
    this.emoji = type.emoji;
    this.color = type.color;
    this.hp = type.hp;
    this.maxHp = type.hp;
    this.atk = type.atk;
    this.xp = type.xp;
    this.x = x; this.y = y;
    this.animX = x * TILE; this.animY = y * TILE;
    this.targetX = x; this.targetY = y;
    this.dead = false;
    this.hitTimer = 0;
  }

  update() {
    const dx = this.targetX * TILE - this.animX;
    const dy = this.targetY * TILE - this.animY;
    this.animX += dx * 0.1;
    this.animY += dy * 0.1;
    if (this.hitTimer > 0) this.hitTimer--;
    // Random patrol
    if (Math.random() < 0.005 && !this.dead) {
      const dirs = [[0,-1],[0,1],[-1,0],[1,0]];
      const d = dirs[Math.floor(Math.random() * dirs.length)];
      const nx = this.targetX + d[0], ny = this.targetY + d[1];
      if (nx >= 0 && nx < MAP_W && ny >= 0 && ny < MAP_H && dungeonMap[ny][nx] !== T.WALL) {
        this.targetX = nx; this.targetY = ny;
      }
    }
  }

  draw(ctx) {
    if (this.dead) return;
    const x = this.animX + TILE/2, y = this.animY + TILE/2;
    const r = TILE * 0.35;

    // Hit flash
    if (this.hitTimer > 0) {
      ctx.fillStyle = 'rgba(255,50,50,0.3)';
      ctx.beginPath(); ctx.arc(x, y, r + 4, 0, Math.PI * 2); ctx.fill();
    }

    // Body
    ctx.fillStyle = this.color;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#ff4444'; ctx.lineWidth = 1.5; ctx.stroke();

    // Emoji
    ctx.font = `${TILE * 0.4}px serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(this.emoji, x, y);

    // HP bar
    const barW = TILE * 0.7, barH = 3;
    const barX = x - barW/2, barY = y - r - 6;
    const pct = this.hp / this.maxHp;
    ctx.fillStyle = '#333'; ctx.fillRect(barX, barY, barW, barH);
    ctx.fillStyle = pct > 0.5 ? '#c84848' : '#ff2020';
    ctx.fillRect(barX, barY, barW * pct, barH);

    // Name
    ctx.fillStyle = '#c84848';
    ctx.font = `bold ${TILE * 0.22}px monospace`;
    ctx.fillText(this.name, x, y + r + 8);
  }

  takeDamage(dmg) {
    this.hp -= dmg;
    this.hitTimer = 15;
    if (this.hp <= 0) { this.dead = true; this.hp = 0; }
    return this.dead;
  }
}

function spawnEnemiesInRoom() {
  // Find current room (where most players are)
  let bestRoom = dungeonRooms[Math.min(1, dungeonRooms.length - 1)];
  const count = 1 + Math.floor(Math.random() * 3); // 1-3 enemies
  
  for (let i = 0; i < count; i++) {
    const type = ENEMY_TYPES[Math.floor(Math.random() * ENEMY_TYPES.length)];
    const ex = bestRoom.x + Math.floor(Math.random() * bestRoom.w);
    const ey = bestRoom.y + Math.floor(Math.random() * bestRoom.h);
    if (dungeonMap[ey]?.[ex] === T.FLOOR) {
      dungeonEnemies.push(new Enemy(type, ex, ey));
    }
  }
}

// ══════════════════════════════════
// SKILLS
// ══════════════════════════════════
const SKILLS = {
  sokrates: [
    { name: 'Socratic Strike', type: 'atk', dmg: 12, manaCost: 5, desc: 'Questions the enemy into submission' },
    { name: 'Paradox Shield', type: 'def', heal: 8, manaCost: 8, desc: 'Logical contradiction blocks damage' },
  ],
  da_vinci: [
    { name: 'Inventive Blast', type: 'atk', dmg: 15, manaCost: 10, desc: 'Throws a prototype explosive' },
    { name: 'Blueprint Heal', type: 'heal', heal: 12, manaCost: 6, desc: 'Designs a quick medical device' },
  ],
  sunzi: [
    { name: 'Art of War', type: 'atk', dmg: 18, manaCost: 8, desc: 'Exploits enemy weakness' },
    { name: 'Tactical Retreat', type: 'def', heal: 5, manaCost: 3, desc: 'Reposition for advantage' },
  ],
  hypatia: [
    { name: 'Arcane Bolt', type: 'atk', dmg: 14, manaCost: 7, desc: 'Pure mathematical energy' },
    { name: 'Scholar\'s Ward', type: 'def', heal: 10, manaCost: 10, desc: 'Knowledge shields the mind' },
  ],
  nietzsche: [
    { name: 'Will to Power', type: 'atk', dmg: 20, manaCost: 12, desc: 'Overwhelming force of will' },
    { name: 'Eternal Return', type: 'heal', heal: 15, manaCost: 15, desc: 'Rise again, stronger' },
  ],
  confucius: [
    { name: 'Righteous Strike', type: 'atk', dmg: 10, manaCost: 5, desc: 'Guided by virtue' },
    { name: 'Harmony Heal', type: 'heal', heal: 18, manaCost: 10, desc: 'Restores order to the body' },
  ],
  curie: [
    { name: 'Radium Blast', type: 'atk', dmg: 16, manaCost: 9, desc: 'Concentrated radiation beam' },
    { name: 'Chemical Cure', type: 'heal', heal: 14, manaCost: 8, desc: 'Scientific healing compound' },
  ],
  rumi: [
    { name: 'Poetry of Pain', type: 'atk', dmg: 11, manaCost: 6, desc: 'Words that wound the soul' },
    { name: 'Mystic Trance', type: 'heal', heal: 20, manaCost: 12, desc: 'Transcendent meditation heals all' },
  ],
  ada: [
    { name: 'Algorithm Strike', type: 'atk', dmg: 13, manaCost: 7, desc: 'Calculated precision attack' },
    { name: 'Debug Shield', type: 'def', heal: 8, manaCost: 5, desc: 'Patches vulnerabilities' },
  ],
  diogenes: [
    { name: 'Barrel Smash', type: 'atk', dmg: 22, manaCost: 4, desc: 'Hits them with a barrel' },
    { name: 'Cynical Laugh', type: 'def', heal: 3, manaCost: 0, desc: 'Laughs off the pain (barely)' },
  ],
  arendt: [
    { name: 'Judgement', type: 'atk', dmg: 14, manaCost: 8, desc: 'Moral verdict deals damage' },
    { name: 'Political Shield', type: 'def', heal: 10, manaCost: 7, desc: 'Institutional protection' },
  ],
  tesla: [
    { name: 'Lightning Bolt', type: 'atk', dmg: 25, manaCost: 15, desc: 'Pure electrical devastation' },
    { name: 'Tesla Coil Heal', type: 'heal', heal: 10, manaCost: 8, desc: 'Electromagnetic regeneration' },
  ],
};

// ══════════════════════════════════
// INVENTORY
// ══════════════════════════════════
const LOOT_TABLE = [
  { name: 'Health Potion', emoji: '🧪', type: 'consumable', effect: 'hp', value: 20 },
  { name: 'Mana Crystal', emoji: '💎', type: 'consumable', effect: 'mana', value: 15 },
  { name: 'Old Sword', emoji: '🗡️', type: 'weapon', effect: 'atk', value: 3 },
  { name: 'Iron Shield', emoji: '🛡️', type: 'armor', effect: 'def', value: 5 },
  { name: 'Scroll of Fire', emoji: '📜', type: 'consumable', effect: 'atk_all', value: 15 },
  { name: 'Ring of Mana', emoji: '💍', type: 'accessory', effect: 'mana_regen', value: 2 },
  { name: 'Gold Coins', emoji: '🪙', type: 'gold', effect: 'gold', value: 10 + Math.floor(Math.random() * 40) },
  { name: 'Mysterious Key', emoji: '🗝️', type: 'key', effect: 'key', value: 1 },
];

let partyInventory = [];
let partyGold = 0;

function addLoot(item) {
  if (item.type === 'gold') {
    partyGold += item.value;
  } else {
    partyInventory.push({...item});
  }
}

function useItem(itemIdx, token) {
  const item = partyInventory[itemIdx];
  if (!item || !token) return false;
  if (item.effect === 'hp') { token.hp = Math.min(token.maxHp, token.hp + item.value); }
  else if (item.effect === 'mana') { token.mana = Math.min(token.maxMana, token.mana + item.value); }
  partyInventory.splice(itemIdx, 1);
  return true;
}

// ══════════════════════════════════
// COMBAT RESOLUTION
// ══════════════════════════════════
function resolveCombat(token, roll, actionText) {
  // Find nearest enemy
  let nearest = null, minDist = Infinity;
  for (const e of dungeonEnemies) {
    if (e.dead) continue;
    const d = Math.abs(e.targetX - token.targetX) + Math.abs(e.targetY - token.targetY);
    if (d < minDist) { minDist = d; nearest = e; }
  }

  if (!nearest || minDist > 5) return null; // no enemy nearby

  // Get skill
  const skills = SKILLS[token.id] || [];
  const isSpell = actionText.match(/spell|magic|cast|bolt|blast|heal|ward|shield/i);
  const skill = isSpell ? skills[1] : skills[0]; // attack or defend

  let dmg = 5 + roll;
  if (skill) {
    if (skill.type === 'atk') {
      dmg = skill.dmg + Math.floor(roll / 3);
      if (token.mana >= skill.manaCost) token.mana -= skill.manaCost;
      else dmg = Math.floor(dmg * 0.5); // half damage without mana
    } else if (skill.type === 'heal' || skill.type === 'def') {
      if (token.mana >= skill.manaCost) {
        token.mana -= skill.manaCost;
        token.hp = Math.min(token.maxHp, token.hp + skill.heal);
      }
      dmg = Math.floor(dmg * 0.3); // still some damage
    }
  }

  // Critical hit
  if (roll === 20) dmg *= 2;
  if (roll === 1) dmg = 0;

  const killed = nearest.takeDamage(dmg);
  
  // Enemy counterattack
  if (!killed) {
    const counterDmg = Math.max(1, nearest.atk - Math.floor(Math.random() * 5));
    token.hp = Math.max(1, token.hp - counterDmg);
  }

  // Loot on kill
  if (killed) {
    const loot = LOOT_TABLE[Math.floor(Math.random() * LOOT_TABLE.length)];
    addLoot(loot);
    // XP = heal all a bit
    for (const t of dungeonTokens) {
      if (!t.isDM) { t.hp = Math.min(t.maxHp, t.hp + 2); t.mana = Math.min(t.maxMana, t.mana + 3); }
    }
    return { dmg, killed: true, enemy: nearest.name, loot, xp: nearest.xp };
  }

  return { dmg, killed: false, enemy: nearest.name, counterDmg: nearest.atk };
}

// Update handleDungeonAction to use combat
const _origHandleDungeonAction = handleDungeonAction;
handleDungeonAction = function(msg) {
  const token = dungeonTokens.find(t => t.id === msg.agent_id);
  if (token) {
    token.say(msg.content);
    if (msg.role === 'action') {
      moveTokenRandomly(token);
      const rollMatch = msg.content.match(/🎲\s*(?:NAT\s*)?(\d+)/);
      if (rollMatch) {
        const roll = parseInt(rollMatch[1]);
        const combat = resolveCombat(token, roll, msg.content);
        // Basic HP/mana from non-combat dice
        if (!combat) {
          if (roll === 1) token.hp = Math.max(1, token.hp - 10);
          if (roll === 20) { token.hp = Math.min(token.maxHp, token.hp + 5); token.mana = Math.min(token.maxMana, token.mana + 10); }
          if (msg.content.match(/spell|magic|cast/i)) token.mana = Math.max(0, token.mana - 8);
        }
      }
    }
  }
  if (msg.role === 'dm') {
    if (msg.content.match(/attack|monster|creature|beast|enemy|skeleton|goblin|demon|spider|wolf|guard|shadow/i)) {
      spawnEnemiesInRoom();
    }
    if (Math.random() < 0.3) {
      const roomIdx = Math.floor((dungeonTokens[0]?.isDM ? 1 : 0) / 3) + 1;
      moveTokensToRoom(roomIdx);
    }
  }
};

// Override the render loop to include enemies
const _origRenderDungeonMap = renderDungeonMap;
renderDungeonMap = function() {
  if (!dungeonCtx || !dungeonMap) return;
  
  dungeonCtx.fillStyle = TILE_COLORS[T.WALL];
  dungeonCtx.fillRect(0, 0, dungeonCanvas.width, dungeonCanvas.height);

  for (let y = 0; y < MAP_H; y++)
    for (let x = 0; x < MAP_W; x++)
      drawTile(x, y, dungeonMap[y][x]);

  // Draw enemies
  dungeonEnemies = dungeonEnemies.filter(e => !e.dead || e.hitTimer > 0);
  for (const e of dungeonEnemies) { e.update(); e.draw(dungeonCtx); }

  // Draw tokens
  for (const token of dungeonTokens) { token.update(); drawToken(token); }
};

// Export for global access
window.initDungeonMap = initDungeonMap;
window.handleDungeonAction = handleDungeonAction;
window.dungeonTokens = () => dungeonTokens;
window.dungeonEnemies = () => dungeonEnemies;
window.partyInventory = () => partyInventory;
window.partyGold = () => partyGold;
window.SKILLS = SKILLS;
