// Dungeon Engine — D&D-style roleplay between agents
// One agent is the DM (Dungeon Master), others are players
import db from '../db/database.js';
import { callKimi } from './kimi.js';
import { archetypes } from '../agents/archetypes.js';
import { broadcast } from './discussion.js';

// DM rotates — but defaults to Hypatia (scholar, good storyteller)
const DM_ROTATION = ['hypatia', 'da_vinci', 'rumi', 'arendt'];
const PARTY_SIZE = 4; // 4 players + 1 DM per session

// Character class mapping based on archetype personality
const CHARACTER_CLASSES = {
  sokrates: { class: 'Philosopher-Monk', race: 'Human', trait: 'asks devastating questions mid-combat' },
  da_vinci: { class: 'Artificer', race: 'Gnome', trait: 'sketches inventions during downtime' },
  sunzi: { class: 'War Strategist (Fighter)', race: 'Human', trait: 'always has a contingency plan' },
  hypatia: { class: 'Arcane Scholar (Wizard)', race: 'Elf', trait: 'corrects historical inaccuracies in the narrative' },
  nietzsche: { class: 'Warlock of the Abyss', race: 'Tiefling', trait: 'monologues about power before attacking' },
  confucius: { class: 'Cleric of Order', race: 'Human', trait: 'insists on proper ritual before every action' },
  curie: { class: 'Alchemist (Artificer)', race: 'Human', trait: 'experiments with everything she finds' },
  rumi: { class: 'Mystic Bard', race: 'Half-Elf', trait: 'speaks in poetry even in battle' },
  ada: { class: 'Rune Knight', race: 'Dwarf', trait: 'finds patterns in dungeon layouts' },
  diogenes: { class: 'Barbarian Vagrant', race: 'Half-Orc', trait: 'insults authority figures, sleeps in barrels' },
  arendt: { class: 'Inquisitor (Paladin)', race: 'Human', trait: 'interrogates NPCs about their moral choices' },
  tesla: { class: 'Storm Sorcerer', race: 'Air Genasi', trait: 'obsessed with lightning-based solutions' },
};

// Scenario templates
const SCENARIOS = [
  'A mysterious plague spreads through a port city. The Guild of Healers has vanished. Dark rituals are rumored beneath the harbor.',
  'An ancient library has been unearthed beneath the desert. Its guardian constructs still roam the halls. The knowledge within could change the world.',
  'A dragon has claimed a mountain fortress as its lair. But this dragon wants to negotiate, not fight. What does it truly want?',
  'The barrier between worlds is thinning. Strange creatures appear at crossroads. A wandering oracle says only "the door was opened from our side."',
  'A merchant prince offers 10,000 gold to retrieve a painting from a rival\'s vault. Simple heist. But the painting whispers to those who look at it.',
  'A village celebrates a harvest festival, but no one can remember what happened last year\'s festival. Or the year before. Something feeds on their memories.',
  'War machines from a fallen empire have activated on their own. They march toward the capital. Inside one, someone left a message: "I\'m sorry."',
  'The party wakes up in an unfamiliar tavern. None of them remember how they got here. The barkeep says they arrived three days ago — and paid in advance.',
];

function getRecentMessages(limit = 15) {
  return db.prepare('SELECT * FROM dungeon_messages ORDER BY id DESC LIMIT ?').all(limit).reverse();
}

function postDungeonMsg(agentId, content, role = 'player') {
  const info = db.prepare(
    'INSERT INTO dungeon_messages (agent_id, content, role) VALUES (?, ?, ?)'
  ).run(agentId, content, role);
  
  const arch = archetypes.find(a => a.id === agentId);
  const msg = {
    id: info.lastInsertRowid,
    agent_id: agentId,
    agent_name: arch?.name || agentId,
    agent_avatar: arch?.avatar || '🎲',
    agent_color: arch?.color || '#888',
    content,
    role,
    created_at: new Date().toISOString()
  };
  broadcast('dungeon-chat', msg);
  return msg;
}

function getOrCreateState() {
  let state = db.prepare('SELECT * FROM dungeon_state WHERE id = 1').get();
  if (!state) {
    // Pick random DM and players
    const dm = DM_ROTATION[Math.floor(Math.random() * DM_ROTATION.length)];
    const available = archetypes.filter(a => a.id !== dm).map(a => a.id);
    const shuffled = available.sort(() => Math.random() - 0.5);
    const players = shuffled.slice(0, PARTY_SIZE);
    const scenario = SCENARIOS[Math.floor(Math.random() * SCENARIOS.length)];
    
    db.prepare(
      'INSERT INTO dungeon_state (id, scenario, turn, active_players, dm_id) VALUES (1, ?, 0, ?, ?)'
    ).run(scenario, JSON.stringify(players), dm);
    
    state = db.prepare('SELECT * FROM dungeon_state WHERE id = 1').get();
  }
  return state;
}

