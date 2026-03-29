// Brain Pruning Engine — autonomous self-curation of the knowledge graph
// The brain cleans itself: removes noise, merges duplicates, decays irrelevance
import db from '../db/database.js';
import { callKimi } from './kimi.js';
import { broadcast } from './discussion.js';

// ══════════════════════════════════
// 1. ORPHAN CLEANUP
// ══════════════════════════════════
// Entities with zero connections AND low mentions → useless noise
function pruneOrphans() {
  // First clean news_entity refs for orphans about to die
  db.prepare(`
    DELETE FROM brain_news_entities 
    WHERE entity_id IN (
      SELECT id FROM brain_entities 
      WHERE mention_count <= 1 
        AND (verified IS NULL OR verified != 1)
        AND id NOT IN (SELECT entity_a FROM brain_connections UNION SELECT entity_b FROM brain_connections)
    )
  `).run();

  const orphans = db.prepare(`
    DELETE FROM brain_entities 
    WHERE mention_count <= 1 
      AND (verified IS NULL OR verified != 1)
      AND id NOT IN (SELECT entity_a FROM brain_connections UNION SELECT entity_b FROM brain_connections)
  `).run();
  if (orphans.changes > 0) console.log(`[Brain Prune] Removed ${orphans.changes} orphan entities`);
  return orphans.changes;
}

// ══════════════════════════════════
// 2. WEAK CONNECTION DECAY
// ══════════════════════════════════
// Unverified connections lose strength over time → eventually pruned
function decayWeakConnections() {
  // Decay: reduce strength of unverified connections by 0.1
  const decayed = db.prepare(`
    UPDATE brain_connections 
    SET strength = strength - 0.1
    WHERE (verified IS NULL OR verified = 0)
      AND strength > 0
  `).run();
  
  // Remove connections that decayed to zero or below
  const pruned = db.prepare(`
    DELETE FROM brain_connections WHERE strength <= 0
  `).run();

  if (decayed.changes > 0) console.log(`[Brain Prune] Decayed ${decayed.changes} unverified connections`);
  if (pruned.changes > 0) console.log(`[Brain Prune] Pruned ${pruned.changes} dead connections`);
  return { decayed: decayed.changes, pruned: pruned.changes };
}

// ══════════════════════════════════
// 3. DUPLICATE ENTITY MERGE
// ══════════════════════════════════
// AI-powered: find entities that are clearly the same thing
async function mergeDuplicates() {
  // Get entities grouped by similar names
  const entities = db.prepare(`
    SELECT id, name, type, mention_count, verified 
    FROM brain_entities 
    ORDER BY mention_count DESC 
    LIMIT 200
  `).all();

  if (entities.length < 10) return 0;

  // Ask AI to find duplicates
  const entityList = entities.map(e => `${e.id}|${e.name}|${e.type}|${e.mention_count}`).join('\n');
  
  const result = await callKimi(
    `Find duplicate entities in this knowledge graph that refer to the same thing.
Common duplicates: "USA"/"U.S."/"United States", "UK"/"United Kingdom"/"Britain", etc.

Rules:
- Only merge if they're CLEARLY the same entity (not similar, SAME)
- Keep the version with more mentions as the primary
- Output ONLY merge pairs, one per line

Format (strict, one per line):
MERGE: <keep_id> | <remove_id>

If no duplicates found, output: NONE`,
    entityList,
    { maxTokens: 500, temperature: 0.1 }
  );

  if (!result?.text || result.text.includes('NONE')) return 0;

  let merged = 0;
  const lines = result.text.split('\n');

  for (const line of lines) {
    const match = line.match(/MERGE:\s*(\d+)\s*\|\s*(\d+)/);
    if (!match) continue;

    const keepId = parseInt(match[1]);
    const removeId = parseInt(match[2]);

    // Verify both exist
    const keep = db.prepare('SELECT * FROM brain_entities WHERE id = ?').get(keepId);
    const remove = db.prepare('SELECT * FROM brain_entities WHERE id = ?').get(removeId);
    if (!keep || !remove || keepId === removeId) continue;

    // Transfer connections from remove → keep
    db.prepare('UPDATE brain_connections SET entity_a = ? WHERE entity_a = ?').run(keepId, removeId);
    db.prepare('UPDATE brain_connections SET entity_b = ? WHERE entity_b = ?').run(keepId, removeId);

    // Remove self-connections that may have formed
    db.prepare('DELETE FROM brain_connections WHERE entity_a = entity_b').run();

    // Merge mention counts
    db.prepare('UPDATE brain_entities SET mention_count = mention_count + ? WHERE id = ?')
      .run(remove.mention_count, keepId);

    // If remove was verified, keep is now verified too
    if (remove.verified) {
      db.prepare('UPDATE brain_entities SET verified = 1 WHERE id = ?').run(keepId);
    }

    // Transfer news entity references
    db.prepare('UPDATE OR IGNORE brain_news_entities SET entity_id = ? WHERE entity_id = ?').run(keepId, removeId);
    db.prepare('DELETE FROM brain_news_entities WHERE entity_id = ?').run(removeId);

    // Delete the duplicate
    db.prepare('DELETE FROM brain_entities WHERE id = ?').run(removeId);

    console.log(`[Brain Prune] Merged "${remove.name}" → "${keep.name}"`);
    merged++;
  }

  return merged;
}

