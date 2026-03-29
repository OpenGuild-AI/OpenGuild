// Guild Brain — AI Knowledge Graph extraction engine
import db from '../db/database.js';
import { callKimi } from './kimi.js';

// ── Extract entities + connections from a news item ──
export async function extractBrain(newsItem) {
  if (!newsItem?.title) return;

  // Get existing entities for context
  const existingEntities = db.prepare(
    'SELECT name, type FROM brain_entities ORDER BY mention_count DESC LIMIT 40'
  ).all();
  const existingList = existingEntities.map(e => `${e.name} (${e.type})`).join(', ') || 'none yet';

  const prompt = `Analyze this news article and extract structured knowledge.

ARTICLE: "${newsItem.title}"
SOURCE: ${newsItem.feed_source || ''}
DETAILS: ${newsItem.summary || ''}

EXISTING ENTITIES IN BRAIN: ${existingList}

Reply in this EXACT format (no markdown, no extra text):

ENTITIES:
name|type|role
name|type|role

CONNECTIONS:
entity_a|entity_b|relation

TOPIC: topic_name|description

Rules:
- Types: person, country, org, technology, event, concept, region, policy
- Role: subject, object, actor, location, cause, effect
- Connections: describe the relationship in 2-4 words (e.g. "attacks", "sanctions", "allies with", "develops", "threatens")
- Reuse existing entity names when they match
- Extract 3-6 entities, 2-4 connections, 1 topic
- If entity already exists, use the EXACT same name`;

  try {
    const response = await callKimi(
      'You are a knowledge graph extraction engine. Output ONLY structured data. No prose.',
      prompt,
      { maxTokens: 300, temperature: 0.2 }
    );

    if (!response?.text) return;
    parseBrainResponse(response.text, newsItem);
  } catch (err) {
    console.error('[Brain] extraction error:', err.message);
  }
}

// ── Parse AI response into DB ──
function parseBrainResponse(response, newsItem) {
  const lines = response.split('\n').map(l => l.trim()).filter(Boolean);

  let section = null;
  const entities = [];
  const connections = [];
  let topicData = null;

  for (const line of lines) {
    if (line.startsWith('ENTITIES:')) { section = 'entities'; continue; }
    if (line.startsWith('CONNECTIONS:')) { section = 'connections'; continue; }
    if (line.startsWith('TOPIC:')) {
      const parts = line.replace('TOPIC:', '').trim().split('|');
      if (parts.length >= 1) topicData = { name: parts[0].trim(), desc: parts[1]?.trim() || '' };
      continue;
    }

    if (section === 'entities') {
      const parts = line.split('|').map(s => s.trim());
      if (parts.length >= 2 && parts[0] && parts[1]) {
        entities.push({ name: parts[0], type: parts[1].toLowerCase(), role: parts[2] || '' });
      }
    } else if (section === 'connections') {
      const parts = line.split('|').map(s => s.trim());
      if (parts.length >= 3 && parts[0] && parts[1] && parts[2]) {
        connections.push({ a: parts[0], b: parts[1], rel: parts[2] });
      }
    }
  }

  // Store entities
  const upsertEntity = db.prepare(`
    INSERT INTO brain_entities (name, type, description) VALUES (?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      mention_count = mention_count + 1,
      last_seen = datetime('now')
  `);
  const getEntity = db.prepare('SELECT id FROM brain_entities WHERE name = ?');
  const linkNewsEntity = db.prepare(
    'INSERT OR IGNORE INTO brain_news_entities (news_id, entity_id, role) VALUES (?, ?, ?)'
  );

  const entityIds = {};
  for (const e of entities) {
    upsertEntity.run(e.name, e.type, e.role);
    const row = getEntity.get(e.name);
    if (row) {
      entityIds[e.name] = row.id;
      if (newsItem.id) linkNewsEntity.run(newsItem.id, row.id, e.role);
    }
  }

  // Store connections
  const insertConn = db.prepare(
    'INSERT INTO brain_connections (entity_a, entity_b, relation, news_id) VALUES (?, ?, ?, ?)'
  );
  for (const c of connections) {
    const aId = entityIds[c.a];
    const bId = entityIds[c.b];
    if (aId && bId) {
      // Check if connection already exists — if so, increase strength
      const existing = db.prepare(
        'SELECT id, strength FROM brain_connections WHERE entity_a = ? AND entity_b = ? AND relation = ?'
      ).get(aId, bId, c.rel);
      if (existing) {
        db.prepare('UPDATE brain_connections SET strength = strength + 0.5 WHERE id = ?').run(existing.id);
      } else {
        insertConn.run(aId, bId, c.rel, newsItem.id || null);
      }
    }
  }

  // Store topic
  if (topicData) {
    const entityIdList = Object.values(entityIds).join(',');
    const newsId = newsItem.id ? String(newsItem.id) : '';
    db.prepare(`
      INSERT INTO brain_topics (name, description, entity_ids, news_ids, heat)
      VALUES (?, ?, ?, ?, 1.0)
      ON CONFLICT(name) DO UPDATE SET
        entity_ids = entity_ids || ',' || ?,
        news_ids = COALESCE(news_ids, '') || ',' || ?,
        heat = heat + 1.0,
        updated_at = datetime('now')
    `).run(topicData.name, topicData.desc, entityIdList, newsId, entityIdList, newsId);
  }

  const eCnt = entities.length;
  const cCnt = connections.length;
  if (eCnt > 0) console.log(`[Brain] +${eCnt} entities, +${cCnt} connections, topic: ${topicData?.name || 'none'}`);
}

