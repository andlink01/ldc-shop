import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { Miniflare, Log, LogLevel } from 'miniflare'
import { encode } from 'next-auth/jwt'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const secret = 'isolated-production-audit-secret'
const inventoryKey = 'isolated-production-inventory-key'
const require = createRequire(import.meta.url)
const { encodeReply } = require('next/dist/compiled/react-server-dom-webpack/client.node')
let bundled
function productionBundle() {
    if (bundled) return bundled
    const directory = mkdtempSync(path.join(tmpdir(), 'ldc-production-worker-'))
    try {
        execFileSync(process.execPath, [path.join(path.dirname(require.resolve('wrangler/package.json')), 'bin', 'wrangler.js'), 'deploy', '--dry-run', '--outdir', directory], { cwd: root, stdio: 'pipe', timeout: 60_000 })
        bundled = readFileSync(path.join(directory, 'worker-entry.js'), 'utf8')
        return bundled
    } finally {
        const target = path.resolve(directory), base = path.resolve(tmpdir()) + path.sep
        if (!target.startsWith(base) || !path.basename(target).startsWith('ldc-production-worker-')) throw new Error('Unexpected test artifact directory')
        rmSync(target, { recursive: true, force: true })
    }
}

export async function productionFixture(t, { provider } = {}) {
    const build = path.join(root, '.open-next')
    if (!existsSync(path.join(build, 'worker.js'))) throw new Error('Build the OpenNext production worker before running this test')
    const modules = [{ path: path.join(root, 'production-audit-entry.mjs'), type: 'ESModule', contents: `
        import production from './worker-entry.mjs';
        import { interleaveSnapshotReads } from './d1-snapshot-fixture.mjs';
        export default { async fetch(request, env, ctx) {
            if (new URL(request.url).pathname === '/__audit/database') {
                const { sql, params, mode } = await request.json();
                return Response.json(await env.DB.prepare(sql).bind(...params)[mode]());
            }
            // Miniflare's dispatch transport replaces Host with its local listener. Restore the public host used at the Cloudflare edge.
            const url = new URL(request.url), headers = new Headers(request.headers);
            headers.set('host', url.host); headers.set('x-forwarded-host', url.host);
            headers.set('x-forwarded-proto', url.protocol.slice(0, -1));
            const callback = headers.get('x-test-interleave-callback');
            if (callback) {
                const trace = interleaveSnapshotReads(env.DB, async()=>{
                    const response = await production.fetch(new Request('https://shop.example' + callback, {headers:{host:'shop.example'}}), env, ctx);
                    if (response.status !== 200 || await response.text() !== 'success') throw new Error('Interleaved payment failed');
                });
                const response = await production.fetch(new Request(request, {headers}), {...env, DB:trace.database}, ctx);
                const resultHeaders = new Headers(response.headers);
                resultHeaders.set('x-test-interleaved', String(trace.didInterleave()));
                return new Response(response.body, {status:response.status, headers:resultHeaders});
            }
            if (headers.get('x-audit-profile') !== '1') return production.fetch(new Request(request, { headers }), env, ctx);
            // Test-only instrumentation: count statements without exposing SQL parameters or changing normal streaming responses.
            const stats = { total: 0, settings: 0, liveStock: 0 };
            const database = env.DB;
            const traced = { prepare(sql) {
                stats.total++;
                if (/^select [^()]* from [\"\x60]?settings[\"\x60]?/i.test(sql)) stats.settings++;
                if (/from [\"\x60]?cards[\"\x60]?/i.test(sql) && /sum.case when/i.test(sql) && /group by/i.test(sql)) stats.liveStock++;
                return database.prepare(sql);
            }, batch: database.batch.bind(database), exec: database.exec.bind(database), dump: database.dump.bind(database) };
            const response = await production.fetch(new Request(request, { headers }), { ...env, DB: traced }, ctx);
            const body = await response.arrayBuffer();
            const resultHeaders = new Headers(response.headers);
            resultHeaders.set('x-audit-queries', JSON.stringify(stats));
            return new Response(body, { status: response.status, headers: resultHeaders });
        }};
    ` }, { path: path.join(root, 'worker-entry.mjs'), type: 'ESModule', contents: productionBundle() },
    { path: path.join(root, 'd1-snapshot-fixture.mjs'), type: 'ESModule', contents: readFileSync(path.join(root, 'tests/d1-snapshot-fixture.mjs'), 'utf8') }]
    const calls = []
    const worker = new Miniflare({
        modules, modulesRoot: root, compatibilityDate: '2025-11-12', compatibilityFlags: ['nodejs_compat'],
        d1Databases: { DB: crypto.randomUUID() }, d1Persist: false,
        bindings: { AUTH_SECRET: secret, OAUTH_CLIENT_ID: 'isolated-production-linuxdo-client', OAUTH_CLIENT_SECRET: 'isolated-production-oauth', ADMIN_USERS: 'audit-admin', INVENTORY_API_KEY: inventoryKey,
            NEXT_PUBLIC_APP_URL: 'https://shop.example', MERCHANT_ID: 'TEST-MERCHANT', MERCHANT_KEY: 'isolated-production-merchant-key' },
        serviceBindings: { ASSETS: () => new Response('Not found', { status: 404 }) },
        outboundService: async request => {
            calls.push(request.url)
            const custom = await provider?.(request)
            if (custom) return custom
            const host = new URL(request.url).hostname
            if (host === 'api.telegram.org') return Response.json({ ok: true })
            if (host === 'api.day.app') return Response.json({ code: 200 })
            if (host === 'api.resend.com') return Response.json({ id: 'test-email' })
            return new Response('External network disabled', { status: 503 })
        }, log: new Log(LogLevel.ERROR),
    })
    t.after(() => worker.dispose())
    const database = { prepare(sql) { return { bind(...params) {
        const run = async mode => {
            const response = await worker.dispatchFetch('https://shop.example/__audit/database', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sql, params, mode }) })
            return response.json()
        }
        return { run: () => run('run'), all: () => run('all') }
    } } } }
    const cookie = async (id = 'owner', username = 'audit-admin', trustLevel = 3) => {
        const name = '__Secure-authjs.session-token'
        return `${name}=${await encode({ secret, salt: name, token: { id, username, name: username, trustLevel } })}`
    }
    const request = (pathname, init) => worker.dispatchFetch(`https://shop.example${pathname}`, {
        ...init, headers: { Host: 'shop.example', 'X-Forwarded-Host': 'shop.example', 'X-Forwarded-Proto': 'https', ...init?.headers },
    })
    const initialize = async () => {
        const response = await request('/api/v1/products', { headers: { Authorization: `Bearer ${inventoryKey}` } })
        if (response.status !== 200) throw new Error('Production inventory initialization failed')
        await response.text()
    }
    const profile = async (pathname, init) => {
        const response = await request(pathname, { ...init, headers: { ...init?.headers, 'X-Audit-Profile': '1' } })
        const html = await response.text()
        return { status: response.status, html, bytes: Buffer.byteLength(html), queries: JSON.parse(response.headers.get('x-audit-queries')) }
    }
    const actions = JSON.parse(readFileSync(path.join(root, '.next/server/server-reference-manifest.json'), 'utf8')).node
    const action = async (name, pathname, args, sessionCookie) => {
        const id = Object.entries(actions).find(([, item]) => item.exportedName === name)?.[0]
        if (!id) throw new Error(`Production action not found: ${name}`)
        const payload = await encodeReply(args)
        let body = payload, contentType = 'text/plain;charset=UTF-8'
        if (typeof payload !== 'string') {
            // Node and Miniflare use different fetch implementations. Serialize the
            // multipart form once, preserving its boundary and binary file content.
            const encoded = new Request('https://shop.example', { method: 'POST', body: payload })
            body = await encoded.arrayBuffer()
            contentType = encoded.headers.get('content-type')
        }
        const response = await request(pathname, { method: 'POST', headers: { 'Next-Action': id, Origin: 'https://shop.example',
            'Content-Type': contentType,
            ...(sessionCookie ? { Cookie: sessionCookie } : {}) }, body })
        const responseBody = await response.text()
        const objects = responseBody.split('\n').flatMap(line => {
            const json = /^[\da-f]+:(\{.*)$/.exec(line)?.[1]
            if (!json) return []
            try { return [JSON.parse(json)] } catch { return [] }
        })
        return { status: response.status, body: responseBody, result: objects.find(item => typeof item.success === 'boolean' || typeof item.processed === 'boolean' || typeof item.reviewCount === 'number') }
    }
    return { worker, database, request, cookie, calls, initialize, action, profile }
}
