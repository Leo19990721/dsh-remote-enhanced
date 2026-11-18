const TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml' };

export async function sessionMedia(gateway, query, signal, peer) {
  const sessionId = query.get('sessionId'), path = query.get('path');
  if (!sessionId || !path || path.length > 32768 || path.includes('\0')) throw new Error('图片地址无效。');
  const type = TYPES[path.split('.').at(-1).toLowerCase()];
  if (!type) throw new Error('此地址只用于图片预览。');
  const metadata = await gateway.call('workspaceFiles/stat', { args: { workspaceFileScopeId: sessionId, path } }, signal, peer);
  if (!metadata.ok) return { status: 404, text: '远端图片不存在或没有读取权限。' };
  if (metadata.value.bytes > 32 * 1024 * 1024) return { status: 413, text: '图片超过 32 MB，请通过文件预览或下载查看。' };
  const result = await gateway.call('workspaceFiles/readBytes', { args: { workspaceFileScopeId: sessionId, path, options: { range: { offset: 0, length: 32 * 1024 * 1024 } } } }, signal, peer);
  if (!result.ok) return { status: 403, text: '远端图片不可读取。' };
  if (!result.value.eof || result.value.version !== metadata.value.version) return { status: 409, text: '图片已变化或内容过大，请重试。' };
  return { status: 200, type, data: result.value.data };
}
