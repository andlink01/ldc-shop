import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { productionFixture } from './production-fixture.mjs'
import { fixture as browserFixture } from './database-fixture.mjs'

async function setup(t, options) {
    const f = await productionFixture(t, options)
    await f.initialize()
    await f.database.prepare('INSERT INTO products (id, name, price, is_active) VALUES (?, ?, ?, 1)').bind('product', 'Production test product', '3').run()
    await f.database.prepare('INSERT INTO login_users (user_id, username, points) VALUES (?, ?, 20)').bind('owner', 'audit-admin').run()
    return { ...f, sessionCookie: await f.cookie() }
}

// Calls each administrator action of the deployed bundle over HTTP, as a visitor and as a signed-in buyer.
async function assertAdminSurfaceIsClosed(f) {
    const directory = new URL('../src/actions/', import.meta.url)
    const adminActions = readdirSync(directory).filter(name => name.endsWith('.ts')).flatMap(name => {
        const text = readFileSync(new URL(name, directory), 'utf8'), found = [...text.matchAll(/^export (?:async )?function (\w+)/gm)]
        return found.filter((match, index) => /await checkAdmin\(\)/.test(text.slice(match.index, found[index + 1]?.index ?? text.length))).map(match => match[1])
    })
    assert.ok(adminActions.length >= 70, 'administrator actions were not found')
    const digest = async () => JSON.stringify(await Promise.all(['orders', 'products', 'settings', 'cards', 'login_users'].map(async table =>
        (await f.database.prepare('SELECT * FROM ' + table + ' ORDER BY 1').bind().all()).results)))
    const buyer = await f.cookie('buyer-id', 'ordinary-buyer', 4)
    await f.request('/', { headers: { Cookie: buyer } })
    const before = await digest()
    for (const [who, cookie] of [['a visitor', undefined], ['a buyer', buyer]]) {
        for (const name of adminActions) {
            const response = await f.action(name, '/admin/orders', ['GUARDED', 'product', true, 1], cookie)
            assert.ok(!/"(?:success|processed|ok)":true/.test(response.body) && !response.body.includes('GUARDED-'), name + ' answered ' + who + ': ' + response.body.slice(0, 200))
        }
        for (const path of ['/admin/data/download?type=orders&format=csv&includeSecrets=1', '/admin/data/download?type=full&format=sql', '/admin/export/download?type=full&format=json',
            '/admin/orders', '/admin/orders/GUARDED', '/admin/cards/product', '/admin/users', '/admin/settings']) {
            for (const headers of [{}, { RSC: '1' }]) {
                const { response, body } = await requestPageData(f, path, { ...headers, ...(cookie ? { Cookie: cookie } : {}) })
                assert.ok(!body.includes('GUARDED-') && !body.includes('"cardKey"'), path + ' sent order data to ' + who)
                if (path.includes('/download')) assert.equal(response.status, 401, path)
            }
        }
        assert.equal(await digest(), before, 'the database changed for ' + who)
    }
    // The same requests succeed for the administrator, so the refusals above are not an artefact of the requests.
    const admin = await f.request('/admin/data/download?type=orders&format=csv&includeSecrets=1', { headers: { Cookie: f.sessionCookie } })
    assert.ok((await admin.text()).includes('GUARDED-'), 'the administrator must still be able to export')
    for (const headers of [{}, { RSC: '1' }]) {
        const page = await requestPageData(f, '/admin/orders/GUARDED', { ...headers, Cookie: f.sessionCookie })
        assert.ok(page.body.includes('GUARDED-'), 'the administrator must still receive the order')
    }
}

// A data request (RSC) is first redirected to the same page with the _rsc value Next expects; the data follows.
async function requestPageData(f, path, headers) {
    for (let hops = 0; ; hops++) {
        const response = await f.request(path, { redirect: 'manual', headers })
        const body = await response.text(), location = response.headers.get('location')
        const next = location ? new URL(location, 'http://shop.invalid') : null
        if (response.status !== 307 || !next || next.pathname !== path.split('?')[0] || hops >= 3) return { response, body }
        path = next.pathname + next.search
    }
}

function paymentCallbackPath(id) {
    const params = { pid: 'TEST-MERCHANT', out_trade_no: id, trade_no: 'production-test-trade', trade_status: 'TRADE_SUCCESS', money: '3.00', sign_type: 'MD5' }
    const sorted = Object.keys(params).filter(key => key !== 'sign_type').sort().map(key => `${key}=${params[key]}`).join('&')
    params.sign = createHash('md5').update(sorted + 'isolated-production-merchant-key').digest('hex')
    return `/api/notify?${new URLSearchParams(params)}`
}

async function pay(f, id) {
    const response = await f.request(paymentCallbackPath(id))
    assert.equal(response.status, 200)
    assert.equal(await response.text(), 'success')
}

test('storefront rendering batches public settings and stock reads without caching users, settings or inventory across requests', async t => {
    const f = await setup(t)
    for (let i = 0; i < 24; i++) await f.database.prepare('INSERT INTO products (id,name,price,description,product_images,variant_group_id,sort_order,created_at) VALUES (?,?,?,?,?,?,?,?)')
        .bind('perf-' + i, 'Performance product ' + i, '3', '**Searchable detail** ' + 'description '.repeat(40),
            JSON.stringify(Array.from({ length: 8 }, (_, n) => 'https://images.example/gallery-' + i + '-' + n + '.png')), i < 2 ? 'perf-group' : null, i, Date.now()).run()
    await f.database.prepare('INSERT INTO settings (key,value) VALUES (?,?), (?,?)').bind('shop_name', 'First public name', 'product_card_api_token:perf-0', 'PRIVATE-SUPPLIER-TOKEN').run()
    for (const pathname of ['/', '/buy/perf-0']) {
        await (await f.request(pathname)).text()
        const result = await f.profile(pathname)
        assert.equal(result.status, 200)
        assert.equal(result.queries.liveStock, 1)
        assert.ok(result.queries.total <= (pathname === '/' ? 8 : 5), JSON.stringify(result.queries))
        assert.ok(!result.html.includes('PRIVATE-SUPPLIER-TOKEN'))
        if (pathname === '/') {
            assert.ok(!result.html.includes('gallery-0-0.png'))
            assert.ok(result.html.includes('Searchable detail'))
        }
        t.diagnostic(JSON.stringify({ page: pathname, bytes: result.bytes, queries: result.queries }))
    }
    await f.database.prepare('UPDATE settings SET value = ? WHERE key = ?').bind('Changed public name', 'shop_name').run()
    const updated = await f.profile('/')
    assert.ok(updated.html.includes('Changed public name'))
    assert.ok(!updated.html.includes('First public name'))
    await f.database.prepare('INSERT INTO products (id,name,price,visibility_level) VALUES (?,?,?,?)').bind('private', 'PRIVATE-TRUST-PRODUCT', '3', 2).run()
    await f.database.prepare('INSERT INTO orders (order_id, product_id, product_name, amount, status, user_id, username, created_at) VALUES (?,?,?,?,?,?,?,?), (?,?,?,?,?,?,?,?)')
        .bind('OWNER-PENDING', 'product', 'Owner pending', '3', 'pending', 'owner', 'audit-admin', Date.now(),
            'OTHER-PENDING', 'product', 'Other pending', '3', 'pending', 'other', 'other-user', Date.now()).run()
    const [owner, other, anonymous] = await Promise.all([
        f.profile('/', { headers: { Cookie: f.sessionCookie } }),
        f.profile('/', { headers: { Cookie: await f.cookie('other', 'other-user') } }), f.profile('/'),
    ])
    assert.ok(owner.html.includes('OWNER-PENDING') && !owner.html.includes('OTHER-PENDING'))
    assert.ok(other.html.includes('OTHER-PENDING') && !other.html.includes('OWNER-PENDING'))
    assert.ok(!anonymous.html.includes('OWNER-PENDING') && !anonymous.html.includes('OTHER-PENDING'))
    assert.ok(owner.html.includes('PRIVATE-TRUST-PRODUCT'))
    assert.ok(!anonymous.html.includes('PRIVATE-TRUST-PRODUCT'))
    await f.database.prepare('INSERT INTO cards (product_id,card_key) VALUES (?,?)').bind('perf-0', 'LIVE-STOCK-CARD').run()
    const refreshed = await f.request('/buy/perf-0', { headers: { RSC: '1' } })
    assert.ok((await refreshed.text()).includes('"stockCount":1'))
})

