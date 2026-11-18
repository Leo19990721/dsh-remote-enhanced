// Keep a bounded set of actually viewed native bindings. An extra native
// reference keeps the history stream current when Workspace navigation releases
// its mainView reference; it never starts an Agent or sends a prompt.
export function installSessionResidency(sessions, { maxSessions = 12 } = {}) {
  const original = sessions.retain, held = new Map();
  function remember(target, id) {
    const existing = held.get(id);
    if (existing) { held.delete(id); held.set(id, existing); return; }
    const reference = original.call(sessions, target, { source: 'workspaceCache' });
    held.set(id, reference);
    void reference.ready.catch(() => {});
    while (held.size > maxSessions) {
      const [oldest, value] = held.entries().next().value;
      held.delete(oldest); value.release();
    }
  }
  function retain(target, options) {
    const reference = original.call(this, target, options);
    if (options?.source === 'mainView') remember(target, reference.sessionId);
    return reference;
  }
  // Keep the already selected binding when this plugin activates in-place.
  const initial = sessions.list.getSnapshot();
  for (const id of initial.ids) if (initial.byId[id]?.retainedBy?.mainView && sessions.binding(id)) remember(id, id);
  sessions.retain = retain;
  const unsubscribe = sessions.list.subscribe(() => {
    const current = sessions.list.getSnapshot();
    for (const [id, reference] of held) if (!current.byId[id]) {
      // A federated baseline can arrive before this Host's catalog. Missing
      // metadata does not end an existing Session; use its explicit removal.
      const binding = sessions.binding(id);
      if (!binding || binding.session.getSnapshot().removed) { held.delete(id); reference.release(); }
    }
  });
  return () => {
    if (sessions.retain === retain) sessions.retain = original;
    unsubscribe();
    const references = [...held.values()]; held.clear();
    for (const reference of references) reference.release();
  };
}
