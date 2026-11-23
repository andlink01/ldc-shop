import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync, chmodSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import { encode } from 'next-auth/jwt'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const secret = 'isolated-native-production-auth-secret'
export const nativeMerchantKey = 'isolated-native-production-merchant-key'
const inventoryKey = 'isolated-native-production-inventory-key'

async function listen(server) {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    return server.address().port
}

export async function dockerProductionFixture(t, { provider, legacySql } = {}) {
    const Database = require('better-sqlite3')
    const directory = mkdtempSync(path.join(tmpdir(), 'ldc-native-production-'))
    chmodSync(directory, 0o777)
    const databasePath = path.join(directory, 'production.sqlite')
    const seed = new Database(databasePath)
    if (legacySql) seed.exec(legacySql)
    seed.close()
    chmodSync(databasePath, 0o666)
    const calls = []
    const bridge = createServer(async (incoming, outgoing) => {
        try {
            const originalUrl = incoming.headers['x-test-provider-url']
            if (!originalUrl) { outgoing.writeHead(400); outgoing.end(); return }
            const chunks = []
            for await (const chunk of incoming) chunks.push(chunk)
            const headers = new Headers(incoming.headers)
            headers.delete('host'); headers.delete('x-test-provider-url')
            const request = new Request(originalUrl, { method: incoming.method, headers,
                ...(incoming.method === 'GET' || incoming.method === 'HEAD' ? {} : { body: Buffer.concat(chunks) }) })
            calls.push({ url: request.url, method: request.method })
            const host = new URL(request.url).hostname
            const response = await provider?.(request) ?? (host === 'api.telegram.org' ? Response.json({ ok: true })
                : host === 'api.day.app' ? Response.json({ code: 200 })
                : host === 'api.resend.com' ? Response.json({ id: 'native-test-email' })
                : new Response('External network disabled', { status: 503 }))
            outgoing.writeHead(response.status, Object.fromEntries(response.headers))
            outgoing.end(Buffer.from(await response.arrayBuffer()))
        } catch { outgoing.writeHead(503); outgoing.end() }
    })
    const bridgePort = await listen(bridge)
    const reservation = createServer()
    const port = await listen(reservation)
    await new Promise(resolve => reservation.close(resolve))
    const baseUrl = `http://127.0.0.1:${port}`
    const preload = path.join(directory, 'preload.mjs')
    writeFileSync(preload, `
        const nativeFetch = globalThis.fetch;
        globalThis.fetch = async (input, init) => {
            const request = new Request(input, init), url = new URL(request.url);
            // Freeze only the independent cron process in tests; manual requests
            // still execute the actual cleanup route, avoiding minute-boundary races.
            if (process.argv[1]?.endsWith('cron.mjs') && url.pathname === '/api/internal/cron/cleanup') return Response.json({success:true});
            if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return nativeFetch(input, init);
            const headers = new Headers(request.headers);
            headers.set('x-test-provider-url', request.url);
            return nativeFetch('http://127.0.0.1:${bridgePort}/provider', {method:request.method,headers,
                ...(request.method === 'GET' || request.method === 'HEAD' ? {} : {body:await request.arrayBuffer()}),
                signal:request.signal, redirect:'manual'});
        };
    `)
    const env = { ...process.env, NODE_ENV: 'production', PORT: String(port), HOSTNAME: '127.0.0.1',
        DATABASE_PATH: databasePath, NEXT_PUBLIC_APP_URL: baseUrl, APP_URL: baseUrl, AUTH_URL: baseUrl,
        AUTH_TRUST_HOST: 'true', AUTH_SECRET: secret, OAUTH_CLIENT_ID: 'native-test-client', OAUTH_CLIENT_SECRET: 'native-test-oauth',
        GITHUB_ID: '', GITHUB_SECRET: '', AUTH_GITHUB_ID: '', AUTH_GITHUB_SECRET: '', MERCHANT_ID: 'TEST-MERCHANT', MERCHANT_KEY: nativeMerchantKey,
        PAY_URL: 'https://credit.linux.do/epay/pay/submit.php', ADMIN_USERS: 'audit-admin', INVENTORY_API_KEY: inventoryKey,
        CRON_CLEANUP_TOKEN: 'native-test-cron', NEXT_TELEMETRY_DISABLED: '1', NODE_OPTIONS: `--import=${pathToFileURL(preload)}` }
    const image = process.env.LDC_DOCKER_TEST_IMAGE
    const containerName = `ldc-native-test-${crypto.randomUUID()}`
    let child, database, logs = '', startupError = false
    const running = () => Boolean(child?.pid) && !startupError && child.exitCode === null && child.signalCode === null
    const stop = async () => {
        if (image) {
            try { execFileSync('docker', ['stop', '--time', '3', containerName], { timeout: 15000, stdio: 'pipe', windowsHide: true }) } catch { /* Already stopped. */ }
        }
        if (running()) {
            child.kill('SIGTERM')
            await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 3000))])
            if (running()) {
                child.kill('SIGKILL')
                await new Promise(resolve => child.once('exit', resolve))
            }
        }
    }
    t.after(async () => {
        await stop()
        database?.close()
        bridge.closeAllConnections()
        await new Promise(resolve => bridge.close(resolve))
        const target = path.resolve(directory), base = path.resolve(tmpdir()) + path.sep
        if (!target.startsWith(base) || !path.basename(target).startsWith('ldc-native-production-')) throw new Error('Unexpected test directory')
        rmSync(target, { recursive: true, force: true })
    })
    const request = (pathname, init) => fetch(baseUrl + pathname, init)
    const start = async () => {
        startupError = false
        if (image) {
            const selected = Object.entries(env).filter(([name]) => ['NODE_ENV', 'PORT', 'HOSTNAME', 'DATABASE_PATH', 'NEXT_PUBLIC_APP_URL', 'APP_URL', 'AUTH_URL', 'AUTH_TRUST_HOST', 'AUTH_GITHUB_ID', 'AUTH_GITHUB_SECRET',
                'AUTH_SECRET', 'OAUTH_CLIENT_ID', 'OAUTH_CLIENT_SECRET', 'GITHUB_ID', 'GITHUB_SECRET', 'MERCHANT_ID', 'MERCHANT_KEY', 'PAY_URL', 'ADMIN_USERS',
                'INVENTORY_API_KEY', 'CRON_CLEANUP_TOKEN', 'NEXT_TELEMETRY_DISABLED', 'NODE_OPTIONS'].includes(name))
            const values = Object.fromEntries(selected)
            values.DATABASE_PATH = '/audit/production.sqlite'; values.NODE_OPTIONS = '--import=/audit/preload.mjs'
            child = spawn('docker', ['run', '--rm', '--name', containerName, '--network', 'host', '--mount', `type=bind,source=${directory},target=/audit`,
                ...Object.entries(values).flatMap(([name, value]) => ['--env', `${name}=${value}`]), image], { cwd: root, windowsHide: true })
        } else {
            const server = path.join(root, '.next/standalone/server.js')
            assert.ok(existsSync(server), 'Build Docker Next.js standalone output before running production tests')
            // Assemble the same static assets as the Dockerfile.
            cpSync(path.join(root, '.next/static'), path.join(root, '.next/standalone/.next/static'), { recursive: true })
            if (existsSync(path.join(root, 'public'))) cpSync(path.join(root, 'public'), path.join(root, '.next/standalone/public'), { recursive: true })
            child = spawn(process.execPath, [server], { cwd: path.dirname(server), env, windowsHide: true })
        }
        child.stdout.on('data', chunk => { logs += chunk.toString() })
        child.stderr.on('data', chunk => { logs += chunk.toString() })
        child.on('error', error => { startupError = true; logs += error.message })
        let ready = false, lastProbe = 'No readiness response'
        for (let attempt = 0; attempt < 180; attempt++) {
            try {
                const response = await request('/api/v1/products', { headers: { Authorization: `Bearer ${inventoryKey}`, Connection: 'close' }, signal: AbortSignal.timeout(2000) })
                const body = await response.text()
                if (response.status === 200) { ready = true; break }
                lastProbe = `HTTP ${response.status}: ${body.slice(0, 300)}`
                logs += body.slice(0, 300)
            } catch (error) { lastProbe = `${error.message}: ${error.cause?.code || ''}` }
            if (!running()) break
            await new Promise(resolve => setTimeout(resolve, 250))
        }
        assert.equal(ready, true, lastProbe + '\n' + logs.slice(-6000))
    }
    await start()
    database = new Database(databasePath)
    database.pragma('journal_mode = WAL')
    database.pragma('foreign_keys = ON')
    const sql = { prepare(statement) { return { bind(...params) { return {
        run: async () => database.prepare(statement).run(...params),
        all: async () => ({ results: database.prepare(statement).all(...params) }),
    } } } } }
    const cookie = async (id = 'owner', username = 'audit-admin', trustLevel = 3) => {
        const name = 'authjs.session-token'
        return `${name}=${await encode({ secret, salt: name, token: { id, username, name: username, trustLevel } })}`
    }
    // Each Next.js build can generate different Server Action identifiers. Read
    // the manifest from the running image when testing an independently built image.
    const manifest = image ? path.join(directory, 'server-reference-manifest.json') : path.join(root, '.next/server/server-reference-manifest.json')
    if (image) execFileSync('docker', ['cp', `${containerName}:/app/.next/server/server-reference-manifest.json`, manifest], { timeout: 15000, stdio: 'pipe', windowsHide: true })
    const actions = JSON.parse(readFileSync(manifest, 'utf8')).node
    const { encodeReply } = require('next/dist/compiled/react-server-dom-webpack/client.node')
    const action = async (name, pathname, args, sessionCookie) => {
        const id = Object.entries(actions).find(([, item]) => item.exportedName === name)?.[0]
        assert.ok(id, `Production action not found: ${name}`)
        const payload = await encodeReply(args)
        const encoded = new Request(baseUrl + pathname, { method: 'POST', body: payload })
        const response = await request(pathname, { method: 'POST', headers: { 'Next-Action': id, Origin: baseUrl,
            'Content-Type': encoded.headers.get('content-type'), ...(sessionCookie ? { Cookie: sessionCookie } : {}) }, body: await encoded.arrayBuffer() })
        const body = await response.text()
        const results = body.split('\n').flatMap(line => {
            const value = /^[\da-f]+:(\{.*)$/.exec(line)?.[1]
            if (!value) return []
            try { return [JSON.parse(value)] } catch { return [] }
        })
        return { status: response.status, body, result: results.find(result => typeof result.success === 'boolean' || typeof result.processed === 'boolean' || typeof result.reviewCount === 'number') }
    }
    return { database: sql, request, cookie, action, calls, baseUrl, restart: async () => { await stop(); await start() }, logs: () => logs, mode: image ? 'container' : 'standalone' }
}