// Start a new dungeon session
export async function startNewSession() {
  // Clear old messages (keep last 50 as history)
  db.prepare('DELETE FROM dungeon_messages WHERE id NOT IN (SELECT id FROM dungeon_messages ORDER BY id DESC LIMIT 50)').run();
  
  // Reset state
  db.prepare('DELETE FROM dungeon_state').run();
  const state = getOrCreateState();
  const dm = archetypes.find(a => a.id === state.dm_id);
  const players = JSON.parse(state.active_players);
  const party = players.map(id => {
    const arch = archetypes.find(a => a.id === id);
    const char = CHARACTER_CLASSES[id] || { class: 'Adventurer', race: 'Human', trait: 'mysterious' };
    return `${arch?.name || id} — ${char.race} ${char.class} (${char.trait})`;
  });

  // DM introduces the scenario
  const intro = await callKimi(
    `D&D DM. You are ${dm.name}. Set the scene in 2-3 sentences. End with a threat or choice. Vivid, concise.`,
    `Scenario: ${state.scenario}\nParty: ${party.join(', ')}`,
    { maxTokens: 80, temperature: 0.9 }
  );

  if (intro?.text) {
    postDungeonMsg(state.dm_id, intro.text, 'dm');
    db.prepare('UPDATE dungeon_state SET turn = 1, updated_at = CURRENT_TIMESTAMP WHERE id = 1').run();
  }

  return state;
}

// One turn of the dungeon — a player responds, then DM narrates
export async function dungeonTick() {
  const state = getOrCreateState();
  if (!state.scenario) return;

  const players = JSON.parse(state.active_players || '[]');
  if (!players.length) return;

  const recentMsgs = getRecentMessages(10);
  const conversation = recentMsgs.slice(-6).map(m => {
    const name = archetypes.find(a => a.id === m.agent_id)?.name || m.agent_id;
    return `${name}: ${m.content}`;
  }).join('\n');

  const dmArch = archetypes.find(a => a.id === state.dm_id);

  // ── Phase 1: Quick party banter — 1 word to 1 sentence each ──
  for (const playerId of players) {
    const arch = archetypes.find(a => a.id === playerId);
    const ch = CHARACTER_CLASSES[playerId] || {};

    const discuss = await callKimi(
      `D&D. You are ${arch.name} (${ch.class}). Talk to the party about what to do. Max 10 words. Stay in character.`,
      conversation,
      { maxTokens: 25, temperature: 1.0 }
    );
    if (discuss?.text) postDungeonMsg(playerId, discuss.text, 'discuss');
    await sleep(100);
  }

  // ── Phase 2: Actions — 1 sentence + dice ──
  for (const playerId of players) {
    const arch = archetypes.find(a => a.id === playerId);
    const ch = CHARACTER_CLASSES[playerId] || {};
    const roll = Math.floor(Math.random() * 20) + 1;
    const rollStr = roll === 20 ? '🎲 NAT 20!' : roll === 1 ? '🎲 NAT 1...' : `🎲 ${roll}`;

    const action = await callKimi(
      `D&D. ${arch.name} (${ch.class}). Roll: ${roll}/20. What do you do? Attack, cast spell, search, sneak, or talk? 1 sentence, in-character.`,
      conversation,
      { maxTokens: 30, temperature: 0.9 }
    );
    if (action?.text) postDungeonMsg(playerId, `${rollStr} — ${action.text}`, 'action');
    await sleep(100);
  }

  // ── Phase 3: DM — 2-3 sentences, must include combat or exploration ──
  const fullConv = getRecentMessages(12).map(m => {
    const name = archetypes.find(a => a.id === m.agent_id)?.name || m.agent_id;
    return `${name}[${m.role}]: ${m.content}`;
  }).join('\n');

  const dmResponse = await callKimi(
    `D&D DM. You are ${dmArch.name}. Narrate consequences. Include: combat results, movement, discoveries, or enemy encounters. Every 2-3 rounds introduce a new monster or trap. 2-3 sentences. Dramatic.`,
    `Scenario: ${state.scenario}\nTurn: ${state.turn}\n${fullConv}`,
    { maxTokens: 100, temperature: 0.85 }
  );
  if (dmResponse?.text) postDungeonMsg(state.dm_id, dmResponse.text, 'dm');

  // Advance turn
  db.prepare('UPDATE dungeon_state SET turn = turn + 1, updated_at = CURRENT_TIMESTAMP WHERE id = 1').run();

  return { turn: state.turn + 1 };
}

// Get dungeon messages for API
export function getDungeonMessages(limit = 50) {
  const rows = db.prepare('SELECT * FROM dungeon_messages ORDER BY id DESC LIMIT ?').all(limit).reverse();
  return rows.map(m => {
    const arch = archetypes.find(a => a.id === m.agent_id);
    return {
      ...m,
      agent_name: arch?.name || m.agent_id,
      agent_avatar: arch?.avatar || '🎲',
      agent_color: arch?.color || '#888'
    };
  });
}

// Get current dungeon state
export function getDungeonState() {
  const state = getOrCreateState();
  const players = JSON.parse(state.active_players || '[]');
  return {
    ...state,
    players: players.map(id => {
      const arch = archetypes.find(a => a.id === id);
      const char = CHARACTER_CLASSES[id] || {};
      return { id, name: arch?.name, avatar: arch?.avatar, color: arch?.color, ...char };
    }),
    dm: (() => {
      const arch = archetypes.find(a => a.id === state.dm_id);
      return { id: state.dm_id, name: arch?.name, avatar: arch?.avatar, color: arch?.color };
    })()
  };
}
