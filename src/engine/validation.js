// Artifact Validation Engine — agents verify quest outputs using web search
import db from '../db/database.js';
import { callKimi } from './kimi.js';
import { archetypes } from '../agents/archetypes.js';
import { broadcast } from './discussion.js';
import { verifyFact, webSearch, fetchPage } from './tools.js';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const QUEST_DIR = join(process.cwd(), 'src/data/quests');
let isValidating = false;
const validationQueue = [];

// Ensure artifact_validations table exists
db.exec(`
  CREATE TABLE IF NOT EXISTS artifact_validations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    artifact_id INTEGER NOT NULL,
    agent_id TEXT NOT NULL,
    vote TEXT NOT NULL,
    reasoning TEXT,
    facts_checked INTEGER DEFAULT 0,
    facts_verified INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT (datetime('now')),
    FOREIGN KEY (artifact_id) REFERENCES brain_artifacts(id)
  );
  CREATE INDEX IF NOT EXISTS idx_av_artifact ON artifact_validations(artifact_id);
`);

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

// Extract key claims from artifact content
async function extractClaims(content) {
  const result = await callKimi(
    'Extract 3-5 key factual claims from this document that can be verified. Output ONLY the claims, one per line. No numbering, no explanations.',
    content.slice(0, 3000),
    { maxTokens: 200, temperature: 0.2 }
  );
  if (!result?.text) return [];
  return result.text.split('\n').map(c => c.trim()).filter(c => c.length > 10).slice(0, 5);
}

