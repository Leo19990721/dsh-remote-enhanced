const PREFIX = 'dsh-peer:';
const KIND = new Map([
  ...['sessionId', 'parentSessionId', 'childSessionId', 'parentSession', 'agentId', 'beforeSessionId'].map(key => [key, 'session']),
  ...['workspaceId', 'beforeWorkspaceId'].map(key => [key, 'workspace']),
  ...['sessionIds', 'archivedSessionIds', 'pinnedSessionIds'].map(key => [key, 'session']),
  ['workspaceIds', 'workspace'],
]);

export class SurfaceIdentities {
  constructor(baseHost = 'local') { this.baseHost = baseHost; }
  encode(hostId, kind, id) {
    if (hostId === this.baseHost || id === undefined || id === null) return id;
    if (typeof hostId !== 'string' || !hostId || typeof id !== 'string') throw new Error('INVALID_IDENTITY');
    return PREFIX + JSON.stringify([hostId, kind, id]);
  }
  decode(value, expectedKind) {
    if (typeof value !== 'string') throw new Error('INVALID_IDENTITY');
    if (!value.startsWith(PREFIX)) return { hostId: this.baseHost, id: value };
    let tuple;
    try { tuple = JSON.parse(value.slice(PREFIX.length)); } catch { throw new Error('INVALID_IDENTITY'); }
    if (!Array.isArray(tuple) || tuple.length !== 3 || tuple.some(part => typeof part !== 'string' || !part)) throw new Error('INVALID_IDENTITY');
    if (tuple[1] !== expectedKind) throw new Error('IDENTITY_KIND');
    return { hostId: tuple[0], id: tuple[2] };
  }
  isRemote(value) { return typeof value === 'string' && value.startsWith(PREFIX); }
}

// Walk only declared API structure. Unknown JSON, tool arguments, messages and
// projection payloads are opaque even when their strings resemble an identity.
export function mapSchema(value, schema, transform, key = '', root = schema) {
  const kind = KIND.get(key);
  if (kind && typeof value === 'string') return transform(kind, value);
  if (kind && Array.isArray(value)) return value.map(id => typeof id === 'string' ? transform(kind, id) : id);
  if (value === null || typeof value !== 'object' || !schema) return value;
  schema = resolveRef(schema, root);
  if (schema.allOf) return schema.allOf.reduce((next, part) => mapSchema(next, part, transform, key, root), value);
  const choices = schema.oneOf || schema.anyOf;
  if (choices) {
    const matched = choices.find(choice => matches(value, resolveRef(choice, root)));
    return matched ? mapSchema(value, matched, transform, key, root) : value;
  }
  if (Array.isArray(value)) return schema.items ? value.map(item => mapSchema(item, schema.items, transform, '', root)) : value;
  if (!schema.properties) return value;
  const result = { ...value };
  for (const [name, field] of Object.entries(schema.properties)) {
    if (Object.hasOwn(value, name)) result[name] = mapSchema(value[name], field, transform, name, root);
  }
  return result;
}
function resolveRef(schema, root) {
  const visited = new Set();
  while (schema?.$ref?.startsWith('#/') && !visited.has(schema)) {
    visited.add(schema);
    const path = schema.$ref.slice(2).split('/').map(part => part.replaceAll('~1', '/').replaceAll('~0', '~'));
    const resolved = path.reduce((value, part) => value?.[part], root);
    if (!resolved) return {};
    schema = resolved;
  }
  return schema || {};
}
const schemas = new WeakMap();
export function schemaOf(codec) {
  if (!codec || typeof codec !== 'object') return undefined;
  if (schemas.has(codec)) return schemas.get(codec);
  let schema;
  try { schema = codec.jsonSchema; } catch {}
  if (!schema && codec.create) {
    try { schema = codec.create().toJSONSchema({ unrepresentable: 'any', io: 'output' }); } catch {}
  }
  schemas.set(codec, schema);
  return schema;
}
function matches(value, schema) {
  if (schema.const !== undefined) return value === schema.const;
  if (schema.type === 'null') return value === null;
  if (schema.type === 'array') return Array.isArray(value);
  if (schema.type && schema.type !== 'object') return typeof value === schema.type;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (schema.required?.some(key => !Object.hasOwn(value, key))) return false;
  return Object.entries(schema.properties || {}).every(([key, field]) => field.const === undefined || value[key] === field.const);
}

export function mapInput(ids, args, fields) {
  const result = { ...args }; let hostId;
  const decode = (kind, value) => {
    const target = ids.decode(value, kind);
    if (hostId !== undefined && hostId !== target.hostId) throw new Error('MIXED_HOSTS');
    hostId = target.hostId;
    return target.id;
  };
  for (const field of fields) {
    if (!Object.hasOwn(args, field.wire)) continue;
    result[field.wire] = field.kind ? decode(field.kind, args[field.wire]) : mapSchema(args[field.wire], field.schema, decode, field.wire);
  }
  return { hostId: hostId || ids.baseHost, args: result };
}