// ── Get brain stats ──
export function getBrainStats() {
  const entities = db.prepare('SELECT COUNT(*) as c FROM brain_entities').get().c;
  const connections = db.prepare('SELECT COUNT(*) as c FROM brain_connections').get().c;
  const topics = db.prepare('SELECT COUNT(*) as c FROM brain_topics').get().c;
  const artifacts = db.prepare('SELECT COUNT(*) as c FROM brain_artifacts').get().c;
  return { entities, connections, topics, artifacts };
}

// ── Get brain artifacts ──
export function getBrainArtifacts() {
  return db.prepare('SELECT * FROM brain_artifacts ORDER BY created_at DESC').all();
}

// ── Get full brain graph ──
export function getBrainGraph() {
  // Get scaffold first (Earth + continents), then top entities by mentions
  const scaffold = db.prepare(
    "SELECT * FROM brain_entities WHERE type IN ('planet','continent') ORDER BY mention_count DESC"
  ).all();
  const scaffoldIds = new Set(scaffold.map(e => e.id));
  
  const others = db.prepare(
    "SELECT * FROM brain_entities WHERE type NOT IN ('planet','continent') ORDER BY mention_count DESC LIMIT 80"
  ).all();
  
  const entities = [...scaffold, ...others];
  const entityIds = new Set(entities.map(e => e.id));

  const connections = db.prepare(`
    SELECT bc.*, ea.name as from_name, eb.name as to_name, ea.type as from_type, eb.type as to_type
    FROM brain_connections bc
    JOIN brain_entities ea ON bc.entity_a = ea.id
    JOIN brain_entities eb ON bc.entity_b = eb.id
    ORDER BY bc.strength DESC LIMIT 300
  `).all().filter(c => entityIds.has(c.entity_a) && entityIds.has(c.entity_b)).slice(0, 200);

  const topics = db.prepare(
    'SELECT * FROM brain_topics ORDER BY heat DESC LIMIT 30'
  ).all();

  return { entities, connections, topics };
}

