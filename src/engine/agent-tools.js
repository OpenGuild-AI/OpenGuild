// Agent Tools — filesystem, system, data, brain, memory operations
// These tools give agents real capabilities beyond just chatting
import db from '../db/database.js';
import { callKimi } from './kimi.js';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'fs';
import { join, dirname, basename, extname } from 'path';
import { execSync } from 'child_process';

const WORKSPACE = join(process.cwd(), 'src/data');
const SAFE_DIRS = [WORKSPACE, join(process.cwd(), 'src/data/quests'), join(process.cwd(), 'src/data/agent-workspace')];

// Ensure agent workspace exists
mkdirSync(join(WORKSPACE, 'agent-workspace'), { recursive: true });

// ── Security: restrict file operations to safe directories ──
function isSafePath(filepath) {
  const resolved = join(WORKSPACE, filepath);
  return SAFE_DIRS.some(dir => resolved.startsWith(dir)) || resolved.startsWith(WORKSPACE);
}

function resolvePath(filepath) {
  if (filepath.startsWith('/')) {
    // Absolute path — check if it's within workspace
    if (filepath.startsWith(WORKSPACE)) return filepath;
    return null; // blocked
  }
  return join(WORKSPACE, filepath);
}

// ══════════════════════════════════
// FILESYSTEM TOOLS
// ══════════════════════════════════

