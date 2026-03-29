import db from '../db/database.js';
import { archetypes } from '../agents/archetypes.js';

// Status cycle: resting → guild → active (world) → resting
const STATUSES = ['resting', 'guild', 'active'];
const BASE_DURATION = 60 * 60 * 1000; // 1h
const RANDOM_RANGE = 10 * 60 * 1000;  // ±10min

function randomDuration() {
  return BASE_DURATION + (Math.random() * 2 - 1) * RANDOM_RANGE;
}

// Initialize agent states in DB
export function initAgentStates() {
  // Add status_changed_at column if missing
  try {
    db.prepare(`ALTER TABLE agent_states ADD COLUMN status_changed_at TEXT`).run();
  } catch (e) { /* already exists */ }

  const upsert = db.prepare(`
    INSERT INTO agent_states (agent_id, energy, status, status_changed_at)
    VALUES (?, 100, 'active', datetime('now'))
    ON CONFLICT(agent_id) DO NOTHING
  `);
  for (const a of archetypes) {
    upsert.run(a.id);
  }

  // Stagger agents so they don't all start in the same status
  staggerAgents();
}

function staggerAgents() {
  const agents = getAllStates();
  const needsStagger = agents.every(a => a.status === agents[0].status);
  if (!needsStagger) return;

  const setStatus = db.prepare(`
    UPDATE agent_states SET status = ?, status_detail = ?, status_changed_at = ? WHERE agent_id = ?
  `);

  agents.forEach((agent, i) => {
    // Distribute agents across statuses
    const statusIdx = i % 3;
    const status = STATUSES[statusIdx];
    // Random offset so they don't all transition at once
    const offsetMs = Math.floor(Math.random() * BASE_DURATION);
    const changedAt = new Date(Date.now() - offsetMs).toISOString();
    setStatus.run(status, null, changedAt, agent.agent_id);
  });
}

// Get all agent states
export function getAllStates() {
  return db.prepare('SELECT * FROM agent_states').all();
}

// Get single agent state
export function getState(agentId) {
  return db.prepare('SELECT * FROM agent_states WHERE agent_id = ?').get(agentId);
}

// Simple time-based transitions — called periodically
export function tickEnergy() {
  transitionAgents();
}

function transitionAgents() {
  const agents = getAllStates();
  const setStatus = db.prepare(`
    UPDATE agent_states SET status = ?, status_detail = ?, status_changed_at = datetime('now') WHERE agent_id = ?
  `);

  const guildCount = agents.filter(a => a.status === 'guild').length;

  for (const agent of agents) {
    const changedAt = agent.status_changed_at
      ? new Date(agent.status_changed_at + 'Z').getTime()
      : Date.now() - BASE_DURATION;
    const elapsed = Date.now() - changedAt;
    const duration = randomDuration();

    if (elapsed < duration) continue; // not time yet

    // Cycle to next status
    if (agent.status === 'resting') {
      // → guild (max 3 in guild at once, otherwise wait)
      if (guildCount < 3) {
        setStatus.run('guild', null, agent.agent_id);
      }
    } else if (agent.status === 'guild') {
      // → active (world)
      setStatus.run('active', null, agent.agent_id);
    } else if (agent.status === 'active') {
      // → resting
      setStatus.run('resting', null, agent.agent_id);
    } else if (agent.status === 'researching') {
      // stuck → guild
      setStatus.run('guild', null, agent.agent_id);
    } else if (agent.status === 'returning') {
      // → guild
      setStatus.run('guild', null, agent.agent_id);
    }
  }
}

// Track message count (keep last_spoke_at updated)
export function spendEnergy(agentId, contentLength = 100, multiplier = 1.0) {
  db.prepare(`
    UPDATE agent_states 
    SET last_spoke_at = datetime('now'),
        messages_sent = messages_sent + 1
    WHERE agent_id = ?
  `).run(agentId);
}

// Get how far through current status (0-1) for frontend progress bar
export function getStatusProgress(agent) {
  const changedAt = agent.status_changed_at
    ? new Date(agent.status_changed_at + 'Z').getTime()
    : Date.now();
  const elapsed = Date.now() - changedAt;
  return Math.min(1, elapsed / BASE_DURATION);
}

// Set agent to researching
export function setResearching(agentId, topic) {
  db.prepare(`
    UPDATE agent_states SET status = 'researching', status_detail = ?, status_changed_at = datetime('now') WHERE agent_id = ?
  `).run(`Researching: ${topic}`, agentId);
}

// Set agent back to active
export function setActive(agentId) {
  db.prepare(`
    UPDATE agent_states SET status = 'active', status_detail = NULL, status_changed_at = datetime('now') WHERE agent_id = ?
  `).run(agentId);
}

// Get agents that can speak in world chat
export function getActiveAgents() {
  return db.prepare(`
    SELECT * FROM agent_states WHERE status = 'active'
  `).all();
}

// Get guild agents
export function getGuildAgents() {
  return db.prepare(`
    SELECT * FROM agent_states WHERE status = 'guild'
  `).all();
}

// Get returning agents
export function getReturningAgents() {
  return db.prepare(`
    SELECT * FROM agent_states WHERE status = 'returning'
  `).all();
}

// Get all states enriched with progress for API
export function getAllAgentStates() {
  const agents = getAllStates();
  return agents.map(a => {
    const arch = archetypes.find(ar => ar.id === a.agent_id);
    return {
      ...a,
      progress: getStatusProgress(a),
      energy: Math.round((1 - getStatusProgress(a)) * 100), // fake energy for frontend compat
      max_energy: 100
    };
  });
}
