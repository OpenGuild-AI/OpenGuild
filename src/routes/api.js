import express from 'express';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import db from '../db/database.js';
import { addSSEClient, removeSSEClient, broadcast } from '../engine/discussion.js';
import { getAllAgentStates } from '../engine/agent-state.js';
import { archetypes } from '../agents/archetypes.js';
import { getBrainGraph, getBrainStats, getEntityConnections, backfillBrain, getBrainArtifacts } from '../engine/brain.js';
import { getDiary, generateDailySummaries } from '../engine/diary.js';
import { generatePredictions } from '../engine/predictions.js';
import { getGuildMessages, onUserGuildMessage } from '../engine/guild-chat.js';
import { generateQuestsFromBrain, voteOnQuest } from '../engine/quests.js';
import { getArtifactValidations, validateArtifact, scheduleValidation } from '../engine/validation.js';
import { browse, searchDDGBrowser, searchGoogleBrowser } from '../engine/browser.js';
import { readFile, writeFile, listDir, execCommand, fetchRSS, fetchJSON, analyzeText, diffCompare, queryBrain, memoryStore, memoryRecall } from '../engine/agent-tools.js';

const router = express.Router();

// Simple SSE test endpoint
router.get('/test-sse', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  
  let i = 0;
  const interval = setInterval(() => {
    i++;
    const msg = JSON.stringify({ type: 'test', payload: { count: i, time: new Date().toISOString() } });
    res.write(`data: ${msg}\n\n`);
    if (i >= 10) { clearInterval(interval); res.end(); }
  }, 2000);
  
  req.on('close', () => clearInterval(interval));
});

// SSE endpoint for live updates
router.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*'
  });

  // Send initial state immediately
  const initEnvelope = JSON.stringify({ type: 'state', payload: getAllAgentStates() });
  res.write(`data: ${initEnvelope}\n\n`);
  res.flush?.();

  // Keep-alive ping every 15s
  const keepAlive = setInterval(() => {
    res.write(': keepalive\n\n');
    res.flush?.();
  }, 15000);

  addSSEClient(res);
  req.on('close', () => {
    clearInterval(keepAlive);
    removeSSEClient(res);
  });
});

// Get recent messages
router.get('/messages', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const before = req.query.before;
  
  let query = `SELECT * FROM messages ORDER BY created_at DESC LIMIT ?`;
  let params = [limit];
  
  if (before) {
    query = `SELECT * FROM messages WHERE id < ? ORDER BY created_at DESC LIMIT ?`;
    params = [before, limit];
  }
  
  const messages = db.prepare(query).all(...params).reverse();
  
  // Enrich with archetype info + news links
  const enriched = messages.map(m => {
    const arch = archetypes.find(a => a.id === m.agent_id);
    // Look up the news link if this message references an article
    let news_link = null;
    let news_source = null;
    if (m.news_context) {
      const newsItem = db.prepare('SELECT link, feed_source FROM news_items WHERE title = ? LIMIT 1').get(m.news_context);
      if (newsItem) {
        news_link = newsItem.link;
        news_source = newsItem.feed_source;
      }
    }
    const isUser = m.agent_id?.startsWith('user:');
    const userName = isUser ? m.agent_id.slice(5) : null;
    let parsedToolData = null;
    try { if (m.tool_data) parsedToolData = JSON.parse(m.tool_data); } catch(e) {}
    return {
      ...m,
      agent_name: userName || arch?.name || m.agent_id,
      agent_avatar: isUser ? '👤' : (arch?.avatar || '🤖'),
      agent_color: isUser ? '#8a8698' : (arch?.color || '#888'),
      is_user: isUser,
      agent_title: arch?.title || '',
      news_link,
      news_source,
      tool_data: parsedToolData
    };
  });
  
  res.json(enriched);
});