// Main validation pipeline for one artifact
export async function validateArtifact(artifactId) {
  const artifact = db.prepare('SELECT * FROM brain_artifacts WHERE id = ?').get(artifactId);
  if (!artifact) return;
  if (artifact.validation_status === 'validated' || artifact.validation_status === 'rejected') return;

  // Mark as validating
  db.prepare("UPDATE brain_artifacts SET validation_status = 'validating' WHERE id = ?").run(artifactId);
  broadcast('artifact-status', { id: artifactId, status: 'validating' });

  // Read the .md file
  const filepath = join(QUEST_DIR, artifact.filename);
  let content = '';
  if (existsSync(filepath)) {
    content = readFileSync(filepath, 'utf8');
  } else {
    console.error('[Validation] File not found:', filepath);
    db.prepare("UPDATE brain_artifacts SET validation_status = 'pending' WHERE id = ?").run(artifactId);
    return;
  }

  // Get participating agents
  const agentIds = (artifact.agent_ids || '').split(',').map(s => s.trim()).filter(Boolean);
  // If no agents recorded, pick 3 random active ones
  if (agentIds.length === 0) {
    const active = db.prepare("SELECT agent_id FROM agent_states WHERE status = 'active' ORDER BY RANDOM() LIMIT 3").all();
    agentIds.push(...active.map(a => a.agent_id));
  }
  // Need at least 2 validators
  if (agentIds.length < 2) {
    const more = db.prepare("SELECT agent_id FROM agent_states WHERE agent_id NOT IN (" + agentIds.map(() => '?').join(',') + ") ORDER BY RANDOM() LIMIT ?")
      .all(...agentIds, 2 - agentIds.length);
    agentIds.push(...more.map(a => a.agent_id));
  }

  console.log(`[Validation] Validating artifact "${artifact.title}" with ${agentIds.length} agents`);

  // Phase 1: Extract key claims and verify them against web
  const claims = await extractClaims(content);
  const verifications = [];

  for (const claim of claims) {
    try {
      const result = await verifyFact(claim, artifact.title);
      verifications.push({ claim, ...result });
      await sleep(1500);
    } catch (e) {
      console.error('[Validation] Fact check error:', e.message);
      verifications.push({ claim, verified: false, confidence: 'low', sources: [], reasoning: 'Verification failed: ' + e.message });
    }
  }

  const factsChecked = verifications.length;
  const factsVerified = verifications.filter(v => v.verified).length;
  const verificationSummary = verifications.map(v =>
    `- "${v.claim}" → ${v.verified ? '✓ VERIFIED' : '✗ UNVERIFIED'} (${v.confidence}) — ${v.reasoning}`
  ).join('\n');

  // Phase 2: Each agent reviews the artifact with fact-check results
  const votes = [];

  for (const agentId of agentIds) {
    const arch = getArchetype(agentId);
    if (!arch) continue;

    const prompt = `You are ${arch.name} (${arch.title}). ${arch.personality}

You are reviewing a quest research artifact for the Guild Brain. Your job is to validate whether this should be accepted as knowledge.

ARTIFACT: "${artifact.title}"

CONTENT (excerpt):
${content.slice(0, 2000)}

FACT-CHECK RESULTS:
${verificationSummary || 'No facts could be verified against web sources.'}

Facts checked: ${factsChecked}, Facts verified: ${factsVerified}

Review criteria:
1. Are the key facts plausible and supported by the fact-checks?
2. Are the entities correctly identified and typed?
3. Are the connections between entities accurate?
4. Is the analysis sound and well-reasoned?

Respond in this EXACT format:
VOTE: approve|reject
REASON: one sentence explaining your vote (stay in character)`;

    try {
      const result = await callKimi(prompt, '', { maxTokens: 100, temperature: 0.5 });
      if (!result?.text) continue;

      const voteMatch = result.text.match(/VOTE:\s*(approve|reject)/i);
      const reasonMatch = result.text.match(/REASON:\s*(.+)/i);

      const vote = voteMatch ? voteMatch[1].toLowerCase() : 'reject';
      const reasoning = reasonMatch ? reasonMatch[1].trim() : 'No reasoning provided.';

      // Store vote
      db.prepare(
        'INSERT INTO artifact_validations (artifact_id, agent_id, vote, reasoning, facts_checked, facts_verified) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(artifactId, agentId, vote, reasoning, factsChecked, factsVerified);

      votes.push({ agentId, vote, reasoning });

      // Post in guild chat
      const emoji = vote === 'approve' ? '✓' : '✗';
      postGuildMsg(agentId, `${emoji} Validation of "${artifact.title}": ${vote.toUpperCase()}. ${reasoning}`);

      await sleep(2000 + Math.random() * 2000);
    } catch (e) {
      console.error(`[Validation] Agent ${agentId} error:`, e.message);
    }
  }

  // Phase 3: Determine final status
  const approvals = votes.filter(v => v.vote === 'approve').length;
  const rejections = votes.filter(v => v.vote === 'reject').length;

  let finalStatus;
  if (rejections > 0) {
    finalStatus = 'rejected';
  } else if (approvals >= 2) {
    finalStatus = 'validated';
  } else {
    finalStatus = 'pending'; // Not enough votes
  }

  db.prepare('UPDATE brain_artifacts SET validation_status = ? WHERE id = ?').run(finalStatus, artifactId);
  broadcast('artifact-status', { id: artifactId, status: finalStatus, approvals, rejections });

  const statusEmoji = finalStatus === 'validated' ? '🟢' : finalStatus === 'rejected' ? '🔴' : '🟡';
  console.log(`[Validation] "${artifact.title}" → ${finalStatus} (${approvals} approve, ${rejections} reject, ${factsVerified}/${factsChecked} facts verified)`);

  // Announce result
  if (votes.length > 0) {
    const announcer = agentIds[0];
    postGuildMsg(announcer, `${statusEmoji} Artifact "${artifact.title}" ${finalStatus}. ${approvals} approved, ${rejections} rejected. ${factsVerified}/${factsChecked} facts verified against web sources.`);
  }

  return { status: finalStatus, votes, factsChecked, factsVerified, verifications };
}

// Schedule a validation (adds to queue, processes serially)
export function scheduleValidation(artifactId) {
  validationQueue.push(artifactId);
  processQueue();
}

async function processQueue() {
  if (isValidating) return;
  if (!validationQueue.length) return;

  isValidating = true;
  try {
    const id = validationQueue.shift();
    await validateArtifact(id);
  } catch (e) {
    console.error('[Validation] Queue error:', e.message);
  } finally {
    isValidating = false;
    if (validationQueue.length) setTimeout(processQueue, 5000);
  }
}

// Find and validate all pending artifacts
export async function runPendingValidations() {
  if (isValidating) return;

  const pending = db.prepare(
    "SELECT id FROM brain_artifacts WHERE validation_status = 'pending' ORDER BY created_at ASC LIMIT 3"
  ).all();

  for (const art of pending) {
    scheduleValidation(art.id);
  }
}

// Get validations for an artifact
export function getArtifactValidations(artifactId) {
  const validations = db.prepare(
    'SELECT * FROM artifact_validations WHERE artifact_id = ? ORDER BY created_at ASC'
  ).all(artifactId);

  return validations.map(v => {
    const arch = getArchetype(v.agent_id);
    return {
      ...v,
      agent_name: arch?.name || v.agent_id,
      agent_avatar: arch?.avatar || '?',
      agent_color: arch?.color || '#888'
    };
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
