export function createHealthState(check, signal) {
  let snapshot = { open: false, busy: false }, control, task, disposed = false, lastArgs = {};
  const listeners = new Set();
  const publish = value => { snapshot = value; for (const listener of listeners) listener(); };
  const close = () => { control?.abort(); control = undefined; task = undefined; publish({ open: false, busy: false }); };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    run(args = lastArgs) {
      if (disposed || signal?.aborted) return Promise.resolve();
      if (task) return task;
      lastArgs = args;
      control?.abort(); const current = new AbortController(); control = current;
      publish({ ...snapshot, open: true, busy: true, error: false });
      task = (async () => {
        try { const report = await check(args, AbortSignal.any([current.signal, ...signal ? [signal] : []])); if (!current.signal.aborted && !disposed) publish({ open: true, busy: false, report }); }
        catch { if (!current.signal.aborted && !disposed) publish({ ...snapshot, open: true, busy: false, error: true }); }
        finally { if (control === current) task = undefined; }
      })();
      return task;
    },
    close,
    dispose() { disposed = true; close(); listeners.clear(); },
  };
}
export function healthRows(report, t) {
  const rows = [];
  const add = (computer, checks) => {
    for (const check of checks || []) {
      const issue = check.issue?.reason;
      const hint = issue ? t('connection' + issue[0].toUpperCase() + issue.slice(1))
        : check.id === 'terminal' && check.state !== 'pass' ? t('checkTerminalHint')
        : check.id === 'childStop' && check.state !== 'pass' ? t('checkChildStopHint')
        : check.expected && check.state !== 'pass' ? t('checkVersionHint', { expected: check.expected })
        : check.state === 'unknown' ? t('checkNotProbed') : '';
      rows.push({ computer, id: check.id, state: check.state, label: t('check' + check.id[0].toUpperCase() + check.id.slice(1)), actual: check.actual || '', hint });
    }
  };
  add(t('checkLocalComputer'), report?.local?.checks);
  if (report?.discovery?.state === 'fail') add(t('checkLocalComputer'), [{ id: 'discovery', state: 'fail', issue: report.discovery }]);
  for (const host of report?.hosts || []) add(host.name || host.hostId, host.checks);
  return rows;
}
export function healthComponent(React, state, t, sessionForHost) {
  const buttonStyle = { color: 'inherit', background: 'transparent', border: '1px solid var(--dsw-alias-border-l3)', borderRadius: 6, padding: '4px 8px', font: 'inherit', cursor: 'pointer' };
  return function RemoteHealth() {
    const view = React.useSyncExternalStore(state.subscribe, state.getSnapshot);
    const button = (label, onClick, disabled = false, extra = {}) => React.createElement('button', { type: 'button', style: buttonStyle, disabled, onClick, ...extra }, label);
    return React.createElement('section', { 'aria-label': t('checkTitle'), style: { flexShrink: 0, padding: '6px 10px', color: 'var(--dsw-alias-label-primary)', font: 'inherit', borderBottom: '1px solid var(--dsw-alias-border-l3)' } },
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
        button(t('checkTitle'), () => { if (view.open) state.close(); else void state.run({}); }, false, { 'aria-expanded': view.open }),
        view.open && button(t('close'), () => state.close())),
      view.open && React.createElement('div', { 'aria-busy': view.busy, style: { maxHeight: '40vh', overflow: 'auto', marginTop: 8, overflowWrap: 'anywhere' } },
        React.createElement('p', { style: { margin: '4px 0' } }, t('checkHint')),
        view.busy && React.createElement('p', { role: 'status' }, t('checkRunning')),
        view.error && React.createElement('p', { role: 'alert' }, t('checkFailed')),
        ...healthRows(view.report, t).map((row, index) => React.createElement('div', { key: index, style: { padding: '4px 0' } },
          React.createElement('div', null, `${row.computer} · ${row.label}：${t('checkState' + row.state)}${row.actual ? ' (' + row.actual + ')' : ''}`),
          row.hint && React.createElement('small', null, row.hint))),
        ...(view.report?.hosts || []).map(host => React.createElement('div', { key: host.hostId, style: { padding: '4px 0' } }, button(t('checkHost', { computer: host.name || host.hostId }), () => { const sessionId = sessionForHost(host.hostId); void state.run({ hostId: host.hostId, ...(sessionId ? { sessionId } : {}) }); }, view.busy || !host.online))),
        button(t('retry'), () => { void state.run(); }, view.busy)));
  };
}
