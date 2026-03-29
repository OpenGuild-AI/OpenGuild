// Guild Chat Engine — free discussion between agents without news
import db from '../db/database.js';
import { callKimi } from './kimi.js';
import { archetypes } from '../agents/archetypes.js';
import { getGuildAgents, spendEnergy } from './agent-state.js';
import { broadcast } from './discussion.js';
import { detectSkillTrigger, executeSkill, getEnabledSkills } from './skill-engine.js';

let isRunning = false;
let pendingUserMsg = null; // queue user messages for agent response

function getArchetype(id) {
  return archetypes.find(a => a.id === id);
}

function getRecentGuildMessages(limit = 20) {
  return db.prepare(`
    SELECT * FROM guild_messages ORDER BY id DESC LIMIT ?
  `).all(limit).reverse();
}

function formatHistory(messages) {
  return messages.map(m => {
    if (m.agent_id?.startsWith('user:')) {
      const userName = m.agent_id.slice(5);
      return `${userName} (human): ${m.content}`;
    }
    const name = getArchetype(m.agent_id)?.name || m.agent_id;
    return `${name}: ${m.content}`;
  }).join('\n');
}

function postGuildMessage(agentId, content, tokensIn = 0, tokensOut = 0) {
  const arch = getArchetype(agentId);
  const stmt = db.prepare(`
    INSERT INTO guild_messages (agent_id, content, tokens_in, tokens_out)
    VALUES (?, ?, ?, ?)
  `);
  const info = stmt.run(agentId, content, tokensIn, tokensOut);

  db.prepare(`UPDATE agent_states SET last_spoke_at = datetime('now') WHERE agent_id = ?`).run(agentId);
  spendEnergy(agentId, content.length, 0.5); // guild = half energy cost

  const msg = {
    id: info.lastInsertRowid,
    agent_id: agentId,
    content,
    agent_name: arch?.name || agentId,
    agent_title: arch?.title || '',
    agent_color: arch?.color || '#888',
    agent_avatar: arch?.avatar || '?',
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    created_at: new Date().toISOString(),
    is_user: false
  };

  broadcast('guild-chat', msg);
  return msg;
}

// Called when a user posts in guild — triggers agent response
export function onUserGuildMessage(username, content) {
  pendingUserMsg = { username, content, at: Date.now() };
}

async function respondToUser(guildAgents) {
  if (!pendingUserMsg) return false;
  if (guildAgents.length === 0) return false;
  
  const { username, content } = pendingUserMsg;
  pendingUserMsg = null;
  
  // Pick 1-2 agents to respond
  const respondCount = Math.min(guildAgents.length, 1 + (Math.random() > 0.5 ? 1 : 0));
  const shuffled = [...guildAgents].sort(() => Math.random() - 0.5);
  const responders = shuffled.slice(0, respondCount);
  
  for (const agent of responders) {
    const arch = getArchetype(agent.agent_id);
    if (!arch) continue;
    
    const recent = getRecentGuildMessages(15);
    const chatHistory = formatHistory(recent);
    const guildNames = guildAgents.map(a => getArchetype(a.agent_id)?.name || a.agent_id);
    
    const prompt = `You are ${arch.name} (${arch.title}). ${arch.personality}

You're in the Guild lounge with other thinkers. ${username} (a human) just joined the conversation.

Present: ${guildNames.join(', ')}, ${username}

Conversation so far:
${chatHistory}

${username} just said: "${content}"

Respond naturally (1-3 sentences). They're part of the conversation — engage with their point like you would with any other mind in the room. Agree, challenge, ask back, riff. No labels, no prefixes — just speak.`;

    broadcast('guild-typing', { agent_id: agent.agent_id, agent_name: arch.name });
    
    try {
      const result = await callKimi(prompt, '', { maxTokens: 150, temperature: 0.85 });
      if (!result?.text) continue;
      
      await new Promise(r => setTimeout(r, 2000 + Math.random() * 2000));
      broadcast('guild-typing-done', {});
      postGuildMessage(agent.agent_id, result.text.trim(), result.usage?.prompt_tokens || 0, result.usage?.completion_tokens || 0);
    } catch (err) {
      console.error('[GuildChat] response error:', err.message);
    }
    
    // Small gap between multiple responders
    if (responders.length > 1) await new Promise(r => setTimeout(r, 3000));
  }
  
  return true;
}

