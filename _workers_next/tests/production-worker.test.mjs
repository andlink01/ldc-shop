import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { productionFixture } from './production-fixture.mjs'
import { fixture as browserFixture } from './database-fixture.mjs'

async function setup(t, options) {
    const f = await productionFixture(t, options)
    await f.initialize()
    await f.database.prepare('INSERT INTO products (id, name, price, is_active) VALUES (?, ?, ?, 1)').bind('product', 'Production test product', '3').run()
    await f.database.prepare('INSERT INTO login_users (user_id, username, points) VALUES (?, ?, 20)').bind('owner', 'audit-admin').run()
    return { ...f, sessionCookie: await f.cookie() }
}

async function pay(f, id) {
    const params = { pid: 'TEST-MERCHANT', out_trade_no: id, trade_no: 'production-test-trade', trade_status: 'TRADE_SUCCESS', money: '3.00', sign_type: 'MD5' }
    const sorted = Object.keys(params).filter(key => key !== 'sign_type').sort().map(key => `${key}=${params[key]}`).join('&')
    params.sign = createHash('md5').update(sorted + 'isolated-production-merchant-key').digest('hex')
    const response = await f.request(`/api/notify?${new URLSearchParams(params)}`)
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
    for (const session of ['', await f.cookie('other', 'other-user')]) {
        const response = await f.request('/order/private-order', { headers: { Cookie: `${session}; ldc_pending_order=private-order` } })
        assert.equal(response.status, 200)
        assert.ok(!(await response.text()).includes('PRIVATE-PRODUCTION-CARD'))
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
    let refunds = 0
    const f = await setup(t, { provider: async request => {
        const url = new URL(request.url)
        if (url.hostname !== 'credit.linux.do') return undefined
        if (url.searchParams.get('act') === 'refund') {
            assert.equal(request.method, 'POST')
            const form = await request.formData()
            assert.equal(form.get('money'), '3.00')
            refunds++
            return Response.json({ code: 1 })
        }
        assert.equal(url.searchParams.get('act'), 'order')
        return Response.json({ code: 1, status: 0, out_trade_no: url.searchParams.get('out_trade_no') })
    } })
    await f.database.prepare('INSERT INTO cards (product_id, card_key) VALUES (?, ?)').bind('product', 'REFUND-PRODUCTION-CARD').run()
    const created = await f.action('createOrder', '/buy/product', ['product', 1, '', false], f.sessionCookie)
    assert.equal(created.result?.success, true, created.body)
    const id = created.result.params.out_trade_no
    await pay(f, id)
    for (let attempt = 0; attempt < 2; attempt++) {
        const response = await f.action('proxyRefund', `/admin/orders/${id}`, [id], f.sessionCookie)
        assert.equal(response.result?.processed, true, response.body)
    }
    const verified = await f.action('verifyOrderRefundStatus', `/admin/orders/${id}`, [id], f.sessionCookie)
    assert.equal(verified.result?.success, true, verified.body)
    assert.equal(refunds, 1)
    const cards = await f.database.prepare('SELECT is_used FROM cards').bind().all()
    assert.equal(cards.results[0].is_used, 0)
    const orders = await f.database.prepare('SELECT status FROM orders WHERE order_id = ?').bind(id).all()
    assert.equal(orders.results[0].status, 'refunded')
})
