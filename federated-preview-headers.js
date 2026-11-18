// Header filtering preserved from ds-harness-remote 0.6.5 (MIT).
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto']);
export function cleanHeaders(headers) {
  const removed = new Set(HOP);
  for (const [name, value] of headers) if (name.toLowerCase() === 'connection') for (const token of value.split(',')) removed.add(token.trim().toLowerCase());
  return headers.filter(([name]) => !removed.has(name.toLowerCase()) && !name.toLowerCase().startsWith('sec-websocket-'));
}
export function headerPairs(headers) { return Object.entries(headers).flatMap(([name, value]) => value === undefined ? [] : (Array.isArray(value) ? value : [value]).map(item => [name, item])); }
