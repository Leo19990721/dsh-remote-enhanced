// Adapted from ds-harness-remote 0.6.5 dist/loopback-preview.js (MIT).
// Copyright (c) 2026 DSH Remote contributors. See REMOTE-LICENSE.txt.
// Dependency injection and actionable error feedback;
// Host/Origin guards, HTTP limits and WebSocket transfer semantics are retained.
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const LOOPBACK_MAX_BODY_BYTES = 1024 * 1024, LOOPBACK_MAX_WS_BYTES = 256 * 1024;
import { cleanHeaders, headerPairs } from './federated-preview-headers.js';
class RpcError extends Error { constructor(code, message) { super(message); this.code = code; } }
/** One unpredictable origin per upstream port. Only the local machine can reach this listener. */
export class LoopbackPreview {
    client;
    servers = new Map();
    sockets = new Set();
    handles = new Set();
    releases = new Map();
    lifetime = new AbortController();
    constructor(client, WebSocketServer, { onFailure = () => {}, onFileRequest } = {}) {
        this.client = client; this.WebSocketServer = WebSocketServer; this.onFailure = onFailure; this.onFileRequest = onFileRequest;
    }
    async open(port) {
        if (!Number.isInteger(port) || port < 1024 || port > 65535)
            throw new RpcError('INVALID_MESSAGE', 'Enter a port between 1024 and 65535.');
        this.lifetime.signal.throwIfAborted();
        const description = await this.client.rpc('loopback.call', { op: 'describe' }, this.lifetime.signal);
        if (!description.ports.includes(port))
            throw new RpcError('LOOPBACK_PORT_DENIED', 'Allow this port in the Host Remote settings (loopback.ports), then save the access settings. / 请在 Host Remote 设置中允许此端口，然后保存访问设置。');
        let pending = this.servers.get(port);
        if (pending === undefined) {
            if (this.servers.size >= 16)
                throw new RpcError('RATE_LIMITED', 'Too many preview origins.');
            pending = this.start(port);
            this.servers.set(port, pending);
            void pending.catch(() => { this.servers.delete(port); });
        }
        return { url: (await pending).url };
    }
    close() {
        if (!this.closing) this.closing = this.closeAll();
        return this.closing;
    }
    async closeAll() {
        const releasing = [...this.handles].map(id => this.release(id));
        this.lifetime.abort();
        const closingSockets = [...this.sockets].map(socket => new Promise(resolve => {
            socket.once('close', resolve); socket.destroy();
        }));
        for (const pending of this.servers.values()) {
            const running = await pending.catch(() => undefined);
            if (running === undefined)
                continue;
            for (const client of running.ws.clients)
                client.terminate();
            running.ws.close();
            running.server.closeAllConnections();
            await new Promise(resolve => running.server.close(() => resolve()));
        }
        this.servers.clear();
        await Promise.all([...closingSockets, ...releasing, ...this.releases.values()]);
    }
    async start(port) {
        const hostname = `dsh-${randomBytes(24).toString('hex')}.localhost`;
        let authority = '';
        const accepted = (req) => req.headers.host === authority
            && (req.headers.origin === undefined || req.headers.origin === `http://${authority}`)
            && req.headers['service-worker'] === undefined;
        const server = createServer((req, res) => {
            if (!accepted(req)) {
                res.writeHead(403);
                res.end('Preview origin denied.');
                return;
            }
            // Only the explicitly opted-in map occurrence changes /open. Never
            // fall through to the upstream OS action, even on invalid input.
            if (this.onFileRequest && new URL(req.url || '/', 'http://preview.invalid').pathname === '/open') {
                void this.fileRequest(authority, req, res); return;
            }
            void this.http(port, authority, req, res);
        });
        server.requestTimeout = 30_000;
        server.headersTimeout = 15_000;
        server.maxHeadersCount = 64;
        server.on('connection', socket => {
            if (this.sockets.size >= 64 || this.lifetime.signal.aborted) {
                socket.destroy();
                return;
            }
            this.sockets.add(socket);
            socket.on('close', () => this.sockets.delete(socket));
        });
        const selectedProtocols = new WeakMap();
        const ws = new this.WebSocketServer({ noServer: true, maxPayload: LOOPBACK_MAX_WS_BYTES, perMessageDeflate: false,
            handleProtocols: (_protocols, req) => selectedProtocols.get(req) || false });
        server.on('upgrade', (req, socket, head) => {
            if (!accepted(req)) {
                socket.destroy();
                return;
            }
            const id = randomUUID(); this.handles.add(id);
            const headers = this.headers(req, port);
            const protocols = (req.headers['sec-websocket-protocol'] ?? '').split(',').map(item => item.trim()).filter(Boolean);
            void this.client.rpc('loopback.call', { op: 'ws.open', id, port, path: req.url ?? '/', headers, protocols }, this.lifetime.signal)
                .then(result => {
                if (socket.destroyed || this.lifetime.signal.aborted) {
                    socket.destroy();
                    void this.release(id);
                    return;
                }
                selectedProtocols.set(req, result.protocol);
                ws.handleUpgrade(req, socket, head, local => this.websocket(id, local));
            }).catch(() => { socket.destroy(); void this.release(id); });
        });
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
        });
        const address = server.address();
        if (address === null || typeof address === 'string') {
            server.close();
            throw new Error('Preview listener unavailable');
        }
        authority = `${hostname}:${address.port}`;
        if (this.lifetime.signal.aborted) {
            server.close();
            ws.close();
            throw new Error('Preview closed');
        }
        return { server, ws, url: `http://${authority}/` };
    }
    async fileRequest(authority, req, res) {
        const reply = (status, error) => {
            if (res.destroyed) return;
            res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
            res.end(JSON.stringify({ error }));
        };
        if (req.url !== '/open' || req.method !== 'POST' || req.headers.origin !== `http://${authority}` || req.headers['content-type'] !== 'application/json') {
            req.resume(); reply(403, '请从 DSH 中的远端网页选择文件。'); return;
        }
        try {
            const chunks = []; let bytes = 0;
            for await (const chunk of req) {
                bytes += chunk.length;
                if (bytes > 8192) { req.resume(); reply(413, '文件路径过长。'); return; }
                chunks.push(chunk);
            }
            const result = this.onFileRequest(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            reply(result.status, result.error);
        } catch { reply(400, '文件请求无效，请重新点击文件。'); }
    }
    headers(req, port) {
        return cleanHeaders(headerPairs(req.headers)).filter(([name]) => !['origin', 'referer'].includes(name.toLowerCase()))
            .concat(req.headers.origin === undefined ? [] : [['origin', `http://127.0.0.1:${port}`]]);
    }
    async http(port, authority, req, res) {
        const id = randomUUID(); this.handles.add(id);
        const controller = new AbortController();
        const abort = () => { controller.abort(); void this.release(id); };
        res.once('close', abort);
        const signal = AbortSignal.any([controller.signal, this.lifetime.signal]);
        const startedAt = Date.now(); let phase = 'request', bytes = 0, chunksRead = 0;
        try {
            const chunks = [];
            let length = 0;
            for await (const chunk of req) {
                length += chunk.length;
                if (length > LOOPBACK_MAX_BODY_BYTES)
                    throw new RpcError('PAYLOAD_TOO_LARGE', 'Preview request body is limited to 1 MiB.');
                chunks.push(chunk);
            }
            phase = 'http.open';
            const head = await this.client.rpc('loopback.call', { op: 'http.open', id, port,
                path: req.url ?? '/', method: req.method ?? 'GET', headers: this.headers(req, port),
                ...(length === 0 ? {} : { body: Buffer.concat(chunks).toString('base64') }) }, signal);
            phase = 'headers';
            const headers = {};
            for (let [name, value] of cleanHeaders(head.headers)) {
                name = name.toLowerCase();
                if (name === 'location') {
                    const url = new URL(value, `http://127.0.0.1:${port}/`);
                    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || Number(url.port || 80) !== port || url.protocol !== 'http:') {
                        throw new Error('Redirect is outside the authorized preview service');
                    }
                    value = `http://${authority}${url.pathname}${url.search}${url.hash}`;
                }
                if (name === 'set-cookie') {
                    // Each preview has a separate cookie host; never widen cookies to .localhost.
                    value = value.replace(/;\s*domain=[^;]*/ig, '');
                    const existing = headers[name];
                    headers[name] = [...(Array.isArray(existing) ? existing : []), value];
                }
                else if (!['service-worker-allowed', 'clear-site-data', 'alt-svc'].includes(name))
                    headers[name] = value;
            }
            headers['referrer-policy'] = 'no-referrer';
            res.writeHead(head.status, headers);
            if (req.method === 'HEAD') { res.end(); return; }
            while (!signal.aborted) {
                phase = 'http.read';
                const chunk = await this.client.rpc('loopback.call', { op: 'http.read', id }, signal);
                const data = Buffer.from(chunk.data, 'base64'); bytes += data.length; chunksRead++;
                phase = 'response';
                if (data.length && !res.write(data)) {
                    await new Promise((resolve, reject) => {
                        const ready = () => { cleanup(); resolve(); };
                        const closed = () => { cleanup(); reject(new Error('closed')); };
                        const cleanup = () => { res.off('drain', ready); res.off('close', closed); };
                        res.once('drain', ready);
                        res.once('close', closed);
                    });
                }
                if (chunk.done)
                    break;
            }
            res.end();
        }
        catch (error) {
            if (!signal.aborted) {
                const code = /^[A-Za-z0-9_./-]{1,100}$/.test(error?.code || '') ? error.code : 'UNAVAILABLE';
                const errorType = /^[A-Za-z]{1,60}$/.test(error?.name || '') ? error.name : 'Error';
                const frames = [...String(error?.stack || '').matchAll(/([A-Za-z0-9_.-]+\.(?:m?js|cjs):\d+:\d+)/g)].slice(0, 4).map(match => match[1]);
                try { this.onFailure({ port, phase, code, errorType, frames, bytes, chunks: chunksRead, headersSent: res.headersSent, durationMs: Date.now() - startedAt }); } catch {}
            }
            if (!res.headersSent) {
                res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
                const message = error?.code === 'LOOPBACK_PORT_DENIED'
                    ? `远端电脑尚未允许网页端口 ${port}。请在那台电脑已登录的 DSH Remote 设置中允许此端口并保存，然后回到这里刷新。`
                    : error?.code === 'LOOPBACK_UNAVAILABLE'
                        ? `远端电脑的网页服务未响应端口 ${port}。请在那台电脑启动对应网页服务，然后回到这里刷新。`
                        : `远端网页暂不可用。请检查那台电脑的 Remote 连接以及端口 ${port} 的网页服务，然后刷新。`;
                res.end(message);
            }
            else
                res.destroy();
        }
        finally {
            res.off('close', abort);
            await this.release(id);
        }
    }
    websocket(id, socket) {
        let input = Promise.resolve();
        let queued = 0;
        let count = 0;
        const controller = new AbortController();
        const signal = AbortSignal.any([controller.signal, this.lifetime.signal]);
        const close = () => { controller.abort(); socket.terminate(); void this.release(id); };
        socket.on('error', close);
        socket.on('close', close);
        socket.on('message', (data, binary) => {
            const bytes = Buffer.from(data);
            queued += bytes.length;
            count += 1;
            if (queued > 1024 * 1024 || count > 256) {
                close();
                return;
            }
            input = input.then(async () => {
                await this.client.rpc('loopback.call', { op: 'ws.send', id, data: bytes.toString('base64'), binary }, signal);
                queued -= bytes.length;
                count -= 1;
            }).catch(close);
        });
        void (async () => {
            try {
                while (!signal.aborted) {
                    const result = await this.client.rpc('loopback.call', { op: 'ws.read', id }, signal);
                    for (const message of result.messages) {
                        if (socket.bufferedAmount > 1024 * 1024)
                            throw new Error('slow preview');
                        await new Promise((resolve, reject) => socket.send(Buffer.from(message.data, 'base64'), { binary: message.binary }, error => error ? reject(error) : resolve()));
                    }
                    if (result.closed)
                        break;
                }
            }
            catch { /* Closed channels must not reconnect or replay application messages. */ }
            finally {
                close();
            }
        })();
    }
    release(id) {
        if (this.releases.has(id)) return this.releases.get(id);
        if (!this.handles.delete(id)) return Promise.resolve();
        // Closing is an idempotent cleanup command, not an application replay.
        // Give it its own bounded signal so aborting page reads cannot suppress
        // release of the corresponding remote HTTP/WS handle.
        const deadline = AbortSignal.timeout(3000);
        const pending = Promise.resolve().then(() => {
            const operation = this.client.rpc('loopback.call', { op: 'close', id }, deadline);
            return new Promise(resolve => {
                const ended = () => { deadline.removeEventListener('abort', ended); resolve(); };
                deadline.addEventListener('abort', ended, { once: true });
                Promise.resolve(operation).then(ended, ended);
                if (deadline.aborted) ended();
            });
        }).catch(() => undefined).finally(() => this.releases.delete(id));
        this.releases.set(id, pending);
        return pending;
    }
}
