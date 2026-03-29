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

  console.log(`[QuestRunner] Starting: "${quest.title}" (lead: ${leadArch?.name}, ${supporters.length} supporters)`);

  try {
    // Phase 1: Announce quest in guild chat
    postGuildMsg(lead.agent_id, `I'm taking on a quest: "${quest.title}". Let me assemble the research.`);
    await sleep(2000);

    // Phase 2: Lead generates initial research plan
    const planResult = await callKimi(
      `You are ${leadArch?.name}, a lead researcher. Plan a thorough research approach for this quest.

Quest: ${quest.title}
Description: ${quest.description}

Generate:
1. Five focused web search queries (different angles — general, specific entities, connections, timeline, counter-perspectives)
2. Two Wikipedia topics to check
3. One specific claim to fact-check

Output format (strict, one per line):
SEARCH: query here
SEARCH: query here
SEARCH: query here
SEARCH: query here
SEARCH: query here
WIKI: topic name
WIKI: topic name
FACTCHECK: specific claim to verify`,
      '', { maxTokens: 200, temperature: 0.7 }
    );

    const planText = planResult?.text || '';
    const searchQueries = (planText.match(/SEARCH:\s*(.+)/gi) || []).map(s => s.replace(/^SEARCH:\s*/i, '').trim()).filter(Boolean).slice(0, 5);
    const wikiTopics = (planText.match(/WIKI:\s*(.+)/gi) || []).map(s => s.replace(/^WIKI:\s*/i, '').trim()).filter(Boolean).slice(0, 2);
    const factClaims = (planText.match(/FACTCHECK:\s*(.+)/gi) || []).map(s => s.replace(/^FACTCHECK:\s*/i, '').trim()).filter(Boolean).slice(0, 1);

    if (!searchQueries.length) searchQueries.push(quest.title);

    postGuildMsg(lead.agent_id, `Research plan: ${searchQueries.length} searches, ${wikiTopics.length} Wikipedia dives, ${factClaims.length} fact-checks.`);
    await sleep(1500);

    // Phase 3: Round 1 — Lead agent does broad web search
    let allFindings = [];
    let allSources = []; // track all URLs for dedup

    postGuildMsg(lead.agent_id, `🔍 Starting web research...`);

    for (const query of searchQueries) {
      const results = await webSearch(query);
      for (const r of results.slice(0, 2)) {
        if (allSources.includes(r.url)) continue;
        allSources.push(r.url);
        const content = await fetchPage(r.url);
        if (content.length > 200) {
          allFindings.push({ title: r.title, url: r.url, content: content.slice(0, 3000), agent: leadArch?.name, phase: 'search' });
        }
      }
      await sleep(800);
    }

    postGuildMsg(lead.agent_id, `Found ${allFindings.length} sources from web search. Checking Wikipedia...`);
    await sleep(1500);

    // Phase 4: Wikipedia deep dives
    for (const topic of wikiTopics) {
      try {
        const { fetchWikipedia } = await import('./tools.js');
        const wikiContent = await fetchWikipedia(topic);
        if (wikiContent.length > 200) {
          const wikiUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(topic.replace(/ /g, '_'))}`;
          allFindings.push({ title: `Wikipedia: ${topic}`, url: wikiUrl, content: wikiContent.slice(0, 4000), agent: leadArch?.name, phase: 'wiki' });
          allSources.push(wikiUrl);
        }
      } catch (e) { console.error('[QuestRunner] Wiki error:', e.message); }
      await sleep(500);
    }

    // Phase 5: Supporters do their own research rounds
    for (const sup of supporters) {
      const supArch = getArchetype(sup.agent_id);
      if (!supArch) continue;

      // Each supporter generates their own search angle based on what's been found so far
      const existingTitles = allFindings.map(f => f.title).join(', ');
      const angleResult = await callKimi(
        `You are ${supArch.name} (${supArch.title}). ${supArch.personality}

The quest is: "${quest.title}"
Other researchers already found: ${existingTitles}

Based on YOUR unique perspective, generate 2 web search queries that explore angles OTHERS MISSED.
Output only the 2 queries, one per line. No numbering.`,
        '', { maxTokens: 80, temperature: 0.85 }
      );

      const supQueries = (angleResult?.text || '').split('\n').map(q => q.trim()).filter(q => q.length > 5).slice(0, 2);
      if (!supQueries.length) continue;

      postGuildMsg(sup.agent_id, `🔍 Researching my angle: ${supQueries.map(q => `"${q}"`).join(', ')}`);
      await sleep(1500);

      for (const query of supQueries) {
        const results = await webSearch(query);
        for (const r of results.slice(0, 2)) {
          if (allSources.includes(r.url)) continue;
          allSources.push(r.url);
          const content = await fetchPage(r.url);
          if (content.length > 200) {
            allFindings.push({ title: r.title, url: r.url, content: content.slice(0, 3000), agent: supArch.name, phase: 'supporter-search' });
          }
        }
        await sleep(800);
      }
    }

    postGuildMsg(lead.agent_id, `Total: ${allFindings.length} sources gathered from ${1 + supporters.length} researchers.`);
    await sleep(1500);

    // Phase 6: Fact-checking round
    if (factClaims.length > 0) {
      const checker = supporters[0] || lead;
      const checkerArch = getArchetype(checker.agent_id);
      
      for (const claim of factClaims) {
        try {
          const { verifyFact } = await import('./tools.js');
          postGuildMsg(checker.agent_id, `🔎 Fact-checking: "${claim.slice(0, 80)}..."`);
          const verification = await verifyFact(claim, quest.title);
          const emoji = verification.verified ? '✅' : '❌';
          postGuildMsg(checker.agent_id, `${emoji} ${claim.slice(0, 60)}... → ${verification.verified ? 'VERIFIED' : 'UNVERIFIED'} (${verification.confidence}). ${verification.reasoning}`);
          
          // Add verification sources to findings
          for (const src of verification.sources) {
            if (!allSources.includes(src)) {
              allSources.push(src);
              allFindings.push({ title: `Fact-check source`, url: src, content: verification.reasoning, agent: checkerArch?.name, phase: 'fact-check' });
            }
          }
        } catch (e) { console.error('[QuestRunner] Fact check error:', e.message); }
        await sleep(2000);
      }
    }

    // Phase 7: No sources fallback — use agent knowledge
    if (!allFindings.length) {
      postGuildMsg(lead.agent_id, `No web sources found. Using collective knowledge.`);
      await sleep(2000);

      const knowledgeResult = await callKimi(
        `You are ${leadArch?.name}, a deep researcher. Use your training knowledge.
Quest: "${quest.title}"
${quest.description}
Write a thorough research report. Include key facts, entities, connections, uncertainties. 4-6 paragraphs.`,
        '', { maxTokens: 700, temperature: 0.7 }
      );

      if (knowledgeResult?.text) {
        allFindings.push({ title: 'Agent Knowledge', url: 'internal', content: knowledgeResult.text, agent: leadArch?.name, phase: 'knowledge' });
      } else {
        postGuildMsg(lead.agent_id, `Couldn't research this quest right now. Will retry later.`);
        db.prepare("UPDATE quests SET status = 'proposed' WHERE id = ?").run(questId);
        isRunning = false;
        return;
      }
    }

    // Phase 8: Lead agent synthesizes ALL findings
    const sourceSummary = allFindings.map((f, i) => `SOURCE ${i+1} [${f.agent}, ${f.phase}]: ${f.title}\nURL: ${f.url}\n${f.content.slice(0, 1500)}`).join('\n\n---\n\n');

    const analysisResult = await callKimi(
      `You are ${leadArch?.name} (${leadArch?.title}). ${leadArch?.personality}

You led a research team on: "${quest.title}"
${quest.description}

Your team gathered ${allFindings.length} sources across web search, Wikipedia, and fact-checking.

Synthesize ALL findings into a comprehensive analysis:
- Key facts discovered (cite source numbers [1], [2] etc.)
- New entities for the knowledge graph
- New connections between entities
- What different team members found
- Contradictions or gaps

Write 4-6 paragraphs.`,
      sourceSummary,
      { maxTokens: 700, temperature: 0.7 }
    );

    const analysis = analysisResult?.text || '';
    if (!analysis) { isRunning = false; return; }

    const excerpt = analysis.split('\n').filter(Boolean).slice(0, 2).join(' ').slice(0, 200);
    postGuildMsg(lead.agent_id, excerpt + '...');
    await sleep(2000);

    // Phase 9: Each supporter adds their perspective on the synthesis
    const perspectives = [analysis];
    for (const sup of supporters) {
      const supArch = getArchetype(sup.agent_id);
      if (!supArch) continue;

      const prevMessages = perspectives.slice(-2).join('\n\n').slice(0, 800);
      
      const reactionResult = await callKimi(
        `You are ${supArch.name} (${supArch.title}). ${supArch.personality}

Quest: "${quest.title}"

The lead researcher's synthesis:
${prevMessages}

You also did your own research. Add YOUR unique perspective in 2-4 sentences:
- What pattern or angle did the lead miss?
- What connections do you see from your research?
- What needs deeper investigation?

Stay in character. Reference specific findings.`,
        '', { maxTokens: 200, temperature: 0.85 }
      );

      if (reactionResult?.text) {
        postGuildMsg(sup.agent_id, reactionResult.text.trim());
        perspectives.push(reactionResult.text.trim());
        await sleep(2000 + Math.random() * 2000);
      }
    }

    // Phase 10: Generate the .md output file
    const mdResult = await callKimi(
      `Create a structured knowledge file in Markdown for the OpenGuild Brain.

Quest: "${quest.title}"
${quest.description}

Team analysis (${perspectives.length} researchers):
${perspectives.join('\n\n')}

Sources (${allFindings.length} total):
${allFindings.map(f => `- [${f.title}](${f.url}) [${f.agent}, ${f.phase}]`).join('\n')}

Generate a comprehensive .md file:
# [Quest Title]
## Summary
(3-4 sentence overview)
## Key Findings
(detailed bullet points with source citations [1] [2])
## Entities
(list: - **Name** (type) — description + significance)
## Connections
(list: - Entity A → relationship → Entity B [source])
## Contradictions & Debates
(where sources disagree)
## Open Questions
(what needs further investigation)
## Sources
(numbered URLs with brief descriptions)`,
      '', { maxTokens: 1000, temperature: 0.5 }
    );

    const mdContent = mdResult?.text || `# ${quest.title}\n\n${analysis}\n\n## Sources\n${allFindings.map(f => `- [${f.title}](${f.url})`).join('\n')}`;

    // Save .md file
    const filename = quest.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60) + '.md';
    const filepath = join(QUEST_DIR, filename);
    writeFileSync(filepath, mdContent, 'utf8');
    console.log(`[QuestRunner] Output saved: ${filepath}`);

    // Ingest into brain — pass questId + participating agent IDs
    const agentIdsList = [lead.agent_id, ...supporters.map(s => s.agent_id)].join(',');
    try { await ingestQuestOutput(filepath, questId, agentIdsList); } catch (e) { console.error('[QuestRunner] Brain ingest error:', e.message); }

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