// ── Find connections for a specific entity ──
export function getEntityConnections(entityName) {
  const entity = db.prepare('SELECT * FROM brain_entities WHERE name = ?').get(entityName);
  if (!entity) return null;

  const connections = db.prepare(`
    SELECT bc.relation, bc.strength,
      CASE WHEN bc.entity_a = ? THEN eb.name ELSE ea.name END as connected_to,
      CASE WHEN bc.entity_a = ? THEN eb.type ELSE ea.type END as connected_type
    FROM brain_connections bc
    JOIN brain_entities ea ON bc.entity_a = ea.id
    JOIN brain_entities eb ON bc.entity_b = eb.id
    WHERE bc.entity_a = ? OR bc.entity_b = ?
    ORDER BY bc.strength DESC
  `).all(entity.id, entity.id, entity.id, entity.id);

  const news = db.prepare(`
    SELECT ni.title, ni.feed_source, ni.link
    FROM brain_news_entities bne
    JOIN news_items ni ON bne.news_id = ni.id
    WHERE bne.entity_id = ?
    ORDER BY ni.fetched_at DESC LIMIT 10
  `).all(entity.id);

  return { entity, connections, news };
}

// ── Ingest quest output .md into brain ──
export async function ingestQuestOutput(filepath, questId = null, agentIdsList = null) {
  const { readFileSync, existsSync } = await import('fs');
  const { basename } = await import('path');

  if (!existsSync(filepath)) {
    console.error('[Brain] Quest output file not found:', filepath);
    return;
  }

  const content = readFileSync(filepath, 'utf8');
  const filename = basename(filepath);

  // Extract title from first heading or first line
  const titleMatch = content.match(/^#\s+(.+)/m);
  const title = titleMatch ? titleMatch[1].trim() : filename.replace(/\.md$/i, '');

  // Collect agent_ids
  let agentIds = agentIdsList || '';
  if (!agentIds && questId) {
    const quest = db.prepare('SELECT assigned_agents, proposed_by FROM quests WHERE id = ?').get(questId);
    if (quest) {
      agentIds = quest.assigned_agents || quest.proposed_by || '';
    }
  }

  const prompt = `Parse this knowledge document and extract structured data.

DOCUMENT:
${content.slice(0, 4000)}

Reply in this EXACT format (no markdown, no extra text):

ENTITIES:
name|type|role
(extract ALL entities mentioned, types: person, country, org, technology, event, concept, region, policy, governance_body, armed_movement)

CONNECTIONS:
entity_a|entity_b|relation

TOPIC: topic_name|description`;

  const response = await callKimi(
    'You are a knowledge graph extraction engine. Output ONLY structured data. No prose.',
    prompt,
    { maxTokens: 500, temperature: 0.2 }
  );

  if (!response?.text) return;

  // Reuse existing parseBrainResponse with a synthetic newsItem (id=null to skip news linking)
  parseBrainResponse(response.text, { id: null });

  // Record artifact in brain_artifacts
  try {
    db.prepare(
      'INSERT INTO brain_artifacts (quest_id, filename, title, agent_ids, validation_status) VALUES (?, ?, ?, ?, ?)'
    ).run(questId, filename, title, agentIds, 'pending');
    console.log(`[Brain] Artifact recorded: "${title}" (quest ${questId || 'none'})`);
  } catch (err) {
    console.error('[Brain] Failed to record artifact:', err.message);
  }

  console.log('[Brain] Ingested quest output:', filepath);
}

// ── Process all unprocessed news ──
export async function backfillBrain() {
  const unprocessed = db.prepare(`
    SELECT ni.* FROM news_items ni
    LEFT JOIN brain_news_entities bne ON ni.id = bne.news_id
    WHERE ni.discussed = 1 AND bne.news_id IS NULL
    ORDER BY ni.fetched_at DESC LIMIT 10
  `).all();

  console.log(`[Brain] Backfilling ${unprocessed.length} items...`);
  for (const item of unprocessed) {
    await extractBrain(item);
    // Small delay to avoid API rate limits
    await new Promise(r => setTimeout(r, 1500));
  }
}
