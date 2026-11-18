// Version-scoped native model-directory adapter. The original ModelDirectory
// instance, its store and both native menu entries are preserved. Only its
// previously Host-global catalog is rebound to the owning Session.
export function installSessionModels(service, carrier, signal) {
  const original = service.directoryFor, catalogs = new Map();
  function ownerOf(sessionId) {
    if (!sessionId.startsWith('dsh-peer:')) return carrier.baseHost;
    const tuple = JSON.parse(sessionId.slice(9));
    return tuple[0];
  }
  function catalogFor(sessionId) {
    const hostId = ownerOf(sessionId);
    let catalog = catalogs.get(hostId);
    if (catalog) return catalog;
    let value = { value: null, status: 'idle', error: null }, inflight;
    const listeners = new Set();
    const publish = next => { value = next; for (const listener of listeners) listener(); };
    catalog = {
      store: { getSnapshot: () => value, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } },
      invalidate() { publish({ ...value, status: 'idle' }); },
      reasoningFor(selection) { return value.value?.groups.find(group => group.id === selection.provider)?.models.find(model => model.id === selection.model)?.reasoning; },
      load() {
        if (value.status === 'ready') return Promise.resolve(value.value);
        if (inflight) return inflight;
        publish({ ...value, status: 'loading', error: null });
        inflight = carrier.modelCatalog(sessionId, signal).then(result => {
          if (!result.ok) throw new Error(result.error.message);
          signal?.throwIfAborted();
          publish({ value: result.value, status: 'ready', error: null }); return result.value;
        }).catch(error => { if (!signal?.aborted) publish({ ...value, status: 'error', error: error.message }); throw error; }).finally(() => { inflight = undefined; });
        return inflight;
      },
    };
    catalogs.set(hostId, catalog); return catalog;
  }
  const patched = new Map();
  const wrap = directory => {
    if (patched.has(directory)) return directory;
    if (!directory?.catalog?.store || typeof directory.syncInputs !== 'function' || !directory.sessionId) throw new Error('Native model directory version is unsupported');
    const previous = directory.catalog, next = catalogFor(directory.sessionId);
    directory.unsubscribeCatalog(); directory.catalog = next;
    directory.unsubscribeCatalog = next.store.subscribe(() => directory.syncInputs());
    directory.syncInputs();
    patched.set(directory, { previous, next });
    return directory;
  };
  for (const directory of service.live?.directories?.values || []) wrap(directory);
  function directoryFor(...args) { return wrap(original.apply(this, args)); }
  service.directoryFor = directoryFor;
  const dispose = () => {
    if (service.directoryFor === directoryFor) service.directoryFor = original;
    for (const [directory, { previous, next }] of patched) {
      if (directory.catalog !== next || directory.disposed) continue;
      directory.unsubscribeCatalog(); directory.catalog = previous;
      directory.unsubscribeCatalog = previous.store.subscribe(() => directory.syncInputs()); directory.syncInputs();
    }
    patched.clear(); catalogs.clear();
  };
  dispose.refresh = hostId => {
    for (const [owner, catalog] of catalogs) {
      if (hostId !== undefined && owner !== hostId) continue;
      catalog.invalidate(); void catalog.load().catch(() => {});
    }
  };
  return dispose;
}
