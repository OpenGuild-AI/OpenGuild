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
  [T.FLOOR]: '#2a2520', [T.WALL]: '#1a1815', [T.DOOR]: '#8B6914',
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

  // Grid lines (subtle)
  if (type !== T.WALL) {
    dungeonCtx.strokeStyle = 'rgba(255,255,255,0.03)';
    dungeonCtx.strokeRect(px, py, TILE, TILE);
  }

  // Wall texture
  if (type === T.WALL) {
    dungeonCtx.fillStyle = 'rgba(255,255,255,0.02)';
    dungeonCtx.fillRect(px + 2, py + 2, TILE - 4, TILE - 4);
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
  dungeonCtx.fillStyle = '#0a0908';
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
  }
}

// Export for global access
window.initDungeonMap = initDungeonMap;
window.handleDungeonAction = handleDungeonAction;
window.dungeonTokens = () => dungeonTokens;