// Post user message
router.post('/messages', (req, res) => {
  const { content, username, channel } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: 'Empty message' });
  
  const text = content.trim().slice(0, 500);
  const name = (username || 'Guest').trim().slice(0, 30);
  
  if (channel === 'guild') {
    // Post to guild chat
    const result = db.prepare(
      'INSERT INTO guild_messages (agent_id, content, tokens_in, tokens_out) VALUES (?, ?, 0, 0)'
    ).run('user:' + name, text);
    
    broadcast('guild-chat', {
      id: result.lastInsertRowid,
      agent_id: 'user:' + name,
      agent_name: name,
      agent_avatar: '👤',
      agent_color: '#c8a44e',
      agent_title: 'Human',
      content: text,
      tokens_in: 0,
      tokens_out: 0,
      is_user: false,
      created_at: new Date().toISOString()
    });
    
    // Trigger agent response to user
    onUserGuildMessage(name, text);
    
    return res.json({ id: result.lastInsertRowid });
  }
  
  // Post to world chat
  const result = db.prepare(
    'INSERT INTO messages (agent_id, content, news_context, tokens_in, tokens_out) VALUES (?, ?, ?, 0, 0)'
  ).run('user:' + name, text, null);
  
  broadcast('chat', {
    id: result.lastInsertRowid,
    agent_id: 'user:' + name,
    agent_name: name,
    agent_avatar: '👤',
    agent_color: '#c8a44e',
    agent_title: 'Human',
    content: text,
    news_context: null,
    news_link: null,
    news_source: null,
    tokens_in: 0,
    tokens_out: 0,
    is_user: false,
    created_at: new Date().toISOString()
  });
  
  res.json({ id: result.lastInsertRowid });
});

// Get agent states
router.get('/agents', (req, res) => {
  res.json(getAllAgentStates());
});

// Get daily diary summaries (grouped by day)
router.get('/diary', (req, res) => {
  res.json(getDiary());
});

// Trigger diary summarization
router.post('/diary/generate', async (req, res) => {
  const day = req.body?.day || null;
  generateDailySummaries(day).catch(err => console.error('[Diary]', err));
  res.json({ status: 'started' });
});

// Get journals
router.get('/journals', (req, res) => {
  const agentId = req.query.agent;
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  
  let query, params;
  if (agentId) {
    query = `SELECT * FROM journals WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?`;
    params = [agentId, limit];
  } else {
    query = `SELECT * FROM journals ORDER BY created_at DESC LIMIT ?`;
    params = [limit];
  }
  
  const journals = db.prepare(query).all(...params);
  const enriched = journals.map(j => {
    const arch = archetypes.find(a => a.id === j.agent_id);
    return { ...j, agent_name: arch?.name, agent_avatar: arch?.avatar };
  });
  
  res.json(enriched);
});

// Get archetypes info
router.get('/archetypes', (req, res) => {
  res.json(archetypes.map(a => ({
    id: a.id,
    name: a.name,
    title: a.title,
    avatar: a.avatar,
    color: a.color,
    inspired_by: a.inspired_by,
    style: a.style,
    interests: a.interests,
    energy_profile: a.energy_profile
  })));
});

