import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { productionFixture } from './production-fixture.mjs'

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
