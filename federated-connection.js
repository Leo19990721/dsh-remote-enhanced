// Stable, content-free categories shared by diagnostics and recovery. Upstream
// messages may contain paths or credentials and are never used as user guidance.
const guidance = {
  rateLimited: ['Remote 服务请求过多。', '请稍后重试，避免连续点击连接。', true],
  serviceUnavailable: ['Remote 服务暂时不可用。', '请稍后重试，保留当前登录和设备授权。', true],
  hostOffline: ['电脑当前离线。', '请在那台电脑打开 DSH，确认 Remote 在线后重试。', true],
  connectionTimeout: ['连接超时。', '请确认两边网络和远端 DSH 在线后重试。', true],
  authorizationRequired: ['Remote 登录或设备授权不可用。', '请打开原版 Remote 检查登录和设备授权，恢复后重试。', false],
  connectionInterrupted: ['远端连接已中断。', '正在按原流程恢复连接；已提交的操作不会自动重复执行。', true],
  connectionFailed: ['远端连接未能建立。', '请检查两边 Remote 在线状态和网络，再重试。', true],
};
function reasonOf(error) {
  const code = typeof error?.code === 'string' ? error.code.toUpperCase() : typeof error?.message === 'string' && /^[A-Z_]+$/.test(error.message) ? error.message : '';
  const status = error?.status ?? error?.statusCode;
  if (status === 429 || code === 'RATE_LIMITED') return 'rateLimited';
  if ([502, 503, 504].includes(status) || ['SERVICE_UNAVAILABLE', 'SERVER_UNAVAILABLE'].includes(code)) return 'serviceUnavailable';
  if (['HOST_OFFLINE', 'DEVICE_OFFLINE', 'TARGET_OFFLINE'].includes(code)) return 'hostOffline';
  if (status === 401 || status === 403 || /^(?:AUTHORIZATION_REVOKED|AUTHORIZATION_REQUIRED|AUTH_REQUIRED|NOT_AUTHENTICATED|LOGIN_REQUIRED|UNAUTHORIZED|FORBIDDEN|HOST_UNAUTHORIZED|GATEWAY\/FORBIDDEN)$/.test(code)) return 'authorizationRequired';
  if (/^(?:CONNECT_TIMEOUT|HEALTH_TIMEOUT|TIMEOUT|TIMED_OUT|RTC_CONNECT_TIMEOUT|GATEWAY\/TIMEOUT)$/.test(code) || error?.name === 'TimeoutError') return 'connectionTimeout';
  if (['GATEWAY/CANCELLED', 'CONNECTION_CLOSED', 'TRANSPORT_CLOSED', 'CONNECTION_NOT_FOUND', 'STREAM_ENDED'].includes(code)) return 'connectionInterrupted';
  if (['CONNECTION_FAILED', 'TRANSPORT_FAILED', 'CONNECT_FAILED', 'REMOTE_DISCOVERY_FAILED'].includes(code)) return 'connectionFailed';
}
export function connectionIssue(error) {
  const reason = reasonOf(error) || 'connectionFailed';
  const [message, action, retryable] = guidance[reason];
  return { reason, message, action, retryable };
}
export function retryableHostError(error) {
  return reasonOf(error) ? connectionIssue(error).retryable : !error?.isDSHRemoteError;
}
export function hostConnectionError(error, hostId, name, transport = false) {
  if (hostId === 'local' || !reasonOf(error) && !transport) return error;
  const issue = connectionIssue(error);
  const computer = String(name || hostId).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 120);
  const code = typeof error?.code === 'string' && /^[A-Za-z0-9_.:/-]{1,100}$/.test(error.code) ? error.code : 'UNAVAILABLE';
  return Object.assign(new Error(`${computer}：${issue.message}${issue.action}`, { cause: error }), {
    code, details: { hostId, computer, ...issue }, ...(error?.isDSHRemoteError ? { isDSHRemoteError: true } : {}),
  });
}
