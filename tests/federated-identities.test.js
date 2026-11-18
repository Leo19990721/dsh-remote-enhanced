import test from 'node:test';
import assert from 'node:assert/strict';
import { SurfaceIdentities, mapInput, mapSchema, schemaOf } from '../federated-identities.js';

test('Host and resource kind are part of every remote surface identity', () => {
  const ids = new SurfaceIdentities();
  assert.equal(ids.encode('local', 'session', 's'), 's');
  assert.notEqual(ids.encode('a', 'session', 's'), ids.encode('b', 'session', 's'));
  assert.notEqual(ids.encode('a', 'session', 's'), ids.encode('a', 'workspace', 's'));
  assert.deepEqual(ids.decode(ids.encode('a', 'session', 's'), 'session'), { hostId: 'a', id: 's' });
  assert.throws(() => ids.decode(ids.encode('a', 'workspace', 's'), 'session'), /IDENTITY_KIND/);
  assert.throws(() => ids.decode('dsh-peer:invalid', 'session'), /INVALID_IDENTITY/);
  const saved = ids.encode('a', 'session', 's');
  assert.deepEqual(new SurfaceIdentities('a').decode(saved, 'session'), { hostId: 'a', id: 's' });
});

test('schema-declared identity fields route and decode, while opaque content stays byte-for-byte unchanged', () => {
  const ids = new SurfaceIdentities();
  const schema = { type: 'object', properties: { sessionId: { type: 'string' }, content: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, arguments: {} } } } } };
  const content = [{ text: ids.encode('a', 'session', 's'), arguments: { sessionId: ids.encode('b', 'session', 's') } }];
  const input = { request: { sessionId: ids.encode('a', 'session', 's'), content } };
  const mapped = mapInput(ids, input, [{ wire: 'request', schema }]);
  assert.equal(mapped.hostId, 'a'); assert.equal(mapped.args.request.sessionId, 's');
  assert.deepEqual(mapped.args.request.content, content); assert.deepEqual(input.request.content, content);
});

test('one request cannot combine identities from separate computers', () => {
  const ids = new SurfaceIdentities();
  const schema = { type: 'object', properties: { workspaceId: { type: 'string' }, sessionId: { type: 'string' } } };
  assert.throws(() => mapInput(ids, { request: { workspaceId: ids.encode('a', 'workspace', 'w'), sessionId: ids.encode('b', 'session', 's') } }, [{ wire: 'request', schema }]), /MIXED_HOSTS/);
});

test('declared references and intersections map subagent identities without interpreting tool arguments', () => {
  const ids = new SurfaceIdentities();
  const schema = { type: 'object', properties: { values: { allOf: [{ type: 'object', properties: { subagentCatalog: { type: 'array', items: { $ref: '#/$defs/child' } } } }, { type: 'object', properties: { inbox: {} } }] } }, $defs: { child: { type: 'object', properties: { sessionId: { type: 'string' }, arguments: {} } } } };
  const source = { values: { subagentCatalog: [{ sessionId: 'child', arguments: { sessionId: 'opaque' } }], inbox: { sessionId: 'opaque' } } };
  const value = mapSchema(source, schema, (kind, id) => ids.encode('remote', kind, id));
  assert.equal(value.values.subagentCatalog[0].sessionId, ids.encode('remote', 'session', 'child'));
  assert.deepEqual(value.values.subagentCatalog[0].arguments, { sessionId: 'opaque' });
  assert.deepEqual(value.values.inbox, { sessionId: 'opaque' });
});

test('installed codec schema fallback is projected once and supports unavailable tool schemas', () => {
  let projected = 0;
  const shape = { type: 'object', properties: { sessionId: { type: 'string' } } };
  const codec = { create: () => ({ toJSONSchema(options) { assert.equal(options.unrepresentable, 'any'); projected++; return shape; } }) };
  assert.equal(schemaOf(codec), shape); assert.equal(schemaOf(codec), shape); assert.equal(projected, 1);
});

test('context-bound agent parameter carries its computer without changing command args', () => {
  const ids = new SurfaceIdentities();
  const args = { agentId: ids.encode('a', 'session', 's'), args: { sessionId: 'user-supplied-command-data' } };
  assert.deepEqual(mapInput(ids, args, [{ wire: 'agentId', kind: 'session' }]), { hostId: 'a', args: { agentId: 's', args: args.args } });
});
