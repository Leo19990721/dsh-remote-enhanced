export const CHILD_STOP_COMMAND = 'remote-stop-child';

// Runs as the exact root Agent authorized by commands/execute. The official
// ancestor authority rechecks the live tree at interruption time; this command
// never manufactures a trusted-user identity from a root-only grant.
export function registerChildControl(ctx) {
  const commands = ctx.get('commands'), subagents = ctx.get('subagents');
  if (!commands || !subagents) return;
  commands.register({ name: CHILD_STOP_COMMAND, description: 'Request interruption of one descendant through its owning root.', input: { hint: '<child-session-id>' },
    async handler({ agent, rawInput, signal }) {
      const child = rawInput.trim();
      if (!child || /\s/.test(child) || child.length > 256 || child === agent.id) return { kind: 'error', text: 'A descendant Session ID is required.' };
      signal.throwIfAborted();
      const rows = await subagents.listDescendants(agent.id, signal);
      if (!rows.some(row => row.kind === 'child' && row.id === child)) return { kind: 'error', text: 'The target is not a descendant of this root.' };
      signal.throwIfAborted();
      subagents.interrupt(child, { kind: 'ancestor', agent });
      return { kind: 'success', text: 'Interruption requested.' };
    },
  });
}

export async function stopRemoteChild(channel, childSessionId, signal) {
  if (typeof childSessionId !== 'string' || !childSessionId || /\s/.test(childSessionId) || childSessionId.length > 256) throw new Error('INVALID_CHILD_SESSION');
  const listed = await channel.call('session/list', { args: { _request: {} } }, signal);
  if (!listed.ok) return listed;
  const rows = new Map(listed.value.items.map(row => [row.sessionId, row]));
  let root = rows.get(childSessionId); const visited = new Set();
  if (root?.origin !== 'subagent') throw new Error('CHILD_SESSION_UNAVAILABLE');
  while (root.origin === 'subagent') {
    if (visited.has(root.sessionId)) throw new Error('INVALID_SUBAGENT_ANCESTRY');
    visited.add(root.sessionId);
    root = rows.get(root.parentSessionId);
    if (!root) throw new Error('SUBAGENT_ROOT_UNAVAILABLE');
  }
  signal.throwIfAborted();
  const result = await channel.call('commands/execute', { args: { agentId: root.sessionId, line: '/' + CHILD_STOP_COMMAND + ' ' + childSessionId, submittedAttachments: [] } }, signal);
  if (!result.ok) return result;
  if (result.value?.result?.kind !== 'success') return { ok: false, error: { code: 'session-hosts/child-stop-unavailable', message: result.value?.result?.text || 'Install the same Unified Sessions version on the owning Host to stop its children.', details: {} } };
  return { ok: true, value: { accepted: true } };
}