test('pending delivery renders readable supplier failures and a real retry delivers once with the original request ID', async t => {
    let healthy = false, failureStatus = 401
    const requested = []
    const f = await setup(t, { provider: async request => {
        if (new URL(request.url).hostname !== 'supplier.example') return undefined
        const body = await request.json()
        requested.push(body.requestId)
        return healthy ? Response.json({ success: true, requestId: body.requestId, data: { cardKey: 'RETRY-PRODUCTION-CARD' } }) : new Response(null, { status: failureStatus })
    } })
    await f.database.prepare('INSERT INTO orders (order_id,product_id,product_name,amount,status,user_id,username,paid_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .bind('RETRY-ORDER', 'product', 'Purchased test product', '3', 'paid', 'owner', 'audit-admin', Date.now(), Date.now()).run()
    const saved = await f.action('saveCardsApiConfig', '/admin/cards/product', ['product', 'https://supplier.example/cards', '', true, 'on_demand'], f.sessionCookie)
    assert.equal(saved.result?.success, true)
    await f.action('retryOrderDelivery', '/admin/fulfillment', ['RETRY-ORDER'], f.sessionCookie)
    await f.database.prepare('UPDATE inventory_events SET error = ?, next_attempt_at = ? WHERE event_id = ?')
        .bind('supplier_http_401', Date.now() + 3_600_000, 'supplier:RETRY-ORDER').run()
    failureStatus = 521
    const latest = await f.action('retryOrderDelivery', '/admin/fulfillment', ['RETRY-ORDER'], f.sessionCookie)
    assert.ok(latest.body.includes('"supplierError":"supplier_http_521"'))
    const response = await f.request('/admin/fulfillment', { headers: { Cookie: f.sessionCookie, 'Accept-Language': 'zh-CN' } })
    const html = await response.text()
    assert.equal(response.status, 200)
    assert.ok(html.includes('HTTP 521'))
    assert.ok(html.includes('需要处理'))
    assert.ok(html.includes('查看错误代码'))
    assert.ok(!html.includes('supplier_http_401'))
    assert.ok(html.includes('lg:hidden') && html.includes('lg:block'))
    assert.ok(html.includes('/admin/orders/RETRY-ORDER') && html.includes('/admin/cards/product'))
    const denied = await f.request('/admin/fulfillment?q=RETRY', { headers: { Cookie: await f.cookie('other', 'other-user') } })
    assert.ok(!(await denied.text()).includes('Purchased test product'))
    const failedRequests = requested.length
    assert.ok(failedRequests >= 1)
    assert.equal((await f.database.prepare('SELECT status FROM orders WHERE order_id = ?').bind('RETRY-ORDER').all()).results[0].status, 'paid')
    healthy = true
    await f.action('retryOrderDelivery', '/admin/fulfillment', ['RETRY-ORDER'], f.sessionCookie)
    // A failed manual attempt also schedules the existing background retry.
    // Every attempt must reuse the purchase ID, and recovery fetches only one card.
    assert.equal(requested.length, failedRequests + 1)
    assert.ok(requested.every(id => id === requested[0]))
    const row = (await f.database.prepare('SELECT status,card_key FROM orders WHERE order_id = ?').bind('RETRY-ORDER').all()).results[0]
    assert.equal(row.status, 'delivered')
    assert.equal(row.card_key, 'RETRY-PRODUCTION-CARD')
    assert.equal((await f.database.prepare('SELECT count(*) AS count FROM order_deliveries WHERE order_id = ?').bind('RETRY-ORDER').all()).results[0].count, 1)
    await Promise.all(Array.from({ length: 3 }, () => f.action('retryOrderDelivery', '/admin/fulfillment', ['RETRY-ORDER'], f.sessionCookie)))
    assert.equal(requested.length, failedRequests + 1)
    assert.equal((await f.database.prepare('SELECT count(*) AS count FROM order_deliveries WHERE order_id = ?').bind('RETRY-ORDER').all()).results[0].count, 1)
    const done = await f.request('/admin/fulfillment', { headers: { Cookie: f.sessionCookie } })
    assert.ok(!(await done.text()).includes('RETRY-ORDER'))
})

test('a blocked supplier URL change can be confirmed through production actions and delivers with its original purchase ID', async t => {
    let purchases = 0
    const f = await setup(t, { provider: async request => {
        if (new URL(request.url).hostname !== 'new-supplier.example') return undefined
        purchases++
        const body = await request.json()
        assert.equal(body.requestId, 'preserved-production-id')
        return Response.json({ success: true, requestId: body.requestId, data: { cardKey: 'RECOVERED-PRODUCTION-CARD' } })
    } })
    await f.database.prepare('INSERT INTO orders (order_id,product_id,product_name,amount,status,user_id,username) VALUES (?,?,?,?,?,?,?)')
        .bind('ADDRESS-ORDER', 'product', 'Address recovery product', '3', 'paid', 'owner', 'audit-admin').run()
    await f.database.prepare('INSERT INTO supplier_requests (request_id,order_id,item_index,server_url,created_at,error) VALUES (?,?,?,?,?,?)')
        .bind('preserved-production-id', 'ADDRESS-ORDER', 0, 'https://old-supplier.example/cards', Date.now(), 'supplier_http_401').run()
    const saved = await f.action('saveCardsApiConfig', '/admin/cards/product', ['product', 'https://new-supplier.example/cards', '', true, 'on_demand'], f.sessionCookie)
    assert.equal(saved.result?.success, true)
    const info = await f.action('getSupplierRecoveryInfo', '/admin/fulfillment', ['ADDRESS-ORDER'], f.sessionCookie)
    assert.equal(info.result?.success, true)
    assert.deepEqual(info.result.info.requestIds, ['preserved-production-id'])
    const denied = await f.action('getSupplierRecoveryInfo', '/admin/fulfillment', ['ADDRESS-ORDER'], await f.cookie('other', 'other-user'))
    assert.ok(!denied.body.includes('https://old-supplier.example/cards'))
    const rejected = await f.action('resumeSupplierOrder', '/admin/fulfillment', ['ADDRESS-ORDER', info.result.info.currentUrl, false], f.sessionCookie)
    assert.equal(rejected.result?.success, false)
    assert.equal(purchases, 0)
    const page = await f.request('/admin/fulfillment', { headers: { Cookie: f.sessionCookie, 'Accept-Language': 'zh-CN' } })
    assert.ok((await page.text()).includes('更新取卡地址'))
    const resumed = await f.action('resumeSupplierOrder', '/admin/fulfillment', ['ADDRESS-ORDER', info.result.info.currentUrl, true], f.sessionCookie)
    assert.equal(resumed.result?.delivered, true, resumed.body)
    assert.equal(purchases, 1)
    const audit = await f.database.prepare("SELECT data FROM inventory_events WHERE kind = 'supplier_recovery'").bind().all()
    assert.equal(audit.results.length, 1)
    assert.ok(audit.results[0].data.includes('https://old-supplier.example/cards'))
    const done = await f.request('/admin/fulfillment', { headers: { Cookie: f.sessionCookie } })
    assert.ok(!(await done.text()).includes('ADDRESS-ORDER'))
})

test('refunding a paid pending-delivery order removes it from the production recovery list', async t => {
    let refunds = 0
    const f = await setup(t, { provider: async request => {
        if (new URL(request.url).hostname !== 'credit.linux.do') return undefined
        assert.equal(new URL(request.url).searchParams.get('act'), 'refund')
        refunds++
        return Response.json({ code: 1 })
    } })
    await f.database.prepare('INSERT INTO orders (order_id,product_id,product_name,amount,status,user_id,username,trade_no) VALUES (?,?,?,?,?,?,?,?)')
        .bind('PENDING-REFUND', 'product', 'Pending refund product', '3', 'paid', 'owner', 'audit-admin', 'refund-trade').run()
    const page = await f.request('/admin/fulfillment', { headers: { Cookie: f.sessionCookie, 'Accept-Language': 'zh-CN' } })
    assert.ok((await page.text()).includes('退款'))
    const result = await f.action('proxyRefund', '/admin/fulfillment', ['PENDING-REFUND'], f.sessionCookie)
    assert.equal(result.result?.processed, true)
    assert.equal(refunds, 1)
    const done = await f.request('/admin/fulfillment', { headers: { Cookie: f.sessionCookie } })
    assert.ok(!(await done.text()).includes('PENDING-REFUND'))
})

test('the production worker renders shop and admin pages with a real authenticated session', async t => {
    const f = await setup(t)
    const session = await f.request('/api/auth/session', { headers: { Cookie: f.sessionCookie } })
    assert.equal((await session.json()).user.id, 'owner')
    for (const pathname of ['/', '/buy/product', '/admin/inventory-api', '/admin/fulfillment', '/admin/cards/product', '/admin/notifications']) {
        const response = await f.request(pathname, { headers: { Cookie: f.sessionCookie } })
        assert.equal(response.status, 200, pathname)
        const html = await response.text()
        assert.ok(!html.includes('NEXT_HTTP_ERROR_FALLBACK'), pathname)
    }
})

test('Linux DO OAuth preserves the product return URL and creates a session through real production auth routes', async t => {
    let challenge, tokenCalls = 0, profileCalls = 0
    const f = await setup(t, { provider: async request => {
        const url = new URL(request.url)
        if (url.hostname !== 'connect.linux.do') return undefined
        if (url.pathname === '/oauth2/token') {
            tokenCalls++
            const body = new URLSearchParams(await request.text())
            assert.equal(body.get('code'), 'isolated-linuxdo-code')
            assert.equal(body.get('redirect_uri'), 'https://shop.example/api/auth/callback/linuxdo')
            assert.equal(createHash('sha256').update(body.get('code_verifier')).digest('base64url'), challenge)
            return Response.json({ access_token: 'isolated-linuxdo-access-token', token_type: 'Bearer', expires_in: 3600 })
        }
        if (url.pathname === '/api/user') {
            profileCalls++
            assert.equal(request.headers.get('authorization'), 'Bearer isolated-linuxdo-access-token')
            return Response.json({ id: 789, username: 'linuxdo-test-user', name: 'Linux DO Test', trust_level: 2 })
        }
        assert.fail(`Unexpected OAuth request: ${url.pathname}`)
    } })
    const jar = new Map()
    const remember = response => {
        for (const value of response.headers.getSetCookie()) {
            const pair = value.split(';')[0], index = pair.indexOf('=')
            jar.set(pair.slice(0, index), pair.slice(index + 1))
        }
    }
    const cookie = () => [...jar].map(([name, value]) => `${name}=${value}`).join('; ')
    const page = await f.request('/login?callbackUrl=%2Fbuy%2Fproduct')
    const buttonTexts = [...(await page.text()).matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map(match => match[1].replace(/<[^>]+>/g, ''))
    assert.ok(buttonTexts.some(text => text.includes('Linux DO')))
    assert.ok(!buttonTexts.some(text => text.includes('GitHub')))
    let csrfRequests = 0, signinRequests = 0
    const client = browserFixture(t, { initialize: false, globals: { AbortController }, fetch: async (path, init) => {
        assert.notEqual(path, '/api/auth/providers')
        if (path === '/api/auth/csrf' && ++csrfRequests === 1) return new Response(null, { status: 503 })
        if (path === '/api/auth/signin/linuxdo') signinRequests++
        const response = await f.request(path, { ...init, headers: { ...init.headers, Cookie: cookie() } })
        remember(response)
        return response
    } }).load('lib/oauth-login')
    const authorization = new URL(await client.startOAuthLogin('linuxdo', '/buy/product?from=login', 'https://shop.example'))
    assert.equal(csrfRequests, 2)
    assert.equal(signinRequests, 1)
    assert.equal(authorization.origin, 'https://connect.linux.do')
    assert.equal(authorization.pathname, '/oauth2/authorize')
    assert.equal(authorization.searchParams.get('client_id'), 'isolated-production-linuxdo-client')
    assert.equal(authorization.searchParams.get('redirect_uri'), 'https://shop.example/api/auth/callback/linuxdo')
    assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256')
    challenge = authorization.searchParams.get('code_challenge')
    const callback = await f.request('/api/auth/callback/linuxdo?code=isolated-linuxdo-code', { headers: { Cookie: cookie() }, redirect: 'manual' })
    remember(callback)
    await callback.text()
    assert.equal(callback.status, 302)
    assert.equal(callback.headers.get('location'), 'https://shop.example/buy/product?from=login')
    const session = await (await f.request('/api/auth/session', { headers: { Cookie: cookie() } })).json()
    assert.equal(session.user.id, '789')
    assert.equal(session.user.username, 'linuxdo-test-user')
    assert.equal(session.user.trustLevel, 2)
    assert.equal(tokenCalls, 1)
    assert.equal(profileCalls, 1)
})

test('actual production Server Actions validate supplier drafts and recover encrypted keys', async t => {
    const f = await setup(t)
    for (const mode of ['stock', 'on_demand']) {
        const saved = await f.action('saveCardsApiConfig', '/admin/cards/product', ['product', '', '', false, mode], f.sessionCookie)
        assert.equal(saved.status, 200, saved.body)
        assert.equal(saved.result?.success, true, saved.body)
        const enabled = await f.action('setCardsApiEnabled', '/admin/cards/product', ['product', true], f.sessionCookie)
        assert.equal(enabled.result?.success, false, enabled.body)
        assert.equal(enabled.result?.error, 'admin.cards.apiUrlRequired')
    }
    const created = await f.action('createInventoryKey', '/admin/inventory-api', [{ name: 'Production tool', productIds: ['product'], canRead: true, canWrite: true, expiresAt: null }], f.sessionCookie)
    assert.equal(created.result?.success, true, created.body)
    const rows = await f.database.prepare('SELECT id, token_hash, token_encrypted FROM inventory_api_keys').bind().all()
    const [key] = rows.results
    assert.ok(!JSON.stringify(key).includes(created.result.token))
    const view = await f.action('viewInventoryKey', '/admin/inventory-api', [key.id], f.sessionCookie)
    assert.equal(view.result?.token, created.result.token, view.body)
    const reset = await f.action('resetInventoryKey', '/admin/inventory-api', [key.id], f.sessionCookie)
    assert.equal(reset.result?.success, true, reset.body)
    for (const [token, status] of [[created.result.token, 401], [reset.result.token, 200]]) {
        const response = await f.request('/api/v1/products', { headers: { Authorization: `Bearer ${token}` } })
        assert.equal(response.status, status)
        await response.text()
    }
    const anonymous = await f.action('viewInventoryKey', '/admin/inventory-api', [key.id])
    assert.ok(!anonymous.body.includes(reset.result.token))
    const denied = await f.action('deleteInventoryKey', '/admin/inventory-api', [key.id], await f.cookie('other', 'other-user'))
    assert.notEqual(denied.result?.success, true)
    assert.equal((await f.action('viewInventoryKey', '/admin/inventory-api', [key.id], f.sessionCookie)).result?.token, reset.result.token)
    const imported = await f.request('/api/v1/products/product/cards', {
        method: 'POST', headers: { Authorization: `Bearer ${reset.result.token}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'preserved-batch' },
        body: JSON.stringify({ cards: ['PRESERVED-PRODUCTION-CARD'] }),
    })
    assert.equal(imported.status, 201)
    await imported.text()
    const removed = await f.action('deleteInventoryKey', '/admin/inventory-api', [key.id], f.sessionCookie)
    assert.equal(removed.result?.success, true, removed.body)
    const revoked = await f.request('/api/v1/products', { headers: { Authorization: `Bearer ${reset.result.token}` } })
    assert.equal(revoked.status, 401)
    await revoked.text()
    assert.equal((await f.database.prepare('SELECT COUNT(*) AS count FROM inventory_api_keys').bind().all()).results[0].count, 0)
    assert.equal((await f.database.prepare('SELECT COUNT(*) AS count FROM cards').bind().all()).results[0].count, 1)
    assert.equal((await f.database.prepare('SELECT COUNT(*) AS count FROM inventory_imports').bind().all()).results[0].count, 1)
    const history = await f.database.prepare('SELECT key_id FROM inventory_api_requests').bind().all()
    assert.ok(history.results.length > 0)
    assert.ok(history.results.every(log => log.key_id === null))
})

test('production update checks use server requests and recover when the GitHub raw domain fails', async t => {
    let fail = false
    const calls = []
    const f = await setup(t, { provider: request => {
        const url = new URL(request.url)
        if (!['raw.githubusercontent.com', 'api.github.com'].includes(url.hostname)) return undefined
        calls.push(url.toString())
        assert.equal(request.headers.get('user-agent'), 'ldc-shop-update-check')
        if (url.hostname === 'raw.githubusercontent.com') return new Response(null, { status: 503 })
        assert.equal(url.pathname, '/repos/andlink01/ldc-shop/contents/_workers_next/package.json')
        assert.equal(url.searchParams.get('ref'), 'main')
        return fail ? new Response(null, { status: 429 }) : Response.json({ version: '9.0.0' })
    } })
    const denied = await f.action('checkForUpdates', '/admin/settings', [], await f.cookie('other', 'other-user'))
    assert.ok(!denied.body.includes('9.0.0'))
    assert.equal(calls.length, 0)
    const checked = await f.action('checkForUpdates', '/admin/settings', [], f.sessionCookie)
    assert.equal(checked.status, 200, checked.body)
    assert.ok(checked.body.includes('"latestVersion":"9.0.0"'), checked.body)
    assert.ok(checked.body.includes('"hasUpdate":true'), checked.body)
    assert.equal(calls.length, 2)
    fail = true
    const failure = await f.action('checkForUpdates', '/admin/settings', [], f.sessionCookie)
    assert.ok(failure.body.includes('update.rateLimited'), failure.body)
    assert.ok(failure.body.includes('"latestVersion":null'), failure.body)
})

test('the production order response excludes card keys for other users and forged cookies', async t => {
    const f = await setup(t)
    await f.database.prepare('INSERT INTO orders (order_id, product_id, product_name, amount, status, user_id, username, card_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind('private-order', 'product', 'Product', '3', 'delivered', 'owner', 'audit-admin', 'PRIVATE-PRODUCTION-CARD').run()
    await f.database.prepare('INSERT INTO orders (order_id, product_id, product_name, amount, status, card_key) VALUES (?, ?, ?, ?, ?, ?)').bind('ownerless-order', 'product', 'Product', '3', 'delivered', 'OWNERLESS-PRODUCTION-CARD').run()
    for (const session of ['', await f.cookie('other', 'other-user')]) {
        const response = await f.request('/order/private-order', { headers: { Cookie: `${session}; ldc_pending_order=private-order` } })
        assert.equal(response.status, 200)
        assert.ok(!(await response.text()).includes('PRIVATE-PRODUCTION-CARD'))
        // An order without an owner is not opened by a cookie the browser sets itself.
        const ownerless = await f.request('/order/ownerless-order', { headers: { Cookie: `${session}; ldc_pending_order=ownerless-order` } })
        assert.ok(!(await ownerless.text()).includes('OWNERLESS-PRODUCTION-CARD'))
    }
    const response = await f.request('/order/private-order', { headers: { Cookie: f.sessionCookie } })
    assert.ok((await response.text()).includes('PRIVATE-PRODUCTION-CARD'))
})

test('checkout, signed payment callbacks and order delivery work through the production Next routes', async t => {
    const f = await setup(t)
    await f.database.prepare('INSERT INTO cards (product_id, card_key) VALUES (?, ?)').bind('product', 'PRODUCTION-DELIVERY-CARD').run()
    const created = await f.action('createOrder', '/buy/product', ['product', 1, 'buyer@example.com', false], f.sessionCookie)
    assert.equal(created.result?.success, true, created.body)
    const id = created.result.params.out_trade_no
    await Promise.all(Array.from({ length: 3 }, () => pay(f, id)))
    const rows = await f.database.prepare('SELECT status, card_key FROM orders WHERE order_id = ?').bind(id).all()
    assert.equal(rows.results[0].status, 'delivered')
    assert.equal(rows.results[0].card_key, 'PRODUCTION-DELIVERY-CARD')
    const receipts = await f.database.prepare('SELECT COUNT(*) AS count FROM order_deliveries').bind().all()
    assert.equal(receipts.results[0].count, 1)
    const checked = await f.action('checkOrderStatus', `/order/${id}`, [id], f.sessionCookie)
    assert.equal(checked.result?.status, 'delivered', checked.body)
})

test('notification tests run as actual production Server Actions and reject invalid provider acknowledgements', async t => {
    let rejected = false
    const f = await setup(t, { provider: request => {
        if (rejected && ['api.telegram.org', 'api.resend.com'].includes(new URL(request.url).hostname)) return Response.json({ ok: false, error: 'PRIVATE-TEST-TOKEN' })
    } })
    for (const [key, value] of Object.entries({ telegram_enabled: 'true', telegram_bot_token: 'TEST-BOT', telegram_chat_id: 'TEST-CHAT', bark_enabled: 'true', bark_device_key: 'TEST-DEVICE', resend_enabled: 'true', resend_api_key: 'TEST-RESEND', resend_from_email: 'shop@example.com' })) {
        await f.database.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, value).run()
    }
    for (const [name, args] of [['testNotification', []], ['testBarkNotification', []], ['testEmailNotification', ['buyer@example.com']]]) {
        const response = await f.action(name, '/admin/notifications', args, f.sessionCookie)
        assert.equal(response.result?.success, true, response.body)
    }
    rejected = true
    for (const [name, args] of [['testNotification', []], ['testEmailNotification', ['buyer@example.com']]]) {
        const response = await f.action(name, '/admin/notifications', args, f.sessionCookie)
        assert.equal(response.result?.success, false, response.body)
        assert.ok(!response.body.includes('PRIVATE-TEST-TOKEN'))
    }
})

test('a five-second supplier issues a card only after payment through the production background handler', async t => {
    let purchases = 0
    const f = await setup(t, { provider: async request => {
        if (new URL(request.url).hostname !== 'supplier.example') return undefined
        purchases++
        const body = await request.json()
        assert.equal(body.requestId, request.headers.get('idempotency-key'))
        assert.equal(request.headers.get('authorization'), null)
        await new Promise(resolve => setTimeout(resolve, 5000))
        return Response.json({ success: true, requestId: body.requestId, data: { cardKey: 'SLOW-PRODUCTION-CARD' } })
    } })
    const saved = await f.action('saveCardsApiConfig', '/admin/cards/product', ['product', 'https://supplier.example/cards', '', false, 'on_demand'], f.sessionCookie)
    assert.equal(saved.result?.success, true, saved.body)
    const enabled = await f.action('setCardsApiEnabled', '/admin/cards/product', ['product', true], f.sessionCookie)
    assert.equal(enabled.result?.success, true, enabled.body)
    assert.equal(purchases, 0)
    const created = await f.action('createOrder', '/buy/product', ['product', 1, 'buyer@example.com', false], f.sessionCookie)
    assert.equal(created.result?.success, true, created.body)
    assert.equal(purchases, 0)
    const id = created.result.params.out_trade_no
    await pay(f, id)
    let delivered
    for (let attempt = 0; attempt < 40; attempt++) {
        const state = await f.database.prepare('SELECT status, card_key FROM orders WHERE order_id = ?').bind(id).all()
        delivered = state.results[0]
        if (delivered.status === 'delivered') break
        await new Promise(resolve => setTimeout(resolve, 250))
    }
    assert.equal(delivered.status, 'delivered')
    assert.equal(delivered.card_key, 'SLOW-PRODUCTION-CARD')
    assert.equal(purchases, 1)
})

test('production refund actions call the payment refund operation and restore inventory only once', async t => {
    let refunds = 0, refundedOrderId
    const f = await setup(t, { provider: async request => {
        const url = new URL(request.url)
        if (url.hostname !== 'credit.linux.do') return undefined
        if (url.searchParams.get('act') === 'refund') {
            assert.equal(request.method, 'POST')
            const form = await request.formData()
            assert.equal(form.get('money'), '3.00')
            assert.equal(form.get('trade_no'), 'production-test-trade')
            refundedOrderId = form.get('out_trade_no')
            refunds++
            return Response.json({ code: 1 })
        }
        assert.equal(url.searchParams.get('act'), 'order')
        assert.equal(url.searchParams.get('trade_no'), 'production-test-trade')
        assert.ok(url.searchParams.get('out_trade_no'), 'the payment platform rejects a query without out_trade_no')
        return Response.json({ code: 1, status: 0, trade_no: 'production-test-trade', out_trade_no: refundedOrderId })
    } })
    await f.database.prepare('INSERT INTO cards (product_id, card_key) VALUES (?, ?)').bind('product', 'REFUND-PRODUCTION-CARD').run()
    const created = await f.action('createOrder', '/buy/product', ['product', 1, '', false], f.sessionCookie)
    assert.equal(created.result?.success, true, created.body)
    const id = created.result.params.out_trade_no
    await pay(f, id)
    const responses = await Promise.all(Array.from({ length: 3 }, () => f.action('proxyRefund', `/admin/orders/${id}`, [id], f.sessionCookie)))
    assert.ok(responses.some(response => response.result?.processed), responses.map(response => response.body).join('\n'))
    assert.equal((await f.action('proxyRefund', `/admin/orders/${id}`, [id], f.sessionCookie)).result?.processed, true)
    const verified = await f.action('verifyOrderRefundStatus', `/admin/orders/${id}`, [id], f.sessionCookie)
    assert.equal(verified.result?.success, true, verified.body)
    assert.equal(refunds, 1)
    const cards = await f.database.prepare('SELECT is_used FROM cards').bind().all()
    assert.equal(cards.results[0].is_used, 0)
    const orders = await f.database.prepare('SELECT status FROM orders WHERE order_id = ?').bind(id).all()
    assert.equal(orders.results[0].status, 'refunded')
})

test('production checkout rejects a direct trust-level bypass without spending points or reserving stock', async t => {
    const f = await setup(t)
    await f.database.prepare('UPDATE products SET visibility_level = ? WHERE id = ?').bind(2, 'product').run()
    await f.database.prepare('INSERT INTO cards (product_id,card_key) VALUES (?,?)').bind('product', 'TRUST-PRODUCTION-CARD').run()
    for (const level of [0, 1]) {
        const denied = await f.action('createOrder', '/buy/product', ['product', 1, '', true], await f.cookie('owner', 'audit-admin', level))
        assert.equal(denied.result?.success, false, denied.body)
        assert.equal(denied.result?.error, 'buy.visibilityDenied')
    }
    assert.equal((await f.database.prepare('SELECT count(*) AS count FROM orders').bind().all()).results[0].count, 0)
    assert.equal((await f.database.prepare('SELECT points FROM login_users WHERE user_id = ?').bind('owner').all()).results[0].points, 20)
    assert.equal((await f.database.prepare('SELECT reserved_order_id FROM cards').bind().all()).results[0].reserved_order_id, null)
    const allowed = await f.action('createOrder', '/buy/product', ['product', 1, '', false], await f.cookie('owner', 'audit-admin', 2))
    assert.equal(allowed.result?.success, true, allowed.body)
})

test('production Server Actions reject malformed answers while a correct answer still buys normally', async t => {
    const f = await setup(t)
    const answer = 'PRIVATE-PRODUCTION-ANSWER'
    const questions = JSON.stringify([{ q: 'Answer?', a: answer }])
    await f.database.prepare('UPDATE products SET purchase_questions = ?, variant_group_id = ? WHERE id = ?').bind(questions, 'question-group', 'product').run()
    await f.database.prepare('INSERT INTO products (id,name,price,variant_group_id,purchase_questions) VALUES (?,?,?,?,?)')
        .bind('question-variant', 'Question variant', '3', 'question-group', JSON.stringify([{ q: 'Variant question?', a: 'PRIVATE-VARIANT-ANSWER' }])).run()
    for (const headers of [{ Cookie: f.sessionCookie }, { Cookie: f.sessionCookie, RSC: '1' }]) {
        const page = await f.request('/buy/product', { headers })
        const html = await page.text()
        assert.equal(page.status, 200)
        assert.ok(html.includes('Answer?') && html.includes('Variant question?'))
        assert.ok(!html.includes(answer) && !html.includes('PRIVATE-VARIANT-ANSWER'))
    }
    await f.database.prepare('INSERT INTO cards (product_id,card_key) VALUES (?,?)').bind('product', 'ANSWER-PRODUCTION-CARD').run()
    for (const answers of [[{}], [null], { 0: answer, length: 1 }]) {
        const denied = await f.action('createOrder', '/buy/product', ['product', 1, '', false, answers], f.sessionCookie)
        assert.equal(denied.result?.success, false, denied.body)
        assert.equal(denied.result?.error, 'buy.answersRequired')
        assert.equal((await f.action('verifyPurchaseAnswers', '/buy/product', ['product', answers], f.sessionCookie)).result?.error, 'buy.answersRequired')
    }
    assert.equal((await f.action('verifyPurchaseAnswers', '/buy/product', ['product', ['wrong']], f.sessionCookie)).result?.error, 'buy.questionsWrong')
    assert.equal((await f.action('verifyPurchaseAnswers', '/buy/product', ['product', [' private-production-answer ']], f.sessionCookie)).result?.success, true)
    assert.equal((await f.database.prepare('SELECT count(*) AS count FROM orders').bind().all()).results[0].count, 0)
    assert.equal((await f.database.prepare('SELECT points FROM login_users WHERE user_id = ?').bind('owner').all()).results[0].points, 20)
    assert.equal((await f.database.prepare('SELECT reserved_order_id FROM cards').bind().all()).results[0].reserved_order_id, null)
    await f.database.prepare('UPDATE products SET purchase_questions = ? WHERE id = ?').bind('invalid-json', 'product').run()
    const invalid = await f.action('createOrder', '/buy/product', ['product', 1, '', false, [answer]], f.sessionCookie)
    assert.equal(invalid.result?.error, 'buy.questionsUnavailable', invalid.body)
    await f.database.prepare('UPDATE products SET purchase_questions = ? WHERE id = ?').bind(questions, 'product').run()
    const allowed = await f.action('createOrder', '/buy/product', ['product', 1, '', false, [' private-production-answer ']], f.sessionCookie)
    assert.equal(allowed.result?.success, true, allowed.body)
})

test('production automatic GET restocking rejects historical and concurrent duplicate cards', async t => {
    let cardKey = 'SOLD-PRODUCTION-CARD'
    const f = await setup(t, { provider: request => {
        if (new URL(request.url).hostname === 'supplier.example') return Response.json({ cardKey })
    } })
    await f.database.prepare('INSERT INTO cards (product_id,card_key,is_used) VALUES (?,?,1)').bind('product', cardKey).run()
    const saved = await f.action('saveCardsApiConfig', '/admin/cards/product', ['product', 'https://supplier.example/cards', '', true, 'stock'], f.sessionCookie)
    assert.equal(saved.result?.success, true, saved.body)
    const duplicate = await f.action('pullCardFromApi', '/admin/cards/product', ['product'], f.sessionCookie)
    assert.equal(duplicate.result?.success, false, duplicate.body)
    assert.equal(duplicate.result?.error, 'api_card_duplicate')
    cardKey = 'NEW-PRODUCTION-CARD'
    const pulls = await Promise.all(Array.from({ length: 3 }, () => f.action('pullCardFromApi', '/admin/cards/product', ['product'], f.sessionCookie)))
    assert.equal(pulls.filter(pull => pull.result?.success).length, 1, pulls.map(pull => pull.body).join('\n'))
    assert.equal((await f.database.prepare('SELECT count(*) AS count FROM cards WHERE card_key = ?').bind(cardKey).all()).results[0].count, 1)
})

test('the production backup and import routes preserve inventory across a payment during export', async t => {
    const f = await setup(t)
    await f.database.prepare('INSERT INTO cards (product_id,card_key) VALUES (?,?)').bind('product', 'BACKUP-PRODUCTION-CARD').run()
    const created = await f.action('createOrder', '/buy/product', ['product', 1, '', false], f.sessionCookie)
    assert.equal(created.result?.success, true, created.body)
    const id = created.result.params.out_trade_no
    const response = await f.request('/admin/data/download?type=full&format=sql', { headers: { Cookie: f.sessionCookie, 'X-Test-Interleave-Callback': paymentCallbackPath(id) } })
    const dump = await response.text()
    assert.equal(response.status, 200, dump)
    assert.equal(response.headers.get('x-test-interleaved'), 'true')
    assert.equal((await f.database.prepare('SELECT status FROM orders WHERE order_id = ?').bind(id).all()).results[0].status, 'delivered')
    const restored = await setup(t)
    await restored.database.prepare('DELETE FROM products').bind().run()
    const form = new FormData()
    form.set('file', new File([dump], 'backup.sql', { type: 'application/sql' }))
    const imported = await restored.action('importData', '/admin/data', [form], restored.sessionCookie)
    assert.equal(imported.result?.success, true, imported.body)
    assert.equal(imported.result?.errors, 0, imported.body)
    const order = (await restored.database.prepare('SELECT status FROM orders WHERE order_id = ?').bind(id).all()).results[0]
    const card = (await restored.database.prepare('SELECT is_used FROM cards').bind().all()).results[0]
    assert.equal(order.status === 'delivered', Boolean(card.is_used))
    await pay(restored, id)
    const second = await restored.action('createOrder', '/buy/product', ['product', 1, '', false], restored.sessionCookie)
    assert.equal(second.result?.success, false, second.body)
    assert.equal(second.result?.error, 'buy.outOfStock')
    assert.equal((await restored.database.prepare('SELECT count(*) AS count FROM order_deliveries').bind().all()).results[0].count, 1)
})

test('production review metadata keeps more than 100 reviews and their replies', async t => {
    const f = await setup(t)
    for (let i = 0; i < 101; i++) await f.database.prepare('INSERT INTO reviews (product_id,order_id,user_id,username,rating,comment,created_at) VALUES (?,?,?,?,?,?,?)')
        .bind('product', 'review-' + i, 'owner', 'audit-admin', 5, 'Review ' + i, Date.now() + i).run()
    await f.database.prepare('INSERT INTO review_replies (review_id,user_id,username,comment) VALUES (?,?,?,?)').bind(1, 'owner', 'audit-admin', 'Production reply').run()
    const result = await f.action('getBuyPageMeta', '/buy/product', ['product'], f.sessionCookie)
    assert.equal(result.result?.reviewCount, 101, result.body)
    assert.equal(result.result?.averageRating, 5)
    assert.equal(result.result?.reviews.length, 101)
    assert.equal(result.result?.reviews.find(review => review.id === 1).replies[0].comment, 'Production reply')
})

test('the production cleanup route rotates beyond 50 missing-stock orders without cancelling payment', async t => {
    const f = await setup(t)
    await f.database.prepare('INSERT INTO products (id,name,price) VALUES (?,?,?)').bind('a-unavailable', 'Unavailable', '3').run()
    for (let i = 0; i < 50; i++) await f.database.prepare('INSERT INTO orders (order_id,product_id,product_name,amount,status,user_id,paid_at,created_at) VALUES (?,?,?,?,?,?,?,?)')
        .bind('old-' + i, 'a-unavailable', 'Unavailable', '3', 'paid', 'owner', 1, i + 1).run()
    await f.database.prepare('INSERT INTO cards (product_id,card_key) VALUES (?,?)').bind('product', 'RECOVERY-PRODUCTION-CARD').run()
    await f.database.prepare('INSERT INTO orders (order_id,product_id,product_name,amount,status,user_id,paid_at,created_at) VALUES (?,?,?,?,?,?,?,?)')
        .bind('ready-order', 'product', 'Production test product', '3', 'paid', 'owner', Date.now(), Date.now()).run()
    const cleanup = async () => {
        const response = await f.request('/api/internal/cron/cleanup', { method: 'POST', headers: { 'X-Cron-Cleanup-Token': 'isolated-production-oauth' } })
        assert.equal(response.status, 200, await response.clone().text())
        return response.json()
    }
    assert.equal((await cleanup()).fulfillment.delivered, 0)
    assert.equal((await cleanup()).fulfillment.delivered, 1)
    assert.equal((await f.database.prepare("SELECT count(*) AS count FROM orders WHERE status = 'paid'").bind().all()).results[0].count, 50)
    assert.equal((await f.database.prepare('SELECT status FROM orders WHERE order_id = ?').bind('ready-order').all()).results[0].status, 'delivered')
})

test('the production Worker delivers complete reservations after 50 missing-stock orders of the same product', async t => {
    const f = await setup(t)
    for (let i = 0; i < 50; i++) await f.database.prepare('INSERT INTO orders (order_id,product_id,product_name,amount,status,quantity,user_id,paid_at) VALUES (?,?,?,?,?,?,?,?)')
        .bind('old-' + String(i).padStart(2, '0'), 'product', 'Production test product', '3', 'paid', 3, 'owner', 1).run()
    await f.database.prepare('INSERT INTO orders (order_id,product_id,product_name,amount,status,quantity,user_id,paid_at) VALUES (?,?,?,?,?,?,?,?)')
        .bind('reserved', 'product', 'Production test product', '3', 'paid', 2, 'owner', 2).run()
    for (const cardKey of ['RESERVED-ONE', 'RESERVED-TWO']) await f.database.prepare('INSERT INTO cards (product_id,card_key,reserved_order_id,reserved_at) VALUES (?,?,?,?)')
        .bind('product', cardKey, 'reserved', 1).run()
    await f.database.prepare('INSERT INTO cards (product_id,card_key) VALUES (?,?)').bind('product', 'OLDER-STOCK').run()
    const response = await f.request('/api/internal/cron/cleanup', { method: 'POST', headers: { 'X-Cron-Cleanup-Token': 'isolated-production-oauth' } })
    assert.equal(response.status, 200, await response.clone().text())
    assert.equal((await response.json()).fulfillment.delivered, 1)
    assert.equal((await f.database.prepare('SELECT card_key FROM orders WHERE order_id = ?').bind('reserved').all()).results[0].card_key, 'RESERVED-ONE\nRESERVED-TWO')
    assert.equal((await f.database.prepare('SELECT reserved_order_id FROM cards WHERE card_key = ?').bind('OLDER-STOCK').all()).results[0].reserved_order_id, 'old-00')
    assert.equal((await f.database.prepare('SELECT count(*) AS count FROM order_deliveries').bind().all()).results[0].count, 1)
    assert.equal((await f.database.prepare("SELECT count(*) AS count FROM orders WHERE status = 'paid'").bind().all()).results[0].count, 50)
})

async function productionRefundSetup(t, provider) {
    const f = await setup(t, { provider })
    await f.database.prepare('UPDATE products SET price = ?, max_points_discount = ? WHERE id = ?').bind('5', '2', 'product').run()
    await f.database.prepare('INSERT INTO cards (product_id,card_key) VALUES (?,?)').bind('product', 'REFUND-RECOVERY-CARD').run()
    const created = await f.action('createOrder', '/buy/product', ['product', 1, '', true], f.sessionCookie)
    assert.equal(created.result?.success, true, created.body)
    const id = created.result.params.out_trade_no
    await pay(f, id)
    return { ...f, id, refund: (confirmed = false) => f.action('proxyRefund', `/admin/orders/${id}`, [id, confirmed], f.sessionCookie) }
}

test('a production refund accepted before a local failure restores stock and points without another refund', async t => {
    let refunds = 0
    const f = await productionRefundSetup(t, request => {
        if (new URL(request.url).hostname === 'credit.linux.do') { refunds++; return Response.json({ code: 1 }) }
    })
    await f.database.prepare("CREATE TRIGGER fail_refund BEFORE UPDATE ON orders WHEN NEW.status = 'refunded' BEGIN SELECT RAISE(ABORT, 'isolated failure'); END;").bind().run()
    const failed = await f.refund()
    assert.equal(failed.result?.needsVerification, true, failed.body)
    assert.equal((await f.database.prepare('SELECT points FROM login_users WHERE user_id = ?').bind('owner').all()).results[0].points, 18)
    const event = (await f.database.prepare("SELECT data FROM inventory_events WHERE kind = 'refund_request'").bind().all()).results[0]
    assert.equal(JSON.parse(event.data).state, 'accepted')
    await f.database.prepare('DROP TRIGGER fail_refund').bind().run()
    assert.equal((await f.refund()).result?.processed, true)
    assert.equal(refunds, 1)
    assert.equal((await f.database.prepare('SELECT points FROM login_users WHERE user_id = ?').bind('owner').all()).results[0].points, 20)
    assert.equal((await f.database.prepare('SELECT is_used FROM cards').bind().all()).results[0].is_used, 0)
})

test('production refunds recover lost acknowledgements by trade ID and reject mismatched transactions', async t => {
    let refunds = 0, queries = 0, id, wrongTrade = true
    const f = await productionRefundSetup(t, request => {
        const url = new URL(request.url)
        if (url.hostname !== 'credit.linux.do') return undefined
        if (request.method === 'POST') { refunds++; return new Response(null, { status: 503 }) }
        queries++
        assert.equal(url.searchParams.get('trade_no'), 'production-test-trade')
        assert.ok(url.searchParams.get('out_trade_no'), 'the payment platform rejects a query without out_trade_no')
        return Response.json({ code: 1, status: 0, trade_no: wrongTrade ? 'another-trade' : 'production-test-trade', out_trade_no: id + '_retry123' })
    })
    id = f.id
    assert.equal((await f.refund()).result?.needsVerification, true)
    const denied = await f.action('verifyOrderRefundStatus', `/admin/orders/${id}`, [id], f.sessionCookie)
    assert.equal(denied.result?.success, false, denied.body)
    assert.equal((await f.database.prepare('SELECT status FROM orders WHERE order_id = ?').bind(id).all()).results[0].status, 'delivered')
    wrongTrade = false
    assert.equal((await f.refund()).result?.processed, true)
    assert.equal(refunds, 1)
    assert.equal(queries, 2)
    assert.equal((await f.database.prepare('SELECT points FROM login_users WHERE user_id = ?').bind('owner').all()).results[0].points, 20)
})

test('production refunds require verification and explicit review before an uncertain attempt is resubmitted', async t => {
    let refunds = 0, id, accepted = false
    const f = await productionRefundSetup(t, request => {
        const url = new URL(request.url)
        if (url.hostname !== 'credit.linux.do') return undefined
        if (request.method === 'POST') { refunds++; return accepted ? Response.json({ code: 1 }) : new Response(null, { status: 503 }) }
        return Response.json({ code: 1, status: 1, trade_no: 'production-test-trade', out_trade_no: id })
    })
    id = f.id
    assert.equal((await f.refund()).result?.needsVerification, true)
    assert.equal((await f.refund(true)).result?.needsVerification, true)
    assert.equal(refunds, 1)
    const verified = await f.action('verifyOrderRefundStatus', `/admin/orders/${id}`, [id], f.sessionCookie)
    assert.equal(verified.result?.canRetry, true, verified.body)
    assert.equal(verified.result?.needsReview, true)
    assert.equal((await f.refund()).result?.needsReview, true)
    accepted = true
    assert.equal((await f.refund(true)).result?.processed, true)
    assert.equal(refunds, 2)
    assert.equal((await f.database.prepare('SELECT points FROM login_users WHERE user_id = ?').bind('owner').all()).results[0].points, 20)
})

test('no admin page streams private data to anonymous or non-admin requests', async t => {
    const f = await setup(t)
    const d = f.database, now = Date.now()
    await d.prepare('UPDATE products SET name = ?, is_active = 0, visibility_level = 3, purchase_questions = ? WHERE id = ?')
        .bind('MARK-HIDDEN-PRODUCT', JSON.stringify([{ q: 'Q?', a: 'MARK-ANSWER' }]), 'product').run()
    await d.prepare('UPDATE login_users SET email = ? WHERE user_id = ?').bind('mark-buyer@private.example', 'owner').run()
    await d.prepare('INSERT INTO orders (order_id,product_id,product_name,amount,status,user_id,username,email,card_key,trade_no,paid_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
        .bind('MARK-ORDER', 'product', 'P', '3', 'delivered', 'owner', 'audit-admin', 'mark-buyer@private.example', 'MARK-CARD-KEY', 'MARK-TRADE', now, now).run()
    await d.prepare('INSERT INTO cards (product_id,card_key) VALUES (?,?)').bind('product', 'MARK-UNSOLD-CARD').run()
    await d.prepare('INSERT INTO refund_requests (order_id,user_id,username,reason,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
        .bind('MARK-ORDER', 'owner', 'audit-admin', 'MARK-REFUND-REASON', 'pending', now, now).run()
    await d.prepare('INSERT INTO user_messages (user_id,username,title,body,created_at) VALUES (?,?,?,?,?)').bind('owner', 'audit-admin', 'T', 'MARK-PRIVATE-MESSAGE', now).run()
    await d.prepare('INSERT INTO reviews (product_id,order_id,user_id,username,rating,comment,created_at) VALUES (?,?,?,?,?,?,?)')
        .bind('product', 'MARK-ORDER', 'owner', 'audit-admin', 5, 'MARK-REVIEW', now).run()
    await d.prepare('INSERT INTO categories (name) VALUES (?)').bind('MARK-CATEGORY').run()
    await d.prepare('INSERT INTO settings (key,value) VALUES (?,?),(?,?),(?,?),(?,?)')
        .bind('telegram_bot_token', 'MARK-TELEGRAM', 'resend_api_key', 'MARK-RESEND', 'cards_api_token_product', 'MARK-SUPPLIER', 'shop_footer', 'MARK-FOOTER-PUBLIC').run()
    const marks = ['MARK-HIDDEN-PRODUCT', 'MARK-ANSWER', 'mark-buyer@private.example', 'MARK-ORDER', 'MARK-CARD-KEY', 'MARK-TRADE',
        'MARK-UNSOLD-CARD', 'MARK-REFUND-REASON', 'MARK-PRIVATE-MESSAGE', 'MARK-REVIEW', 'MARK-CATEGORY', 'MARK-TELEGRAM', 'MARK-RESEND', 'MARK-SUPPLIER']
    const paths = ['/admin', '/admin/announcement', '/admin/cards/product', '/admin/categories', '/admin/collect', '/admin/data', '/admin/fulfillment',
        '/admin/inventory-api', '/admin/messages', '/admin/notifications', '/admin/orders', '/admin/orders/MARK-ORDER', '/admin/product/edit/product',
        '/admin/product/new', '/admin/products', '/admin/refunds', '/admin/reviews', '/admin/settings', '/admin/users',
        '/admin/data/download?type=full&format=json', '/admin/export/download?type=orders&format=csv']
    // Every admin page in the build must be covered here.
    const built = Object.keys(JSON.parse(readFileSync(new URL('../.next/server/app-paths-manifest.json', import.meta.url), 'utf8')))
        .filter(route => route.startsWith('/admin')).map(route => route.replace(/\/(page|route)$/, '') || '/admin')
    for (const route of built) {
        const pattern = new RegExp('^' + route.replace(/\[[^\]]+\]/g, '[^/]+') + '$')
        assert.ok(paths.some(pathname => pattern.test(pathname.split('?')[0])), 'Uncovered admin route: ' + route)
    }
    const outsider = await f.cookie('other', 'other-user')
    for (const [who, cookie] of [['anonymous', null], ['non-admin', outsider]]) {
        for (const pathname of paths) {
            for (const rsc of [false, true]) {
                const response = await f.request(pathname, { redirect: 'manual', headers: { ...(cookie ? { Cookie: cookie } : {}), ...(rsc ? { RSC: '1' } : {}) } })
                const body = await response.text()
                // A response may echo its own URL, so ignore marks the request already carried.
                const leaked = marks.filter(mark => !pathname.includes(mark) && body.includes(mark))
                assert.deepEqual(leaked, [], `${who} ${rsc ? 'RSC ' : ''}${pathname} (${response.status}) leaked ${leaked}`)
            }
        }
    }
    // The real admin still sees the data.
    const admin = await (await f.request('/admin/orders/MARK-ORDER', { headers: { Cookie: f.sessionCookie } })).text()
    assert.ok(admin.includes('MARK-CARD-KEY'))
    const products = await (await f.request('/admin/products', { headers: { Cookie: f.sessionCookie } })).text()
    assert.ok(products.includes('MARK-HIDDEN-PRODUCT'))
})

test('the production worker sends security headers and does not proxy arbitrary image URLs', async t => {
    const requested = []
    const f = await setup(t, { provider: async request => { requested.push(request.url); return undefined } })
    const home = await f.request('/')
    assert.equal(home.headers.get('x-frame-options'), 'DENY')
    assert.equal(home.headers.get('x-content-type-options'), 'nosniff')
    assert.ok(home.headers.get('content-security-policy').includes("frame-ancestors 'none'"))
    assert.ok(home.headers.get('referrer-policy'))
    await home.text()
    for (const target of ['http://internal.example/secret.png', 'http://169.254.169.254/latest/meta-data']) {
        const response = await f.request('/_next/image?url=' + encodeURIComponent(target) + '&w=64&q=75')
        await response.text()
        assert.notEqual(response.status, 200)
        assert.ok(!requested.some(url => url.startsWith(target)), 'The server requested ' + target)
    }
})

test('the deployed Worker refuses every administrator action and export to visitors and buyers', async t => {
    const f = await setup(t)
    await f.database.prepare('INSERT INTO orders (order_id, product_id, product_name, amount, status, user_id, username, card_key, trade_no) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').bind('GUARDED', 'product', 'Product', '3', 'delivered', 'owner', 'audit-admin', 'GUARDED-PRODUCTION-KEY', 'T1').run()
    await assertAdminSurfaceIsClosed(f)
})