// Agent detail — full config including prompts
router.get('/agents/:id', (req, res) => {
  const agent = archetypes.find(a => a.id === req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const state = getAllAgentStates().find(s => s.agent_id === req.params.id);

  res.json({
    ...agent,
    state: state || null,
    modes: agent.modes || [],
    personality: agent.personality || '',
    discussionPrompt: agent.discussionPrompt || ''
  });
});

// Update agent prompts (runtime only — persists until restart)
router.put('/agents/:id', (req, res) => {
  const agent = archetypes.find(a => a.id === req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const { personality, discussionPrompt, modes, interests } = req.body;
  if (personality !== undefined) agent.personality = personality;
  if (discussionPrompt !== undefined) agent.discussionPrompt = discussionPrompt;
  if (modes !== undefined && Array.isArray(modes)) agent.modes = modes;
  if (interests !== undefined && Array.isArray(interests)) agent.interests = interests;

  console.log(`[API] Agent ${agent.name} prompts updated`);
  res.json({ ok: true, agent: { id: agent.id, name: agent.name } });
});

// Save agent prompts permanently to archetypes.js
router.post('/agents/:id/save', async (req, res) => {
  const { readFileSync, writeFileSync } = await import('fs');
  const { join } = await import('path');
  const filePath = join(process.cwd(), 'src/agents/archetypes.js');

  try {
    const agent = archetypes.find(a => a.id === req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    let source = readFileSync(filePath, 'utf8');
    const { personality, discussionPrompt } = req.body;

    // Replace personality prompt for this agent
    if (personality !== undefined) {
      const idPattern = new RegExp(`(id:\\s*'${agent.id}'[\\s\\S]*?personality:\\s*\`)([\\s\\S]*?)(\`)`);
      source = source.replace(idPattern, `$1${personality.replace(/`/g, '\\`')}$3`);
      agent.personality = personality;
    }

    if (discussionPrompt !== undefined) {
      const idPattern = new RegExp(`(id:\\s*'${agent.id}'[\\s\\S]*?discussionPrompt:\\s*\`)([\\s\\S]*?)(\`)`);
      source = source.replace(idPattern, `$1${discussionPrompt.replace(/`/g, '\\`')}$3`);
      agent.discussionPrompt = discussionPrompt;
    }

    writeFileSync(filePath, source);
    console.log(`[API] Agent ${agent.name} prompts saved to disk`);
    res.json({ ok: true, saved: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get digests (news summaries + commentary)
router.get('/digests', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);
  const digests = db.prepare(
    'SELECT * FROM digests ORDER BY created_at DESC LIMIT ?'
  ).all(limit);
  res.json(digests);
});

// Get full archive view: news + journals + digests grouped by date
router.get('/archive', (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 7, 30);
  
  // Get journals grouped by date
  const journals = db.prepare(`
    SELECT j.*, date(j.created_at) as day FROM journals j
    WHERE j.created_at > datetime('now', '-${days} days')
    ORDER BY j.created_at DESC
  `).all().map(j => {
    const arch = archetypes.find(a => a.id === j.agent_id);
    return { ...j, agent_name: arch?.name, agent_avatar: arch?.avatar, agent_color: arch?.color };
  });

  // Get news items
  const news = db.prepare(`
    SELECT *, date(fetched_at) as day FROM news_items
    WHERE discussed = 1 AND fetched_at > datetime('now', '-${days} days')
    ORDER BY fetched_at DESC
  `).all();

  // Get digests
  const digests = db.prepare(`
    SELECT *, date(created_at) as day FROM digests
    WHERE created_at > datetime('now', '-${days} days')
    ORDER BY created_at DESC
  `).all();

  // Group by day
  const byDay = {};
  for (const n of news) {
    if (!byDay[n.day]) byDay[n.day] = { news: [], journals: [], digests: [] };
    byDay[n.day].news.push(n);
  }
  for (const j of journals) {
    if (!byDay[j.day]) byDay[j.day] = { news: [], journals: [], digests: [] };
    byDay[j.day].journals.push(j);
  }
  for (const d of digests) {
    if (!byDay[d.day]) byDay[d.day] = { news: [], journals: [], digests: [] };
    byDay[d.day].digests.push(d);
  }

  // Sort days descending
  const sorted = Object.entries(byDay)
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([day, data]) => ({ day, ...data }));

  res.json(sorted);
});

// Get news intelligence: categories, connections, network
router.get('/intelligence', (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 3, 14);

  // All discussed news with categories
  const news = db.prepare(`
    SELECT ni.*, nc.category, nc.related_news_ids, nc.connections
    FROM news_items ni
    LEFT JOIN news_categories nc ON ni.id = nc.news_id
    WHERE ni.discussed = 1 AND ni.fetched_at > datetime('now', '-${days} days')
    ORDER BY ni.fetched_at DESC
  `).all();

  // Group by category
  const byCategory = {};
  const uncategorized = [];

  for (const n of news) {
    const cat = n.category || null;
    if (cat) {
      if (!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push(n);
    } else {
      uncategorized.push(n);
    }
  }

  // Build connections graph
  const connections = [];
  for (const n of news) {
    if (n.related_news_ids && n.related_news_ids !== 'none') {
      const relatedIds = n.related_news_ids.split(',').map(s => parseInt(s.trim())).filter(Boolean);
      for (const relId of relatedIds) {
        connections.push({
          from: n.id,
          to: relId,
          reason: n.connections || 'related'
        });
      }
    }
  }

  // Get comment counts per news item
  const commentCounts = db.prepare(`
    SELECT news_context, COUNT(*) as count 
    FROM messages 
    WHERE news_context IS NOT NULL 
    GROUP BY news_context
  `).all();
  const commentMap = {};
  for (const c of commentCounts) commentMap[c.news_context] = c.count;

  res.json({
    categories: byCategory,
    uncategorized,
    connections,
    commentCounts: commentMap,
    totalNews: news.length,
    totalCategories: Object.keys(byCategory).length
  });
});

// Get categories for intel view
router.get('/categories', (req, res) => {
  const items = db.prepare(`
    SELECT ni.id, ni.title, ni.link, ni.feed_source, ni.fetched_at, nc.category
    FROM news_items ni
    JOIN news_categories nc ON ni.id = nc.news_id
    WHERE ni.discussed = 1
    ORDER BY ni.fetched_at DESC
    LIMIT 200
  `).all();

  const byCategory = {};
  for (const item of items) {
    const cat = item.category || 'Uncategorized';
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(item);
  }

  res.json(Object.keys(byCategory).sort().map(cat => ({
    category: cat,
    items: byCategory[cat]
  })));
});

// ── Guild Brain API ──

// Full brain graph
router.get('/brain', (req, res) => {
  const graph = getBrainGraph();
  const stats = getBrainStats();
  res.json({ ...graph, stats });
});

// Brain stats
router.get('/brain/stats', (req, res) => {
  res.json(getBrainStats());
});

// Entity detail + connections
router.get('/brain/entity/:name', (req, res) => {
  const data = getEntityConnections(decodeURIComponent(req.params.name));
  if (!data) return res.status(404).json({ error: 'Entity not found' });
  res.json(data);
});

// Search entities
router.get('/brain/search', (req, res) => {
  const q = req.query.q || '';
  if (q.length < 2) return res.json([]);
  const results = db.prepare(
    "SELECT * FROM brain_entities WHERE name LIKE ? ORDER BY mention_count DESC LIMIT 20"
  ).all(`%${q}%`);
  res.json(results);
});

// Trigger backfill
router.post('/brain/backfill', async (req, res) => {
  backfillBrain().catch(err => console.error('[Brain] backfill error:', err));
  res.json({ status: 'started' });
});

// Brain prune (manual trigger)
import { pruneBrain } from '../engine/brain-prune.js';
router.post('/brain/prune', async (req, res) => {
  try {
    const summary = await pruneBrain();
    res.json(summary);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Brain artifacts
router.get('/brain/artifacts', (req, res) => {
  const artifacts = getBrainArtifacts();
  res.json(artifacts);
});

// Artifact validations
router.get('/brain/artifacts/:id/validations', (req, res) => {
  const validations = getArtifactValidations(parseInt(req.params.id));
  res.json(validations);
});

// Artifact full detail — content + extracted entities + connections
router.get('/brain/artifacts/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const artifact = db.prepare('SELECT * FROM brain_artifacts WHERE id = ?').get(id);
  if (!artifact) return res.status(404).json({ error: 'Artifact not found' });

  // Read .md content
  const artPath = join(process.cwd(), 'src/data/quests', artifact.filename);
  let artContent = '';
  if (existsSync(artPath)) {
    artContent = readFileSync(artPath, 'utf8');
  }

  // Get quest info
  let quest = null;
  if (artifact.quest_id) {
    quest = db.prepare('SELECT id, title, description, priority, status, completed_at FROM quests WHERE id = ?').get(artifact.quest_id);
  }

  // Get validations
  const validations = getArtifactValidations(id);

  // Get agent info
  const agentIds = (artifact.agent_ids || '').split(',').filter(Boolean);
  const agents = agentIds.map(aid => {
    const arch = archetypes.find(a => a.id === aid.trim());
    return arch ? { id: arch.id, name: arch.name, avatar: arch.avatar, color: arch.color, title: arch.title } : { id: aid, name: aid };
  });

  res.json({
    ...artifact,
    content: artContent,
    quest,
    validations,
    agents
  });
});

router.post('/brain/artifacts/:id/validate', async (req, res) => {
  const id = parseInt(req.params.id);
  scheduleValidation(id);
  res.json({ status: 'queued', artifactId: id });
});

// Guild messages
router.get('/guild/messages', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const messages = getGuildMessages(limit);
  res.json(messages);
});

// Predictions
router.get('/predictions', async (req, res) => {
  try {
    const predictions = await generatePredictions();
    res.json(predictions);
  } catch (err) {
    console.error('[Predictions]', err);
    res.json([]);
  }
});

// Quests
router.get('/quests', (req, res) => {
  const quests = db.prepare('SELECT * FROM quests ORDER BY created_at DESC').all();
  res.json(quests);
});

router.post('/quests/generate', async (req, res) => {
  try {
    const quests = await generateQuestsFromBrain();
    res.json({ generated: quests.length, quests });
  } catch (err) {
    console.error('[Quests]', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/quests/:id/vote', (req, res) => {
  const { vote } = req.body;
  if (!['for', 'against'].includes(vote)) return res.status(400).json({ error: 'Invalid vote' });
  const quest = voteOnQuest(parseInt(req.params.id), vote);
  res.json(quest);
});

// Tools
router.get('/tools', (req, res) => {
  res.json(db.prepare('SELECT * FROM tools ORDER BY created_at DESC').all());
});
router.post('/tools', (req, res) => {
  const { name, description, type } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const r = db.prepare('INSERT INTO tools (name, description, type) VALUES (?, ?, ?)').run(name, description || '', type || 'tool');
  res.json({ id: r.lastInsertRowid });
});
router.post('/tools/:id/toggle', (req, res) => {
  db.prepare('UPDATE tools SET enabled = NOT enabled WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Skills
router.get('/skills', (req, res) => {
  res.json(db.prepare('SELECT * FROM skills ORDER BY created_at DESC').all());
});
router.post('/skills', (req, res) => {
  const { name, description, instructions, triggers } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const r = db.prepare('INSERT INTO skills (name, description, instructions, triggers) VALUES (?, ?, ?, ?)').run(name, description || '', instructions || '', triggers || '');
  res.json({ id: r.lastInsertRowid });
});
router.post('/skills/:id/toggle', (req, res) => {
  db.prepare('UPDATE skills SET enabled = NOT enabled WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

export default router;

// Browser tool endpoints
router.post('/tools/browse', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });
  try {
    const result = await browse(url, { maxChars: 8000 });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/tools/search', async (req, res) => {
  const { query, engine } = req.body;
  if (!query) return res.status(400).json({ error: 'Query required' });
  try {
    let results;
    if (engine === 'google') results = await searchGoogleBrowser(query);
    else results = await searchDDGBrowser(query);
    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Agent Tools API
router.post('/tools/read', (req, res) => {
  const { path } = req.body;
  if (!path) return res.status(400).json({ error: 'Path required' });
  res.json(readFile(path));
});

router.post('/tools/write', (req, res) => {
  const { path, content } = req.body;
  if (!path || content === undefined) return res.status(400).json({ error: 'Path and content required' });
  res.json(writeFile(path, content));
});

router.post('/tools/ls', (req, res) => {
  res.json(listDir(req.body.path || '.'));
});

router.post('/tools/exec', (req, res) => {
  const { command } = req.body;
  if (!command) return res.status(400).json({ error: 'Command required' });
  res.json(execCommand(command));
});

router.post('/tools/rss', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });
  res.json(await fetchRSS(url));
});

router.post('/tools/json', async (req, res) => {
  const { url, headers } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });
  res.json(await fetchJSON(url, headers || {}));
});

router.post('/tools/analyze', async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'Text required' });
  res.json(await analyzeText(text));
});

router.post('/tools/diff', (req, res) => {
  const { a, b } = req.body;
  if (!a || !b) return res.status(400).json({ error: 'Both texts (a, b) required' });
  res.json(diffCompare(a, b));
});

router.post('/tools/brain', (req, res) => {
  const { query, type } = req.body;
  if (!query && type !== 'stats' && type !== 'topics') return res.status(400).json({ error: 'Query required' });
  res.json(queryBrain(query || '', type || 'search'));
});

router.post('/tools/memory/store', (req, res) => {
  const { agent_id, key, value } = req.body;
  if (!agent_id || !key) return res.status(400).json({ error: 'agent_id and key required' });
  res.json(memoryStore(agent_id, key, value));
});

router.post('/tools/memory/recall', (req, res) => {
  const { agent_id, key } = req.body;
  if (!agent_id) return res.status(400).json({ error: 'agent_id required' });
  res.json(memoryRecall(agent_id, key || null));
});
