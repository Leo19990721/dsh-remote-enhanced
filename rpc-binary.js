// Preserve Connection's official multipart binary framing on this channel.
export function rpcResponse(rpcId, result) {
  const { attachments, ...plain } = result;
  const envelope = { type: 'server-response', rpcId, result: plain };
  if (!attachments?.length) return Response.json(envelope);
  const parts = new FormData();
  const metadata = attachments.map((attachment, index) => {
    const part = `bytes-${index}`;
    parts.set(part, new Blob([new Uint8Array(attachment.bytes)]));
    return { path: [...attachment.path], codec: 'bytes', part };
  });
  parts.set('metadata', JSON.stringify({ ...envelope, attachments: metadata }));
  return new Response(parts);
}

export function projectBinary(result, descriptor) {
  if (!result.ok || result.attachments?.length || !descriptor?.result?.encode) return result;
  const attachments = [];
  const value = descriptor.result.encode(result.value, (bytes, path) => {
    attachments.push({ path, bytes }); return null;
  });
  return { ...result, value, ...attachments.length ? { attachments } : {} };
}
