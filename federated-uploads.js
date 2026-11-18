// Raw attachment bytes retain their native Session receipt ownership. This
// route never consults or changes Remote's globally selected computer.
export const REMOTE_UPLOAD_MAX_BYTES = 192 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export async function uploadForSession(gateway, service, query, data, signal, peer) {
  gateway.owner(peer); signal.throwIfAborted();
  const sessionId = query.get('sessionId'), mediaType = query.get('mediaType');
  if (!sessionId || (mediaType !== null && !IMAGE_TYPES.has(mediaType))) throw new Error('INVALID_UPLOAD');
  const target = gateway.identities.decode(sessionId, 'session');
  const name = query.has('name') ? { name: query.get('name') } : {};
  if (target.hostId === 'local') {
    const request = { sessionId: target.id, data, signal, ...name };
    return { ok: true, value: mediaType === null ? await service.uploadStream(request) : await service.uploadImageStream({ ...request, mediaType }) };
  }
  const channel = await gateway.channel(target.hostId, peer, signal);
  try {
    let size = 0; const chunks = [];
    for await (const chunk of data) {
      signal.throwIfAborted(); size += chunk.byteLength;
      if (size > REMOTE_UPLOAD_MAX_BYTES) throw new Error('Remote upload exceeds the Remote transfer safety limit.');
      chunks.push(Buffer.from(chunk));
    }
    signal.throwIfAborted();
    const result = await channel.call('remoteUploads/upload', { args: { endpoint: mediaType === null ? 'file' : 'image', payload: { sessionId: target.id, data: Buffer.concat(chunks, size).toString('base64'), ...name, ...(mediaType === null ? {} : { mediaType }) } } }, signal);
    if (!result.ok) return result;
    if (result.value?.status !== 200 || typeof result.value?.json?.ok !== 'boolean') throw new Error('Remote upload returned an invalid response.');
    return result.value.json;
  } finally { await channel.release?.(); }
}