// ══════════════════════════════════
// 4. STALE ENTITY DECAY
// ══════════════════════════════════
// Entities not seen in a long time lose relevance
function decayStaleEntities() {
  // Reduce mention_count by 1 for entities not seen in 7+ days (and not verified)
  const decayed = db.prepare(`
    UPDATE brain_entities 
    SET mention_count = mention_count - 1
    WHERE mention_count > 1
      AND (verified IS NULL OR verified = 0)
      AND last_seen < datetime('now', '-7 days')
  `).run();

  // Remove entities that decayed to 0 mentions and have no connections
  db.prepare(`
    DELETE FROM brain_news_entities 
    WHERE entity_id IN (
      SELECT id FROM brain_entities 
      WHERE mention_count <= 0
        AND (verified IS NULL OR verified = 0)
        AND id NOT IN (SELECT entity_a FROM brain_connections UNION SELECT entity_b FROM brain_connections)
    )
  `).run();

  const pruned = db.prepare(`
    DELETE FROM brain_entities 
    WHERE mention_count <= 0
      AND (verified IS NULL OR verified = 0)
      AND id NOT IN (SELECT entity_a FROM brain_connections UNION SELECT entity_b FROM brain_connections)
  `).run();

  if (decayed.changes > 0) console.log(`[Brain Prune] Decayed ${decayed.changes} stale entities`);
  if (pruned.changes > 0) console.log(`[Brain Prune] Pruned ${pruned.changes} irrelevant entities`);
  return { decayed: decayed.changes, pruned: pruned.changes };
}

// ══════════════════════════════════
// 5. DUPLICATE CONNECTION CLEANUP
// ══════════════════════════════════
// Multiple connections between same entities with same relation → merge
function mergeDuplicateConnections() {
  const dupes = db.prepare(`
    SELECT entity_a, entity_b, relation, COUNT(*) as cnt, 
           MAX(strength) as max_strength, MAX(verified) as any_verified,
           GROUP_CONCAT(id) as ids
    FROM brain_connections 
    GROUP BY entity_a, entity_b, relation 
    HAVING cnt > 1
  `).all();

  let merged = 0;
  for (const d of dupes) {
    const ids = d.ids.split(',').map(Number);
    const keepId = ids[0];
    const removeIds = ids.slice(1);

    // Keep strongest, set verified if any was verified
    db.prepare('UPDATE brain_connections SET strength = ?, verified = ? WHERE id = ?')
      .run(d.max_strength, d.any_verified || 0, keepId);

    for (const rid of removeIds) {
      db.prepare('DELETE FROM brain_connections WHERE id = ?').run(rid);
      merged++;
    }
  }

  if (merged > 0) console.log(`[Brain Prune] Merged ${merged} duplicate connections`);
  return merged;
}

// ══════════════════════════════════
// 6. CLEAN DANGLING REFERENCES
// ══════════════════════════════════
function cleanDanglingRefs() {
  const cleaned = db.prepare(`
    DELETE FROM brain_connections 
    WHERE entity_a NOT IN (SELECT id FROM brain_entities) 
       OR entity_b NOT IN (SELECT id FROM brain_entities)
  `).run();
  if (cleaned.changes > 0) console.log(`[Brain Prune] Cleaned ${cleaned.changes} dangling connections`);
  return cleaned.changes;
}

// ══════════════════════════════════
// MAIN: Run full prune cycle
// ══════════════════════════════════
export async function pruneBrain() {
  console.log('[Brain Prune] Starting self-curation cycle...');

  const before = {
    entities: db.prepare('SELECT COUNT(*) as c FROM brain_entities').get().c,
    connections: db.prepare('SELECT COUNT(*) as c FROM brain_connections').get().c,
  };

  // Phase 1: Quick structural cleanup
  const danglingCleaned = cleanDanglingRefs();
  const dupeConns = mergeDuplicateConnections();
  const orphansRemoved = pruneOrphans();

  // Phase 2: Decay (gradual, runs each cycle)
  const connDecay = decayWeakConnections();
  const entityDecay = decayStaleEntities();

  // Phase 3: AI-powered merge (expensive, but thorough)
  let entitiesMerged = 0;
  try {
    entitiesMerged = await mergeDuplicates();
  } catch (err) {
    console.error('[Brain Prune] Merge error:', err.message);
  }

  // Final orphan cleanup after merges
  const finalOrphans = pruneOrphans();

  const after = {
    entities: db.prepare('SELECT COUNT(*) as c FROM brain_entities').get().c,
    connections: db.prepare('SELECT COUNT(*) as c FROM brain_connections').get().c,
  };

  const summary = {
    orphansRemoved: orphansRemoved + finalOrphans,
    connectionsDecayed: connDecay.decayed,
    connectionsPruned: connDecay.pruned + dupeConns + danglingCleaned,
    entitiesDecayed: entityDecay.decayed,
    entitiesPruned: entityDecay.pruned,
    entitiesMerged,
    before,
    after,
    netChange: {
      entities: after.entities - before.entities,
      connections: after.connections - before.connections,
    }
  };

  console.log(`[Brain Prune] Done: ${before.entities}→${after.entities} entities (${summary.netChange.entities}), ${before.connections}→${after.connections} connections (${summary.netChange.connections})`);

  return summary;
}
