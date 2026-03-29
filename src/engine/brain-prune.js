// Brain Pruning Engine — constant memory watcher
// Runs as a background loop, continuously monitoring and cleaning the brain
import db from '../db/database.js';
import { callKimi } from './kimi.js';

let watcherRunning = false;
let watcherInterval = null;

// ══════════════════════════════════
// QUICK PRUNE — runs every 60s, lightweight
// ══════════════════════════════════
function quickPrune() {
  let cleaned = 0;

  // 1. Dangling connections (entity deleted but connection remains)
  cleaned += db.prepare(`
    DELETE FROM brain_connections 
    WHERE entity_a NOT IN (SELECT id FROM brain_entities) 
       OR entity_b NOT IN (SELECT id FROM brain_entities)
  `).run().changes;

  // 2. Self-referencing connections
  cleaned += db.prepare('DELETE FROM brain_connections WHERE entity_a = entity_b').run().changes;

  // 3. Orphan entities (no connections, 1 mention, not verified)
  db.prepare(`
    DELETE FROM brain_news_entities 
    WHERE entity_id IN (
      SELECT id FROM brain_entities 
      WHERE mention_count <= 1 
        AND (verified IS NULL OR verified != 1)
        AND id NOT IN (SELECT entity_a FROM brain_connections UNION SELECT entity_b FROM brain_connections)
    )
  `).run();
  cleaned += db.prepare(`
    DELETE FROM brain_entities 
    WHERE mention_count <= 1 
      AND (verified IS NULL OR verified != 1)
      AND id NOT IN (SELECT entity_a FROM brain_connections UNION SELECT entity_b FROM brain_connections)
  `).run().changes;

  // 4. Duplicate connections (same A→B→relation, keep strongest)
  const dupes = db.prepare(`
    SELECT entity_a, entity_b, relation, COUNT(*) as cnt, 
           MAX(strength) as max_str, MAX(verified) as any_ver,
           GROUP_CONCAT(id) as ids
    FROM brain_connections 
    GROUP BY entity_a, entity_b, relation 
    HAVING cnt > 1
  `).all();
  for (const d of dupes) {
    const ids = d.ids.split(',').map(Number);
    const keepId = ids[0];
    db.prepare('UPDATE brain_connections SET strength = ?, verified = ? WHERE id = ?')
      .run(d.max_str, d.any_ver || 0, keepId);
    for (const rid of ids.slice(1)) {
      db.prepare('DELETE FROM brain_connections WHERE id = ?').run(rid);
      cleaned++;
    }
  }

  if (cleaned > 0) console.log(`[Brain Watcher] Quick prune: ${cleaned} items cleaned`);
  return cleaned;
}

// ══════════════════════════════════
// DECAY CYCLE — runs every 5min, gradual
// ══════════════════════════════════
function decayCycle() {
  // Unverified connections lose strength
  const decayed = db.prepare(`
    UPDATE brain_connections 
    SET strength = strength - 0.05
    WHERE (verified IS NULL OR verified = 0) AND strength > 0
  `).run().changes;

  // Kill connections that hit zero
  const killed = db.prepare('DELETE FROM brain_connections WHERE strength <= 0').run().changes;

  // Entities dead from zero connections + low mentions
  db.prepare(`
    DELETE FROM brain_news_entities 
    WHERE entity_id IN (
      SELECT id FROM brain_entities 
      WHERE mention_count <= 0
        AND (verified IS NULL OR verified = 0)
        AND id NOT IN (SELECT entity_a FROM brain_connections UNION SELECT entity_b FROM brain_connections)
    )
  `).run();
  const entitiesKilled = db.prepare(`
    DELETE FROM brain_entities 
    WHERE mention_count <= 0
      AND (verified IS NULL OR verified = 0)
      AND id NOT IN (SELECT entity_a FROM brain_connections UNION SELECT entity_b FROM brain_connections)
  `).run().changes;

  if (decayed + killed + entitiesKilled > 0) {
    console.log(`[Brain Watcher] Decay: ${decayed} connections weakened, ${killed} connections died, ${entitiesKilled} entities pruned`);
  }
}

