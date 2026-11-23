import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fixture } from './database-fixture.mjs'

function setup(t, fetch, globals = {}) {
    const f = fixture(t, { initialize: false, fetch, globals: { AbortController, ...globals } })
    return f.load('lib/oauth-login')
}
const authorization = 'https://connect.linux.do/oauth2/authorize?client_id=isolated-client'
const success = path => Response.json(path.endsWith('/csrf') ? { csrfToken: 'isolated-csrf' } : { url: authorization })

test('known OAuth providers sign in without querying provider metadata and retain the product return address', async t => {
    const calls = []
    const f = setup(t, async (path, options) => {
        assert.notEqual(path, '/api/auth/providers')
        calls.push({ path, options })
        return success(path)
    })
    assert.equal(await f.startOAuthLogin('linuxdo', '/buy/product?quantity=2', 'https://shop.example'), authorization)
    assert.deepEqual(calls.map(call => call.path), ['/api/auth/csrf', '/api/auth/signin/linuxdo'])
    for (const { options } of calls) {
        assert.equal(options.credentials, 'same-origin')
        assert.equal(options.cache, 'no-store')
        assert.equal(options.redirect, 'manual')
    }
    const post = calls[1].options
    assert.equal(post.method, 'POST')
    assert.equal(post.headers['X-Auth-Return-Redirect'], '1')
    assert.equal(post.body.get('csrfToken'), 'isolated-csrf')
    assert.equal(post.body.get('callbackUrl'), '/buy/product?quantity=2')
})

test('temporary CSRF network and HTTP failures retry once while sign-in POST executes once', async t => {
    for (const failure of ['network', 'http']) {
        let reads = 0, posts = 0
        const f = setup(t, async path => {
            if (path.endsWith('/csrf') && ++reads === 1) {
                if (failure === 'network') throw new Error('Isolated network failure')
                return new Response(null, { status: 503 })
            }
            if (!path.endsWith('/csrf')) posts++
            return success(path)
        })
        assert.equal(await f.startOAuthLogin('linuxdo', '/', 'https://shop.example'), authorization)
        assert.equal(reads, 2)
        assert.equal(posts, 1)
    }
})

test('a failed sign-in POST is never repeated automatically and raw errors are not exposed', async t => {
    let posts = 0
    const f = setup(t, async path => {
        if (path.endsWith('/csrf')) return success(path)
        posts++
        return new Response('PRIVATE-PROVIDER-ERROR', { status: 500 })
    })
    await assert.rejects(f.startOAuthLogin('linuxdo', '/', 'https://shop.example'), error => error.code === 'login.requestFailed' && !error.message.includes('PRIVATE'))
    assert.equal(posts, 1)
})

test('blocked CSRF requests stop without retry or sign-in, and malformed replies never authorize', async t => {
    let calls = 0
    const blocked = setup(t, async () => { calls++; return new Response(null, { status: 403 }) })
    await assert.rejects(blocked.startOAuthLogin('linuxdo', '/', 'https://shop.example'), error => error.code === 'login.requestBlocked')
    assert.equal(calls, 1)
    const missing = setup(t, async () => Response.json({}))
    await assert.rejects(missing.startOAuthLogin('linuxdo', '/', 'https://shop.example'), error => error.code === 'login.sessionCheckFailed')
})

test('CSRF timeouts abort both bounded attempts without issuing sign-in', async t => {
    let calls = 0
    const f = setup(t, async (path, options) => {
        assert.equal(path, '/api/auth/csrf'); calls++
        return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Timeout', 'AbortError')), { once: true }))
    }, { setTimeout: callback => setTimeout(callback, 5) })
    await assert.rejects(f.startOAuthLogin('linuxdo', '/', 'https://shop.example'), error => error.code === 'login.timedOut')
    assert.equal(calls, 2)
})

test('provider errors remain on the login page and authorization destinations are validated', async t => {
    for (const [url, code] of [
        ['https://shop.example/api/auth/error?error=Configuration', 'login.configurationFailed'],
        ['https://shop.example/login?error=MissingCSRF', 'login.sessionCheckFailed'],
        ['https://other.example/oauth2/authorize', 'login.invalidResponse'],
        ['https://connect.linux.do/other-path', 'login.invalidResponse'],
    ]) {
        const f = setup(t, async path => path.endsWith('/csrf') ? success(path) : Response.json({ url }))
        await assert.rejects(f.startOAuthLogin('linuxdo', '/', 'https://shop.example'), error => error.code === code)
    }
})

test('external callback addresses return to the shop and GitHub uses its own authorization endpoint', async t => {
    const f = setup(t, async (path, options) => {
        if (path.endsWith('/csrf')) return success(path)
        assert.equal(path, '/api/auth/signin/github')
        assert.equal(options.body.get('callbackUrl'), '/')
        return Response.json({ url: 'https://github.com/login/oauth/authorize?client_id=isolated-client' })
    })
    assert.equal(await f.startOAuthLogin('github', 'https://other.example/buy/product', 'https://shop.example'), 'https://github.com/login/oauth/authorize?client_id=isolated-client')
})
