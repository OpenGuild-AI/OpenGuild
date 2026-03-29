// Quest Runner — agents autonomously research and produce .md outputs
import db from '../db/database.js';
import { callKimi } from './kimi.js';
import { archetypes } from '../agents/archetypes.js';
import { getGuildAgents } from './agent-state.js';
import { broadcast } from './discussion.js';
import { ingestQuestOutput } from './brain.js';
import { webSearch, fetchPage } from './tools.js';
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const QUEST_DIR = join(process.cwd(), 'src/data/quests');
if (!existsSync(QUEST_DIR)) mkdirSync(QUEST_DIR, { recursive: true });

let isRunning = false;

function getArchetype(id) {
  return archetypes.find(a => a.id === id);
}

function postGuildMsg(agentId, content) {
  const arch = getArchetype(agentId);
  const info = db.prepare(
    'INSERT INTO guild_messages (agent_id, content, tokens_in, tokens_out) VALUES (?, ?, 0, 0)'
  ).run(agentId, content);
  
  broadcast('guild-chat', {
    id: info.lastInsertRowid, agent_id: agentId, content,
    agent_name: arch?.name || agentId, agent_title: arch?.title || '',
    agent_color: arch?.color || '#888', agent_avatar: arch?.avatar || '?',
    tokens_in: 0, tokens_out: 0, created_at: new Date().toISOString(), is_user: false
  });
}