// ══════════════════════════════════
// DEEP PRUNE — runs every 30min, AI-powered
// ══════════════════════════════════
async function deepPrune() {
  const entities = db.prepare(`
    SELECT id, name, type, mention_count, verified 
    FROM brain_entities 
    ORDER BY mention_count DESC LIMIT 200
  `).all();

  if (entities.length < 10) return;

  const entityList = entities.map(e => `${e.id}|${e.name}|${e.type}|${e.mention_count}`).join('\n');

  let result;
  try {
    result = await callKimi(
      `Find duplicate entities that refer to the SAME thing. Also find LOW-VALUE entities that are too generic or meaningless for a knowledge graph (e.g. "report", "analysis", "statement", "official", "source").

Format:
MERGE: <keep_id> | <remove_id>
DELETE: <id> | <reason>

If nothing to do: NONE`,
      entityList,
      { maxTokens: 500, temperature: 0.1 }
    );
  } catch (e) { return; }

  if (!result?.text || result.text.includes('NONE')) return;

  let actions = 0;
  for (const line of result.text.split('\n')) {
    const mergeMatch = line.match(/MERGE:\s*(\d+)\s*\|\s*(\d+)/);
    if (mergeMatch) {
      const keepId = parseInt(mergeMatch[1]);
      const removeId = parseInt(mergeMatch[2]);
      const keep = db.prepare('SELECT * FROM brain_entities WHERE id = ?').get(keepId);
      const remove = db.prepare('SELECT * FROM brain_entities WHERE id = ?').get(removeId);
      if (!keep || !remove || keepId === removeId) continue;

      db.prepare('UPDATE brain_connections SET entity_a = ? WHERE entity_a = ?').run(keepId, removeId);
      db.prepare('UPDATE brain_connections SET entity_b = ? WHERE entity_b = ?').run(keepId, removeId);
      db.prepare('DELETE FROM brain_connections WHERE entity_a = entity_b').run();
      db.prepare('UPDATE brain_entities SET mention_count = mention_count + ? WHERE id = ?').run(remove.mention_count, keepId);
      if (remove.verified) db.prepare('UPDATE brain_entities SET verified = 1 WHERE id = ?').run(keepId);
      db.prepare('UPDATE OR IGNORE brain_news_entities SET entity_id = ? WHERE entity_id = ?').run(keepId, removeId);
      db.prepare('DELETE FROM brain_news_entities WHERE entity_id = ?').run(removeId);
      db.prepare('DELETE FROM brain_entities WHERE id = ?').run(removeId);
      console.log(`[Brain Watcher] Merged "${remove.name}" → "${keep.name}"`);
      actions++;
    }

    const deleteMatch = line.match(/DELETE:\s*(\d+)\s*\|\s*(.+)/);
    if (deleteMatch) {
      const id = parseInt(deleteMatch[1]);
      const entity = db.prepare('SELECT * FROM brain_entities WHERE id = ?').get(id);
      if (!entity || entity.verified) continue;
      db.prepare('DELETE FROM brain_connections WHERE entity_a = ? OR entity_b = ?').run(id, id);
      db.prepare('DELETE FROM brain_news_entities WHERE entity_id = ?').run(id);
      db.prepare('DELETE FROM brain_entities WHERE id = ?').run(id);
      console.log(`[Brain Watcher] Deleted "${entity.name}" (${deleteMatch[2].trim()})`);
      actions++;
    }
  }

  if (actions > 0) console.log(`[Brain Watcher] Deep prune: ${actions} actions`);
}

// ══════════════════════════════════
// WATCHER LOOP — constant background process
// ══════════════════════════════════
let tickCount = 0;

export function startBrainWatcher() {
  if (watcherRunning) return;
  watcherRunning = true;

  console.log('[Brain Watcher] Starting constant memory watcher...');

  watcherInterval = setInterval(async () => {
    tickCount++;

    // Every 60s: quick prune
    quickPrune();

    // Every 5min (5 ticks): decay cycle
    if (tickCount % 5 === 0) {
      decayCycle();
    }

    // Every 30min (30 ticks): deep AI prune
    if (tickCount % 30 === 0) {
      try { await deepPrune(); } catch (e) { console.error('[Brain Watcher]', e.message); }
    }
  }, 60000); // tick every 60s

  // Initial quick prune on start
  setTimeout(() => quickPrune(), 15000);

  return watcherInterval;
}

export function stopBrainWatcher() {
  if (watcherInterval) clearInterval(watcherInterval);
  watcherRunning = false;
  console.log('[Brain Watcher] Stopped');
}

// Manual trigger
export async function pruneBrain() {
  const before = {
    entities: db.prepare('SELECT COUNT(*) as c FROM brain_entities').get().c,
    connections: db.prepare('SELECT COUNT(*) as c FROM brain_connections').get().c,
  };

  quickPrune();
  decayCycle();
  await deepPrune();
  quickPrune(); // final cleanup after merges

  const after = {
    entities: db.prepare('SELECT COUNT(*) as c FROM brain_entities').get().c,
    connections: db.prepare('SELECT COUNT(*) as c FROM brain_connections').get().c,
  };

  return { before, after, netChange: { entities: after.entities - before.entities, connections: after.connections - before.connections } };
}
