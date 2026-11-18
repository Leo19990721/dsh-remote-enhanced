// Minimal public registry contract for transport-focused tests. Installed-native
// acceptance uses the real TypertRegistry mounted by the installed Gateway.
export function carrierRegistry(endpoints = ['session/list', 'session/prompt', 'session/follow', 'session/rename']) {
  const descriptors = new Map(endpoints.map(endpoint => [endpoint, { namespace: endpoint.split('/')[0], method: endpoint.split('/')[1] }]));
  return { remotes: { get: endpoint => descriptors.get(endpoint), list: () => [...descriptors.values()] } };
}
