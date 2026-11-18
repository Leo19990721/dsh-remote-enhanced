// Session-authorized remote byte reads. Remote 0.6.5 caps each window at 4 MiB;
// a full-file request must consume all windows rather than treating one as EOF.
export const REMOTE_FILE_MAX_BYTES = 100 * 1024 * 1024;
const WINDOW = 1024 * 1024;
function failed(code, message) { throw Object.assign(new Error(message), { code }); }
function bytesOf(result) {
  const value = result.value;
  if (value?.data instanceof Uint8Array) return value.data;
  const attached = result.attachments?.find(item => Array.isArray(item.path) && item.path.length === 1 && item.path[0] === 'data');
  if (attached?.bytes instanceof Uint8Array) return attached.bytes;
  failed('FILE_INVALID_RESPONSE', '远端返回的文件内容无效。');
}

export async function readRemoteFile(channel, args, signal, maxBytes = REMOTE_FILE_MAX_BYTES) {
  const range = args.options?.range;
  const start = range?.offset ?? 0, limit = range?.length ?? (range ? WINDOW : maxBytes);
  if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(start + limit)) failed('INVALID_FILE_RANGE', '文件读取范围无效。');
  if (limit > maxBytes) failed('FILE_TOO_LARGE', `远端文件读取上限为 ${Math.round(maxBytes / 1024 / 1024)} MB，请缩小读取范围。`);
  const chunks = []; let total = 0, first, last;
  while (total < limit) {
    signal.throwIfAborted();
    const length = Math.min(WINDOW, limit - total);
    const result = await channel.call('workspaceFiles/readBytes', { args: { ...args, options: { ...args.options, range: { offset: start + total, length } } } }, signal);
    if (!result.ok) return result;
    const value = result.value, data = bytesOf(result);
    if (!first) {
      first = value;
      if (!range && value.bytes > maxBytes) failed('FILE_TOO_LARGE', `远端文件超过 ${Math.round(maxBytes / 1024 / 1024)} MB，未加载。`);
    }
    if (value.absolutePath !== first.absolutePath || value.version !== first.version) failed('FILE_CHANGED', '文件在读取过程中发生变化，请重新打开。');
    if (value.offset !== start + total || data.byteLength > length) failed('FILE_INVALID_RESPONSE', '远端返回的文件范围不匹配。');
    if (!data.byteLength && !value.eof) failed('FILE_INVALID_RESPONSE', '远端文件读取没有继续前进，请重试。');
    if (value.eof && Number.isSafeInteger(value.bytes) && start + total + data.byteLength < value.bytes) failed('FILE_INVALID_RESPONSE', '远端文件提前结束，未返回不完整文件。');
    chunks.push(data); total += data.byteLength; last = value;
    if (value.eof) break;
  }
  if (!range && !last?.eof) failed('FILE_TOO_LARGE', '远端文件超过单次加载上限，未返回不完整文件。');
  const data = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
  return { ok: true, value: { ...first, offset: start, data, eof: last.eof } };
}

// Remote 0.6.5 does not expose the current officeKit namespace. Use the local
// installed converter on authorized bytes without launching an application or
// writing the source. The existing native PDF renderer displays the result.
export async function renderRemoteOffice(channel, args, signal, officeKit) {
  if (!officeKit) failed('OFFICE_UNAVAILABLE', '本机 Office 预览服务不可用，可以下载原文件。');
  const metadata = await channel.call('workspaceFiles/stat', { args: { workspaceFileScopeId: args.workspaceFileScopeId, path: args.path } }, signal);
  if (!metadata.ok) return metadata;
  const extension = args.path.split('.').at(-1).toLowerCase();
  if (!['doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx'].includes(extension)) failed('OFFICE_UNSUPPORTED', '这个文件类型不支持 Office 预览。');
  const source = metadata.value;
  const rendered = await officeKit.convert({ extension, priority: args.priority || 'foreground', source: {
    key: JSON.stringify([channel.hostId, args.workspaceFileScopeId, source.absolutePath]), version: source.version, bytes: source.bytes,
    async read(active, maxBytes) {
      const result = await readRemoteFile(channel, { workspaceFileScopeId: args.workspaceFileScopeId, path: args.path }, active, Math.min(maxBytes, REMOTE_FILE_MAX_BYTES));
      if (!result.ok) failed(result.error.code, result.error.message);
      if (result.value.version !== source.version) failed('FILE_CHANGED', '文件已变化，请重新预览。');
      return { bytes: result.value.data, version: result.value.version };
    },
  } }, signal);
  const data = rendered.pdf;
  if (!(data instanceof Uint8Array)) failed('OFFICE_INVALID_RESPONSE', 'Office 预览没有返回 PDF 内容。');
  return { ok: true, value: { ...source, bytes: data.byteLength, offset: 0, data, eof: true, missingFonts: rendered.missingFonts || [], generation: rendered.generation } };
}