export async function guildTick() {
  if (isRunning) return;
  
  const guildAgents = getGuildAgents();
  if (guildAgents.length === 0) return;

  isRunning = true;

  try {
    // Priority: respond to user messages first
    if (pendingUserMsg) {
      await respondToUser(guildAgents);
      isRunning = false;
      return;
    }

    // Pick a random guild agent to speak
    const speaker = guildAgents[Math.floor(Math.random() * guildAgents.length)];
    const arch = getArchetype(speaker.agent_id);
    if (!arch) { isRunning = false; return; }

    const recent = getRecentGuildMessages(15);
    const chatHistory = formatHistory(recent);
    const guildNames = guildAgents.map(a => getArchetype(a.agent_id)?.name || a.agent_id);

    // Check if there are recent human messages to reference
    const recentHumans = recent.filter(m => m.agent_id?.startsWith('user:'));
    const humanContext = recentHumans.length > 0 
      ? '\nThere are human participants in the conversation. Engage with their messages naturally if relevant.'
      : '';

    const prompt = `You are ${arch.name} (${arch.title}). ${arch.personality}

You are in the Guild lounge — an intimate space where minds meet without the noise of breaking news. This is a real conversation, not a debate stage.${humanContext}

Present: ${guildNames.join(', ')}

${chatHistory ? `Conversation so far:\n${chatHistory}` : 'The lounge is quiet. Say something to break the silence.'}

Continue the conversation naturally (1-3 sentences). You must respond to what was just said — don't change the subject unless the thread has run its course. Be yourself: casual, opinionated, curious, or provocative. Ask questions. Push back. Riff on ideas. No labels, no prefixes — just speak.`;

    broadcast('guild-typing', { agent_id: speaker.agent_id, agent_name: arch.name });

    // 20% chance to activate a skill instead of normal chat
    const shouldUseSkill = Math.random() < 0.20;
    let responseText = null;

    if (shouldUseSkill && recent.length >= 5) {
      // Pick a random enabled skill weighted by context
      const skills = getEnabledSkills();
      if (skills.length) {
        const skill = skills[Math.floor(Math.random() * skills.length)];
        console.log(`[GuildChat] ${arch.name} activating skill: ${skill.name}`);

        // Build context for skill execution
        const lastMsg = recent[recent.length - 1];
        const skillContext = {
          message: lastMsg?.content || '',
          topic: lastMsg?.content || '',
          claim: lastMsg?.content || '',
          recentMessages: recent.map(m => ({
            agent_id: m.agent_id,
            agent_name: getArchetype(m.agent_id)?.name || m.agent_id,
            content: m.content
          }))
        };

        try {
          const skillOutput = await executeSkill(skill, speaker.agent_id, skillContext);
          if (skillOutput) {
            responseText = skillOutput.trim();
            // Prefix with skill badge
            responseText = `⚡ [${skill.name}] ${responseText}`;
          }
        } catch (e) {
          console.error(`[GuildChat] Skill execution error:`, e.message);
        }
      }
    }

    // Fall back to normal conversation if skill didn't produce output
    if (!responseText) {
      const result = await callKimi(prompt, '', { maxTokens: 150, temperature: 0.9 });
      if (!result?.text) { isRunning = false; return; }
      responseText = result.text.trim();
    }

    await new Promise(r => setTimeout(r, 1500 + Math.random() * 2000));

    broadcast('guild-typing-done', {});
    postGuildMessage(speaker.agent_id, responseText, 0, 0);

  } catch (err) {
    console.error('[GuildChat] tick error:', err.message);
  } finally {
    isRunning = false;
  }
}

// Get messages for API
export function getGuildMessages(limit = 50) {
  const rows = db.prepare(`SELECT * FROM guild_messages ORDER BY id DESC LIMIT ?`).all(limit).reverse();
  return rows.map(m => {
    const arch = getArchetype(m.agent_id);
    const isUser = m.agent_id?.startsWith('user:');
    return {
      ...m,
      agent_name: isUser ? m.agent_id.slice(5) : (arch?.name || m.agent_id),
      agent_title: isUser ? 'Human' : (arch?.title || ''),
      agent_color: isUser ? '#c8a44e' : (arch?.color || '#888'),
      agent_avatar: isUser ? '👤' : (arch?.avatar || '?'),
      is_user: false
    };
  });
}
