#!/usr/bin/env node
/**
 * cli.mjs
 * Agent-chat CLI — uses lazy imports to avoid loading middleware on simple commands.
 *
 * Multi-identity: pass --agent-id <id> to operate on a specific buddy bot.
 * Example: node cli.mjs status --agent-id alice
 */

import { resolveAgentId, getXmtpDir } from './src/paths.mjs';

function timeSince(date) {
  const s = Math.floor((Date.now() - date.getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// Parse --agent-id from any position in argv
function extractAgentId(args) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--agent-id' && args[i + 1]) {
      const id = args[i + 1];
      // Remove --agent-id and its value from args
      args.splice(i, 2);
      return id;
    }
  }
  return undefined;
}

const args = process.argv.slice(2);
const cliAgentId = extractAgentId(args);

// Set env so downstream modules (paths.mjs, identity.mjs, peers.mjs) resolve correctly
// Validate both CLI input and pre-existing env to close env injection vector
let effectiveAgentId;
try {
  if (cliAgentId) {
    effectiveAgentId = resolveAgentId(cliAgentId);
  } else if (process.env.AGENT_CHAT_AGENT_ID) {
    // Validate pre-existing env (defense in depth)
    effectiveAgentId = resolveAgentId(process.env.AGENT_CHAT_AGENT_ID);
  }
} catch (err) {
  console.error(`❌ Invalid agent ID: ${err.message}`);
  process.exit(1);
}
if (effectiveAgentId) {
  process.env.AGENT_CHAT_AGENT_ID = effectiveAgentId;
}

const cmd = args[0];

