// Read-only inspection of installed generated API definitions, not live data.
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
(async () => {
  const r = createRequire(path.join(process.env.DSH_INSTALL_DIR, 'package.json'));
  const value = await import(pathToFileURL(r.resolve('@deepseek-ai/dsh-api-session-controller/remote')).href);
  for (const endpoint of ['session/prompt', 'session/follow', 'session/attachment', 'session/selectModel', 'session/create']) {
    const descriptor = value.default.descriptors.find(row => row.namespace + '/' + row.method === endpoint);
    console.log(JSON.stringify({ endpoint, parameters: descriptor.parameters.map(row => ({ wire: row.wire, schema: !!row.codec.jsonSchema, error: row.codec.jsonSchemaError, keys: Object.keys(row.codec.create().shape || {}) })) }));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
