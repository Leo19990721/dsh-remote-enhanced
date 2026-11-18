import test from 'node:test';
import assert from 'node:assert/strict';
import { installSessionResidency } from '../client-residency.js';

function fixture() {
  const references = new Map(), bindings = new Map(), opens = [], disposals = [], listeners = new Set();
  const list = { ids: ['a', 'b', 'c'], byId: { a: {}, b: {}, c: {} } };
  const service = {
    list: { getSnapshot: () => list, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); } },
    retain(id) {
      if (!bindings.has(id)) { const state = { removed: false }; bindings.set(id, { id, state, session: { getSnapshot: () => state } }); opens.push(id); }
      references.set(id, (references.get(id) || 0) + 1);
      let released = false; const binding = bindings.get(id);
      return { sessionId: id, binding, ready: Promise.resolve(binding), release() {
        if (released) return; released = true;
        const remaining = references.get(id) - 1; references.set(id, remaining);
        if (!remaining) { bindings.delete(id); disposals.push(id); }
      } };
    },
    binding: id => bindings.get(id),
  };
  return { service, opens, disposals, references, bindings, list,
    omitted(id) { list.ids = list.ids.filter(value => value !== id); delete list.byId[id]; for (const fn of listeners) fn(); },
    removed(id) { if (bindings.has(id)) bindings.get(id).state.removed = true; this.omitted(id); },
  };
}

test('recently viewed native sessions remain live and switching back does not reload history', async () => {
  const f = fixture(), original = f.service.retain;
  const dispose = installSessionResidency(f.service, { maxSessions: 2 });
  try {
    const a = f.service.retain('a', { source: 'mainView' }); const binding = a.binding;
    a.release();
    const b = f.service.retain('b', { source: 'mainView' }); b.release();
    const again = f.service.retain('a', { source: 'mainView' });
    assert.equal(again.binding, binding);
    assert.deepEqual(f.opens, ['a', 'b']);
    assert.equal(f.bindings.size, 2);
    again.release();
  } finally { dispose(); }
  assert.equal(f.service.retain, original);
  assert.equal(f.bindings.size, 0);
});

test('a temporarily omitted catalog row keeps the viewed native session resident', async () => {
  const f = fixture(), dispose = installSessionResidency(f.service, { maxSessions: 2 });
  try {
    const viewed = f.service.retain('a', { source: 'mainView' }), binding = viewed.binding;
    f.omitted('a'); viewed.release();
    const returned = f.service.retain('a', { source: 'mainView' });
    assert.ok(returned.binding === binding, 'a partial catalog must not replace the live binding');
    assert.deepEqual(f.opens, ['a']);
    returned.release(); f.removed('a');
    assert.equal(f.bindings.has('a'), false, 'an explicit removal must still release the cache');
  } finally { dispose(); }
});

test('residency is bounded, never pre-opens unseen history and releases removed sessions', async () => {
  const f = fixture(); const dispose = installSessionResidency(f.service, { maxSessions: 2 });
  try {
    assert.deepEqual(f.opens, []);
    for (const id of ['a', 'b', 'c']) f.service.retain(id, { source: 'mainView' }).release();
    assert.deepEqual([...f.bindings.keys()], ['b', 'c']);
    assert.deepEqual(f.disposals, ['a']);
    f.removed('b');
    assert.equal(f.bindings.has('b'), false);
    const temporary = f.service.retain('a', { source: 'gateway' }); temporary.release();
    assert.equal(f.bindings.has('a'), false, 'temporary calls must not fill the resident set');
  } finally { dispose(); }
});
