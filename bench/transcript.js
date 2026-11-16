'use strict';
// What fills the boss context in one Claude Code run, read from its session transcript.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function find(sessionId, root = path.join(os.homedir(), '.claude', 'projects')) {
  if (!sessionId) return null;
  let dirs; try { dirs = fs.readdirSync(root); } catch { return null; }
  for (const d of dirs) {
    const file = path.join(root, d, sessionId + '.jsonl');
    if (fs.existsSync(file)) return file;
  }
  return null;
}

// Tool results grouped by kind; a Bash command counts as a read when it only shows files or searches.
function kind(block) {
  const name = block.name;
  if (name === 'Agent' || name === 'Task') return 'agent';
  if (name === 'Read' || name === 'Grep' || name === 'Glob') return 'read';
  if (name === 'Bash' || name === 'PowerShell') {
    const cmd = String((block.input && block.input.command) || '');
    if (/verify|node --test|npm (run )?test|hidden-check/.test(cmd)) return 'test';
    if (/\bgit (diff|show|log|status)\b/.test(cmd)) return 'git';
    if (/\b(cat|sed -n|head|tail|grep|rg|ls|find|wc|type|Get-Content)\b/.test(cmd)) return 'read';
    return 'shell';
  }
  if (name === 'Edit' || name === 'Write') return 'edit';
  if (/^Web/.test(name)) return 'web';
  return 'other';
}

function size(content) {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  // An image counts as a fixed size, as it costs tokens without text.
  return content.reduce((t, x) => t + (x.type === 'image' ? 6000 : JSON.stringify(x).length), 0);
}

function analyze(file) {
  const kinds = new Map(), calls = new Map(), chars = { own: 0, prompt: 0 }, agents = {};
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.isSidechain || !e.message) continue;
    const content = e.message.content;
    if (e.type === 'assistant') {
      const u = e.message.usage;
      if (u && e.message.id) calls.set(e.message.id, u);
      for (const b of Array.isArray(content) ? content : []) {
        if (b.type === 'tool_use') {
          kinds.set(b.id, kind(b));
          chars.own += JSON.stringify(b.input || {}).length;
          if (b.name === 'Agent' || b.name === 'Task') {
            const type = (b.input && b.input.subagent_type) || 'general-purpose';
            agents[type] = (agents[type] || 0) + 1;
          }
        } else if (b.type === 'text') chars.own += (b.text || '').length;
      }
    } else if (e.type === 'user') {
      if (typeof content === 'string') chars.prompt += content.length;
      for (const b of Array.isArray(content) ? content : []) {
        if (b.type === 'tool_result') {
          const k = kinds.get(b.tool_use_id) || 'other';
          out[k] = (out[k] || 0) + size(b.content);
        } else if (b.type === 'text') chars.prompt += (b.text || '').length;
      }
    }
  }
  const usage = [...calls.values()];
  const context = u => (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  const sum = key => usage.reduce((t, u) => t + (u[key] || 0), 0);
  const total = Object.values(out).reduce((t, v) => t + v, 0) + chars.own + chars.prompt;
  const share = {};
  for (const [k, v] of Object.entries({ ...out, own: chars.own, prompt: chars.prompt })) share[k] = total ? +(v / total).toFixed(3) : 0;
  return {
    calls: usage.length,
    avgContext: usage.length ? Math.round(usage.reduce((t, u) => t + context(u), 0) / usage.length) : 0,
    maxContext: usage.reduce((m, u) => Math.max(m, context(u)), 0),
    tokens: { input: sum('input_tokens'), cacheRead: sum('cache_read_input_tokens'), cacheWrite: sum('cache_creation_input_tokens'), output: sum('output_tokens') },
    share,
    agents,
  };
}

module.exports = { find, analyze, kind };