export function readFile(filepath) {
  const resolved = resolvePath(filepath);
  if (!resolved) return { success: false, error: 'Path outside workspace' };
  if (!existsSync(resolved)) return { success: false, error: 'File not found' };
  try {
    const content = readFileSync(resolved, 'utf8');
    return { success: true, path: resolved, content: content.slice(0, 10000), size: content.length, truncated: content.length > 10000 };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

export function writeFile(filepath, content) {
  const resolved = resolvePath(filepath);
  if (!resolved) return { success: false, error: 'Path outside workspace' };
  try {
    mkdirSync(dirname(resolved), { recursive: true });
    writeFileSync(resolved, content, 'utf8');
    return { success: true, path: resolved, size: content.length };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

export function listDir(dirpath = '.') {
  const resolved = resolvePath(dirpath);
  if (!resolved) return { success: false, error: 'Path outside workspace' };
  if (!existsSync(resolved)) return { success: false, error: 'Directory not found' };
  try {
    const entries = readdirSync(resolved).map(name => {
      const full = join(resolved, name);
      try {
        const stat = statSync(full);
        return {
          name,
          type: stat.isDirectory() ? 'dir' : 'file',
          size: stat.size,
          modified: stat.mtime.toISOString()
        };
      } catch { return { name, type: 'unknown', size: 0 }; }
    });
    return { success: true, path: resolved, entries, count: entries.length };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ══════════════════════════════════
// SYSTEM TOOLS
// ══════════════════════════════════

export function execCommand(command) {
  // Blocklist dangerous commands
  const blocked = ['rm -rf /', 'mkfs', 'dd if=', ':(){', 'fork bomb', '> /dev/sd', 'shutdown', 'reboot', 'systemctl stop', 'kill -9 1'];
  if (blocked.some(b => command.includes(b))) {
    return { success: false, error: 'Command blocked for safety' };
  }
  try {
    const stdout = execSync(command, {
      timeout: 30000,
      maxBuffer: 1024 * 512,
      cwd: WORKSPACE,
      encoding: 'utf8'
    });
    return { success: true, stdout: stdout.slice(0, 5000), truncated: stdout.length > 5000 };
  } catch (e) {
    return { success: false, error: e.message?.slice(0, 1000), stderr: e.stderr?.slice(0, 1000), exitCode: e.status };
  }
}

// ══════════════════════════════════
// DATA TOOLS
// ══════════════════════════════════

export async function fetchRSS(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'OpenGuild/1.0' },
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) return { success: false, error: `HTTP ${res.status}` };
    const xml = await res.text();

    // Simple RSS/Atom parser
    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>|<entry>([\s\S]*?)<\/entry>/gi;
    let match;
    while ((match = itemRegex.exec(xml)) && items.length < 20) {
      const block = match[1] || match[2];
      const title = block.match(/<title[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/)?.[1]?.trim();
      const link = block.match(/<link[^>]*href="([^"]+)"/)?.[1] || block.match(/<link>(.*?)<\/link>/)?.[1]?.trim();
      const desc = block.match(/<description[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/description>/s)?.[1]?.trim() ||
                   block.match(/<summary[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/summary>/s)?.[1]?.trim();
      const pubDate = block.match(/<pubDate>(.*?)<\/pubDate>/)?.[1]?.trim() ||
                      block.match(/<published>(.*?)<\/published>/)?.[1]?.trim();
      if (title) items.push({ title, link: link || '', description: (desc || '').replace(/<[^>]+>/g, '').slice(0, 200), pubDate: pubDate || '' });
    }
    return { success: true, url, items, count: items.length };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

export async function fetchJSON(url, headers = {}) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'OpenGuild/1.0', 'Accept': 'application/json', ...headers },
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) return { success: false, error: `HTTP ${res.status}` };
    const data = await res.json();
    const str = JSON.stringify(data);
    return { success: true, url, data: str.length > 8000 ? JSON.parse(str.slice(0, 8000) + '..."truncated"') : data, truncated: str.length > 8000 };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ══════════════════════════════════
// ANALYSIS TOOLS
// ══════════════════════════════════

export async function analyzeText(text) {
  if (!text || text.length < 10) return { success: false, error: 'Text too short' };

  const wordCount = text.split(/\s+/).length;
  const sentenceCount = text.split(/[.!?]+/).filter(Boolean).length;
  const avgWordsPerSentence = Math.round(wordCount / Math.max(1, sentenceCount));

  const result = await callKimi(
    'Analyze this text. Reply in EXACT format:\nSENTIMENT: positive|negative|neutral|mixed\nKEY_PHRASES: phrase1, phrase2, phrase3\nENTITIES: name (type), name (type)\nTONE: formal|informal|academic|journalistic|conversational',
    text.slice(0, 3000),
    { maxTokens: 150, temperature: 0.2 }
  );

  const analysis = result?.text || '';
  return {
    success: true,
    wordCount,
    sentenceCount,
    avgWordsPerSentence,
    sentiment: analysis.match(/SENTIMENT:\s*(\S+)/i)?.[1] || 'unknown',
    keyPhrases: analysis.match(/KEY_PHRASES:\s*(.+)/i)?.[1]?.split(',').map(s => s.trim()) || [],
    entities: analysis.match(/ENTITIES:\s*(.+)/i)?.[1]?.split(',').map(s => s.trim()) || [],
    tone: analysis.match(/TONE:\s*(\S+)/i)?.[1] || 'unknown'
  };
}

export function diffCompare(textA, textB) {
  const linesA = textA.split('\n');
  const linesB = textB.split('\n');
  const added = [];
  const removed = [];

  // Simple line diff
  const setA = new Set(linesA);
  const setB = new Set(linesB);

  for (const line of linesB) {
    if (!setA.has(line) && line.trim()) added.push(line);
  }
  for (const line of linesA) {
    if (!setB.has(line) && line.trim()) removed.push(line);
  }

  return {
    success: true,
    linesA: linesA.length,
    linesB: linesB.length,
    added: added.slice(0, 50),
    removed: removed.slice(0, 50),
    addedCount: added.length,
    removedCount: removed.length,
    identical: added.length === 0 && removed.length === 0
  };
}

// ══════════════════════════════════
// BRAIN TOOLS
// ══════════════════════════════════

export function queryBrain(query, type = 'search') {
  switch (type) {
    case 'search':
      // Search entities by name
      const entities = db.prepare(
        "SELECT * FROM brain_entities WHERE name LIKE ? ORDER BY mention_count DESC LIMIT 10"
      ).all(`%${query}%`);
      return { success: true, type: 'entity_search', query, results: entities, count: entities.length };

    case 'connections':
      // Find connections for an entity
      const entity = db.prepare('SELECT * FROM brain_entities WHERE name = ?').get(query);
      if (!entity) return { success: false, error: 'Entity not found' };
      const connections = db.prepare(`
        SELECT bc.relation, bc.strength,
          CASE WHEN bc.entity_a = ? THEN eb.name ELSE ea.name END as connected_to,
          CASE WHEN bc.entity_a = ? THEN eb.type ELSE ea.type END as connected_type
        FROM brain_connections bc
        JOIN brain_entities ea ON bc.entity_a = ea.id
        JOIN brain_entities eb ON bc.entity_b = eb.id
        WHERE bc.entity_a = ? OR bc.entity_b = ?
        ORDER BY bc.strength DESC LIMIT 20
      `).all(entity.id, entity.id, entity.id, entity.id);
      return { success: true, type: 'connections', entity: entity.name, connections, count: connections.length };

    case 'topics':
      // Hot topics
      const topics = db.prepare('SELECT * FROM brain_topics ORDER BY heat DESC LIMIT 15').all();
      return { success: true, type: 'topics', results: topics, count: topics.length };

    case 'stats':
      const ent = db.prepare('SELECT COUNT(*) as c FROM brain_entities').get().c;
      const conn = db.prepare('SELECT COUNT(*) as c FROM brain_connections').get().c;
      const top = db.prepare('SELECT COUNT(*) as c FROM brain_topics').get().c;
      const art = db.prepare('SELECT COUNT(*) as c FROM brain_artifacts').get().c;
      return { success: true, type: 'stats', entities: ent, connections: conn, topics: top, artifacts: art };

    default:
      return { success: false, error: 'Unknown query type. Use: search, connections, topics, stats' };
  }
}

// ══════════════════════════════════
// MEMORY TOOLS
// ══════════════════════════════════

export function memoryStore(agentId, key, value) {
  if (!key || !value) return { success: false, error: 'Key and value required' };
  db.prepare(`
    INSERT INTO agent_memory (agent_id, key, value, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(agent_id, key) DO UPDATE SET value = ?, updated_at = datetime('now')
  `).run(agentId, key, value, value);
  return { success: true, agent_id: agentId, key, stored: true };
}

export function memoryRecall(agentId, key = null) {
  if (key) {
    const row = db.prepare('SELECT * FROM agent_memory WHERE agent_id = ? AND key = ?').get(agentId, key);
    return row ? { success: true, key: row.key, value: row.value, updated_at: row.updated_at } : { success: false, error: 'Key not found' };
  }
  // Return all memories for this agent
  const rows = db.prepare('SELECT key, value, updated_at FROM agent_memory WHERE agent_id = ? ORDER BY updated_at DESC LIMIT 20').all(agentId);
  return { success: true, agent_id: agentId, memories: rows, count: rows.length };
}