// Main quest execution pipeline
export async function executeQuest(questId) {
  if (isRunning) return;
  isRunning = true;

  const quest = db.prepare('SELECT * FROM quests WHERE id = ?').get(questId);
  if (!quest || quest.status === 'completed') { isRunning = false; return; }

  // Mark as active
  db.prepare("UPDATE quests SET status = 'active' WHERE id = ?").run(questId);

  const guildAgents = getGuildAgents();
  const agents = guildAgents.length ? guildAgents : db.prepare("SELECT * FROM agent_states WHERE status = 'active' LIMIT 3").all();
  
  if (!agents.length) { isRunning = false; return; }

  // Pick lead researcher + supporting agents
  const lead = agents[0];
  const leadArch = getArchetype(lead.agent_id);
  const supporters = agents.slice(1);

  console.log(`[QuestRunner] Starting: "${quest.title}" (lead: ${leadArch?.name})`);

  try {
    // Phase 1: Announce quest in guild chat
    postGuildMsg(lead.agent_id, `I'm taking on a quest: "${quest.title}". Let me research this.`);
    await sleep(2000);

    // Phase 2: Generate search queries
    const queryResult = await callKimi(
      `You are ${leadArch?.name}, a researcher. Generate 3 focused web search queries to investigate this quest.
Quest: ${quest.title}
Description: ${quest.description}
Output only the 3 queries, one per line. No numbering, no explanations.`,
      '', { maxTokens: 100, temperature: 0.7 }
    );

    const queries = (queryResult?.text || '').split('\n').map(q => q.trim()).filter(Boolean).slice(0, 3);
    if (!queries.length) queries.push(quest.title);

    postGuildMsg(lead.agent_id, `Searching for: ${queries.map(q => `"${q}"`).join(', ')}`);
    await sleep(1500);

    // Phase 3: Web search + fetch
    let allFindings = [];
    for (const query of queries) {
      const results = await webSearch(query);
      for (const r of results.slice(0, 2)) {
        const content = await fetchPage(r.url);
        if (content.length > 200) {
          allFindings.push({ title: r.title, url: r.url, content: content.slice(0, 3000) });
        }
      }
      await sleep(1000);
    }

    if (!allFindings.length) {
      // Fallback: use Kimi's own knowledge as research source
      postGuildMsg(lead.agent_id, `No web sources found. Using my own knowledge to research this.`);
      await sleep(2000);

      const knowledgeResult = await callKimi(
        `You are ${leadArch?.name}, a deep researcher. You couldn't find web sources, so use your training knowledge.

Quest: "${quest.title}"
${quest.description}

Write a thorough research report based on what you know. Include:
- Key facts and context
- Important entities (people, orgs, places, concepts)
- Known connections and relationships
- What's still uncertain or debated

Be factual and specific. 4-6 paragraphs.`,
        '', { maxTokens: 700, temperature: 0.7 }
      );

      if (knowledgeResult?.text) {
        allFindings.push({ title: 'Agent Knowledge', url: 'internal', content: knowledgeResult.text });
      } else {
        postGuildMsg(lead.agent_id, `Couldn't research this quest right now. Will retry later.`);
        db.prepare("UPDATE quests SET status = 'proposed' WHERE id = ?").run(questId);
        isRunning = false;
        return;
      }
    }

    postGuildMsg(lead.agent_id, `Found ${allFindings.length} sources. Analyzing...`);
    await sleep(2000);

    // Phase 4: Analysis — lead agent synthesizes findings
    const sourceSummary = allFindings.map((f, i) => `SOURCE ${i+1}: ${f.title}\nURL: ${f.url}\n${f.content.slice(0, 1500)}`).join('\n\n---\n\n');

    const analysisResult = await callKimi(
      `You are ${leadArch?.name} (${leadArch?.title}). ${leadArch?.personality}

You researched the quest: "${quest.title}"
${quest.description}

Based on these sources, write your key findings and analysis. Be thorough but concise. Identify:
- Key facts discovered
- New entities (people, orgs, places, concepts) for the knowledge graph
- New connections between entities
- Gaps that remain

Write 3-5 paragraphs of analysis.`,
      sourceSummary,
      { maxTokens: 600, temperature: 0.7 }
    );

    const analysis = analysisResult?.text || '';
    if (!analysis) { isRunning = false; return; }

    // Share excerpt in guild chat
    const excerpt = analysis.split('\n').filter(Boolean).slice(0, 2).join(' ').slice(0, 200);
    postGuildMsg(lead.agent_id, excerpt + '...');
    await sleep(2000);

    // Phase 5: All guild agents add their perspectives
    const perspectives = [analysis]; // collect all perspectives for final synthesis
    for (const sup of supporters) {
      const supArch = getArchetype(sup.agent_id);
      if (!supArch) continue;

      const prevMessages = perspectives.slice(-2).join('\n\n').slice(0, 600);
      
      const reactionResult = await callKimi(
        `You are ${supArch.name} (${supArch.title}). ${supArch.personality}

Quest: "${quest.title}"

Previous findings:
${prevMessages}

Contribute YOUR unique perspective in 2-4 sentences. Based on your archetype:
- What pattern or angle did others miss?
- What connections do you see?
- What would you investigate deeper?

Stay in character. Be specific, not generic.`,
        '', { maxTokens: 150, temperature: 0.85 }
      );

      if (reactionResult?.text) {
        postGuildMsg(sup.agent_id, reactionResult.text.trim());
        perspectives.push(reactionResult.text.trim());
        await sleep(3000 + Math.random() * 2000);
      }
    }

    // Phase 6: Generate the .md output file
    const mdResult = await callKimi(
      `Create a structured knowledge file in Markdown format for the OpenGuild Brain.

Quest: "${quest.title}"
${quest.description}

Analysis:
${perspectives.join('\n\n')}

Sources:
${allFindings.map(f => `- [${f.title}](${f.url})`).join('\n')}

Generate a .md file with these sections:
# [Quest Title]
## Summary
(2-3 sentence overview)
## Key Findings
(bullet points of facts discovered)
## Entities
(list: - **Name** (type) — brief description)
## Connections
(list: - Entity A → relationship → Entity B)
## Open Questions
(what still needs investigation)
## Sources
(URLs used)`,
      '', { maxTokens: 800, temperature: 0.5 }
    );

    const mdContent = mdResult?.text || `# ${quest.title}\n\n${analysis}\n\n## Sources\n${allFindings.map(f => `- [${f.title}](${f.url})`).join('\n')}`;

    // Save .md file
    const filename = quest.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60) + '.md';
    const filepath = join(QUEST_DIR, filename);
    writeFileSync(filepath, mdContent, 'utf8');
    console.log(`[QuestRunner] Output saved: ${filepath}`);

    // Ingest into brain
    try { await ingestQuestOutput(filepath); } catch (e) { console.error('[QuestRunner] Brain ingest error:', e.message); }

    // Phase 7: Mark quest completed
    db.prepare("UPDATE quests SET status = 'completed', completed_at = datetime('now') WHERE id = ?").run(questId);

    postGuildMsg(lead.agent_id, `Quest completed: "${quest.title}". Report saved to brain. Found ${allFindings.length} sources, identified new entities and connections.`);

    broadcast('quest-completed', { id: questId, title: quest.title, filename });

    // Phase 8: Trigger validation of the artifact
    try {
      const { scheduleValidation } = await import('./validation.js');
      const artifact = db.prepare('SELECT id FROM brain_artifacts WHERE quest_id = ? ORDER BY id DESC LIMIT 1').get(questId);
      if (artifact) scheduleValidation(artifact.id);
    } catch (e) { console.error('[QuestRunner] Validation trigger error:', e.message); }

  } catch (err) {
    console.error(`[QuestRunner] Error on quest ${questId}:`, err.message);
    postGuildMsg(lead.agent_id, `Hit a problem researching this quest. Will retry later.`);
    db.prepare("UPDATE quests SET status = 'proposed' WHERE id = ?").run(questId);
  } finally {
    isRunning = false;
  }
}

// Auto-pick and execute the highest priority proposed quest
export async function runNextQuest() {
  if (isRunning) return;

  const quest = db.prepare(`
    SELECT * FROM quests WHERE status = 'proposed'
    ORDER BY 
      CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
      created_at ASC
    LIMIT 1
  `).get();

  if (!quest) return;

  await executeQuest(quest.id);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