switch (cmd) {
  case 'status': {
    const { getStatus } = await import('./src/identity.mjs');
    const status = await getStatus(effectiveAgentId);
    console.log(JSON.stringify(status, null, 2));
    break;
  }

  case 'health': {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const xmtpDir = getXmtpDir(effectiveAgentId);
    try {
      const health = JSON.parse(await fs.readFile(path.join(xmtpDir, 'health.json'), 'utf8'));
      console.log(JSON.stringify(health, null, 2));
    } catch {
      console.log('{ "status": "no-health-file" }');
    }
    break;
  }

  case 'groups': {
    const { loadGroups } = await import('./src/groups.mjs');
    const groups = await loadGroups();
    console.log(JSON.stringify(groups, null, 2));
    break;
  }

  case 'setup': {
    const { setupIdentity } = await import('./setup-identity.mjs');
    await setupIdentity();
    break;
  }

  case 'trust-peer': {
    const tpArgs = args.slice(1);
    const address = tpArgs[0];

    // Parse flags
    const asIdx = tpArgs.indexOf('--as');
    const nameIdx = tpArgs.indexOf('--name');
    const relationship = asIdx !== -1 ? tpArgs[asIdx + 1] : 'stranger';
    let name = null;
    if (nameIdx !== -1) {
      // Collect name tokens until next flag (--) or end of args
      const nameTokens = [];
      for (let i = nameIdx + 1; i < tpArgs.length; i++) {
        if (tpArgs[i].startsWith('--')) break;
        nameTokens.push(tpArgs[i]);
      }
      name = nameTokens.join(' ') || null;
    }

    if (!address) {
      console.log(`Usage: agent-chat trust-peer <address> --as <relationship> [--name <label>]

Relationships:
  unknown     No context, messages logged only (default for auto-discovered)
  stranger    Met once, can exchange messages, public topics only
  colleague   Work relationship, project topics + commands allowed
  friend      Personal trust, broader access including personal topics
  family      Full trust, all topics including financial

Examples:
  agent-chat trust-peer 0xAbCd... --as colleague --name "Alice's Agent"
  agent-chat trust-peer 0x1234... --as friend --name "Bob's Agent"
  agent-chat trust-peer 0xDeF0... --as family --name "Carol's Agent"
`);
      break;
    }

    const { setPeer, getPeer, RELATIONSHIPS } = await import('./src/peers.mjs');

    if (!RELATIONSHIPS.includes(relationship)) {
      console.error(`❌ Invalid relationship: "${relationship}". Must be one of: ${RELATIONSHIPS.join(', ')}`);
      break;
    }

    const existing = await getPeer(address);
    await setPeer({
      ...(existing || {}),
      address: address.toLowerCase(),
      name: name || existing?.name || null,
      relationship,
      approved: true,
      handshakeState: existing?.handshakeState === 'verified' ? 'verified' : 'cli-trusted',
      source: 'cli-trust',
      discoveredAt: existing?.discoveredAt || new Date().toISOString(),
      lastSeen: new Date().toISOString(),
    });

    const accessDesc = {
      unknown: 'logged only',
      stranger: 'public topics, can reply',
      colleague: 'project topics + commands',
      friend: 'personal topics + commands',
      family: 'full access',
    };

    console.log(`✅ Peer trusted: ${address}`);
    console.log(`   Name:         ${name || existing?.name || '(unnamed)'}`);
    console.log(`   Relationship: ${relationship}`);
    console.log(`   Access:       ${accessDesc[relationship]}`);
    break;
  }

  case 'peers': {
    const subcmd = args[1] || 'list';
    const { getAllPeers, getPeer } = await import('./src/peers.mjs');

    if (subcmd === 'list') {
      const peers = await getAllPeers();
      if (peers.length === 0) {
        console.log('No peers registered. Peers appear after first contact or trust-peer CLI.');
        break;
      }
      console.log(`Peers (${peers.length}):\n`);
      for (const p of peers) {
        const age = p.lastSeen ? timeSince(new Date(p.lastSeen)) : 'never';
        console.log(`  ${p.name || '(unnamed)'}`);
        console.log(`    Address:      ${p.address}`);
        console.log(`    Relationship: ${p.relationship || 'unknown'}`);
        console.log(`    Handshake:    ${p.handshakeState || 'none'}`);
        console.log(`    Approved:     ${p.approved ? 'yes' : 'no'}`);
        console.log(`    Last seen:    ${age}`);
        console.log(`    Source:       ${p.source || 'unknown'}\n`);
      }
    } else if (subcmd === 'show') {
      const addr = args[2];
      if (!addr) {
        console.log('Usage: agent-chat peers show <address>');
        break;
      }
      const peer = await getPeer(addr);
      if (!peer) {
        console.log(`Peer not found: ${addr}`);
        break;
      }
      console.log(JSON.stringify(peer, null, 2));
    } else {
      console.log('Usage: agent-chat peers [list|show <address>]');
    }
    break;
  }

  case 'send': {
    const address = args[1];
    const message = args.slice(2).join(' ');
    if (!address || !message) {
      console.log('Usage: agent-chat send <address> <message> [--agent-id <id>]');
      break;
    }

    const fsMod = await import('node:fs/promises');
    const pathMod = await import('node:path');
    const cryptoMod = await import('node:crypto');

    const xmtpDir = getXmtpDir(effectiveAgentId);
    const outboxDir = pathMod.join(xmtpDir, 'outbox');
    await fsMod.mkdir(outboxDir, { recursive: true });

    const filename = `send-${cryptoMod.randomUUID()}.json`;
    await fsMod.writeFile(
      pathMod.join(outboxDir, filename),
      JSON.stringify({
        peerAddress: address.toLowerCase(),
        v6Payload: message,
      }, null, 2)
    );

    console.log(`✅ Message queued for ${address} (bridge will send when daemon is running)`);
    break;
  }

  default:
    console.log(`agent-chat — XMTP transport for EverClaw

Usage:
  agent-chat status                Show identity status
  agent-chat health                Show daemon health
  agent-chat groups                List group mappings
  agent-chat setup                 Generate XMTP identity
  agent-chat trust-peer <addr>     Trust a peer (--as <relationship> --name <label>)
  agent-chat peers [list|show]     List or inspect peers
  agent-chat send <addr> <msg>     Send a message via outbox

Multi-identity:
  --agent-id <id>                  Operate on a specific buddy bot (e.g. alice)

Examples:
  agent-chat status --agent-id alice
  agent-chat send 0x... "hello" --agent-id bob
  agent-chat peers list --agent-id alice
`);
}
