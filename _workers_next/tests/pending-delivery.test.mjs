import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fixture } from './database-fixture.mjs'

async function setup(t) {
    const f = fixture(t)
    await f.ready
    await f.db.insert(f.schema.products).values({ id: 'product', name: 'Current name', price: '3', variantLabel: 'Monthly' })
    return { ...f, read: f.load('lib/admin-fulfillment').getPendingDeliveryOrders }
}

test('pending delivery lists only paid unfulfilled product orders, with stable pages beyond 200 orders', async t => {
    const f = await setup(t)
    for (let i = 0; i < 205; i++) await f.db.insert(f.schema.orders).values({ orderId: `ORD-${String(i).padStart(3, '0')}`, productId: 'product', productName: 'Purchased name', amount: '3',
        status: 'paid', paidAt: new Date(1_800_000_000_000 + i), quantity: 2, username: 'buyer', userId: 'buyer-id' })
    for (const [id, status, cardKey, productId] of [['pending', 'pending', null, 'product'], ['done', 'delivered', 'CARD', 'product'],
        ['paid-card', 'paid', 'CARD', 'product'], ['refund', 'refunded', null, 'product'], ['payment', 'paid', null, 'payment_link']]) {
        await f.db.insert(f.schema.orders).values({ orderId: id, productId, productName: 'Excluded', amount: '3', status, cardKey })
    }
    const first = await f.read(), last = await f.read({ page: '999' })
    assert.equal(first.total, 205)
    assert.equal(first.orders.length, 50)
    assert.equal(first.orders[0].orderId, 'ORD-000')
    assert.equal(first.orders[0].variantLabel, 'Monthly')
    assert.equal(first.orders[0].quantity, 2)
    assert.equal(last.page, 5)
    assert.equal(last.orders.length, 5)
    assert.equal(last.orders[4].orderId, 'ORD-204')
    for (const page of ['0', '-1', 'bad', 'Infinity', '1.5']) assert.equal((await f.read({ page })).page, 1)
    await f.db.delete(f.schema.products)
    assert.equal((await f.read()).orders[0].productName, 'Purchased name')
})

test('search runs across every page and empty or hostile queries do not expose unrelated orders', async t => {
    const f = await setup(t)
    await f.db.insert(f.schema.orders).values([
        { orderId: 'first', productId: 'product', productName: 'A', amount: '3', status: 'paid', username: 'alice', email: 'mail@example.com' },
        { orderId: 'second', productId: 'product', productName: 'Unique product', amount: '3', status: 'paid', username: 'bob' },
    ])
    for (const q of ['first', 'alice', 'mail@example.com']) assert.equal((await f.read({ q })).orders[0].orderId, 'first')
    assert.equal((await f.read({ q: 'Unique' })).total, 1)
    assert.equal((await f.read({ q: "' OR 1=1 --" })).total, 0)
    const empty = await f.read({ q: 'missing', page: '999' })
    assert.equal(empty.total, 0)
    assert.equal(empty.page, 1)
})

test('active supplier work overrides obsolete failures and task-only failures are visible', async t => {
    const f = await setup(t)
    await f.db.insert(f.schema.orders).values({ orderId: 'order', productId: 'product', productName: 'A', amount: '3', status: 'paid' })
    await f.load('lib/card-api').saveProductCardApiConfig('product', { mode: 'on_demand', enabled: true, url: 'https://supplier.example/cards', token: '' })
    assert.equal((await f.read()).orders[0].onDemand, 1)
    await f.db.insert(f.schema.supplierRequests).values({ requestId: 'req', orderId: 'order', itemIndex: 0, serverUrl: 'https://supplier.example', createdAt: new Date(), error: 'supplier_http_521' })
    assert.equal((await f.read()).orders[0].supplierError, 'supplier_http_521')
    await f.db.insert(f.schema.inventoryEvents).values({ eventId: 'supplier:order', kind: 'supplier', orderId: 'order', createdAt: new Date(), error: 'supplier_disabled' })
        .onConflictDoUpdate({ target: f.schema.inventoryEvents.eventId, set: { error: 'supplier_disabled' } })
    assert.equal((await f.read()).orders[0].supplierError, 'supplier_disabled')
    const { eq } = await import('drizzle-orm')
    await f.db.update(f.schema.inventoryEvents).set({ leaseUntil: new Date(Date.now() + 60_000) }).where(eq(f.schema.inventoryEvents.eventId, 'supplier:order'))
    assert.equal((await f.read()).orders[0].supplierError, 'supplier_request_in_progress')
    await f.db.update(f.schema.inventoryEvents).set({ completedAt: new Date(), leaseUntil: null }).where(eq(f.schema.inventoryEvents.eventId, 'supplier:order'))
    await f.db.update(f.schema.supplierRequests).set({ state: 'received' }).where(eq(f.schema.supplierRequests.requestId, 'req'))
    assert.equal((await f.read()).orders[0].supplierError, null)
})

test('delivery issue explanations distinguish HTTP, processing and data failures without rendering supplier secrets', t => {
    const f = fixture(t, { initialize: false })
    const { getDeliveryIssue: issue } = f.load('lib/delivery-issue')
    assert.equal(issue('supplier_http_521').key, 'unavailable')
    assert.equal(issue('supplier_http_521').status, 521)
    assert.equal(issue('supplier_http_401').key, 'unauthorized')
    assert.equal(issue('supplier_http_403').key, 'unauthorized')
    assert.equal(issue('supplier_http_429').key, 'rateLimited')
    assert.equal(issue('supplier_http_307').key, 'redirect')
    assert.equal(issue('supplier_processing').severity, 'processing')
    assert.equal(issue('supplier_invalid_response').key, 'invalidResponse')
    assert.equal(issue(null).key, 'stock')
    assert.equal(issue(null, true).key, 'waiting')
    assert.equal(issue(null, true).code, undefined)
    assert.equal(issue('https://supplier.example?token=PRIVATE').code, undefined)
    assert.equal(issue('constructor').code, undefined)
    for (const locale of ['zh', 'en']) {
        const translations = f.load(`locales/${locale}.json`).inventory
        for (const code of [null, 'supplier_http_521', 'supplier_http_400', 'supplier_invalid_response', 'supplier_processing', 'supplier_disabled']) {
            const message = translations.deliveryIssue[issue(code).key]
            assert.equal(typeof message, 'string')
            assert.ok(!message.includes('??'))
        }
    }
})

test('manual retries replace old task errors immediately and clear them after delivery', async t => {
    const f = await setup(t)
    const { eq } = await import('drizzle-orm')
    await f.db.insert(f.schema.orders).values({ orderId: 'retry', productId: 'product', productName: 'A', amount: '3', status: 'paid' })
    await f.load('lib/card-api').saveProductCardApiConfig('product', { mode: 'on_demand', enabled: true, url: 'https://supplier.example/cards', token: 'ISOLATED-TOKEN' })
    await f.db.update(f.schema.inventoryEvents).set({ error: 'supplier_http_401', nextAttemptAt: new Date(Date.now() + 3_600_000) })
        .where(eq(f.schema.inventoryEvents.eventId, 'supplier:retry'))
    const ids = []
    let healthy = false
    f.setFetch(async (_, options) => {
        const body = JSON.parse(options.body)
        ids.push(body.requestId)
        return healthy ? Response.json({ success: true, requestId: body.requestId, data: { cardKey: 'RETRY-ONCE-CARD' } }) : new Response(null, { status: 521 })
    })
    const retry = f.load('lib/retry-delivery').retryPaidOrderDelivery
    const failed = await retry('retry')
    assert.equal(failed.supplierError, 'supplier_http_521')
    assert.equal((await f.read()).orders[0].supplierError, 'supplier_http_521')
    assert.equal(ids.length, 1)
    healthy = true
    const done = await retry('retry')
    assert.equal(done.delivered, true)
    assert.equal(done.supplierError, null)
    assert.equal(ids.length, 2)
    assert.equal(ids[0], ids[1])
    assert.equal((await f.read()).total, 0)
    const event = await f.db.query.inventoryEvents.findFirst({ where: eq(f.schema.inventoryEvents.eventId, 'supplier:retry') })
    assert.equal(event.error, null)
    assert.ok(event.completedAt)
    const repeated = await Promise.all(Array.from({ length: 5 }, () => retry('retry')))
    assert.ok(repeated.every(result => result.delivered))
    assert.equal(ids.length, 2)
    assert.equal((await f.db.select().from(f.schema.orderDeliveries)).length, 1)
})

test('manual retries leave active background work alone and report ordinary stock and disabled suppliers accurately', async t => {
    const f = await setup(t)
    const { eq } = await import('drizzle-orm')
    await f.db.insert(f.schema.orders).values({ orderId: 'retry', productId: 'product', productName: 'A', amount: '3', status: 'paid' })
    const retry = f.load('lib/retry-delivery').retryPaidOrderDelivery
    assert.equal((await retry('retry')).supplierError, null)
    await f.load('lib/card-api').saveProductCardApiConfig('product', { mode: 'on_demand', enabled: true, url: 'https://supplier.example/cards', token: '' })
    await f.db.update(f.schema.inventoryEvents).set({ error: 'supplier_http_401', leaseToken: 'background-owner', leaseUntil: new Date(Date.now() + 60_000) })
        .where(eq(f.schema.inventoryEvents.eventId, 'supplier:retry'))
    f.setFetch(() => assert.fail('An active task must not be purchased again'))
    assert.equal((await retry('retry')).supplierError, 'supplier_request_in_progress')
    const owned = await f.db.query.inventoryEvents.findFirst({ where: eq(f.schema.inventoryEvents.eventId, 'supplier:retry') })
    assert.equal(owned.leaseToken, 'background-owner')
    assert.equal(owned.error, 'supplier_http_401')
    await f.db.update(f.schema.inventoryEvents).set({ leaseToken: null, leaseUntil: null }).where(eq(f.schema.inventoryEvents.eventId, 'supplier:retry'))
    await f.load('lib/card-api').saveProductCardApiConfig('product', { mode: 'on_demand', enabled: false, url: 'https://supplier.example/cards', token: '' })
    assert.equal((await retry('retry')).supplierError, 'supplier_disabled')
    assert.equal((await f.read()).orders[0].supplierError, 'supplier_disabled')
})

test('concurrent manual retries share one supplier request and one delivery receipt', async t => {
    const f = await setup(t)
    await f.db.insert(f.schema.orders).values({ orderId: 'concurrent', productId: 'product', productName: 'A', amount: '3', status: 'paid' })
    await f.load('lib/card-api').saveProductCardApiConfig('product', { mode: 'on_demand', enabled: true, url: 'https://supplier.example/cards', token: '' })
    let started, release, purchases = 0
    const waiting = new Promise(resolve => { started = resolve })
    f.setFetch(async (_, options) => {
        purchases++
        started()
        await new Promise(resolve => { release = resolve })
        return Response.json({ success: true, requestId: JSON.parse(options.body).requestId, data: { cardKey: 'ONE-CONCURRENT-CARD' } })
    })
    const retry = f.load('lib/retry-delivery').retryPaidOrderDelivery
    const first = retry('concurrent')
    await waiting
    const others = await Promise.all(Array.from({ length: 5 }, () => retry('concurrent')))
    assert.ok(others.every(result => !result.delivered && result.supplierError === 'supplier_request_in_progress'))
    assert.equal(purchases, 1)
    release()
    assert.equal((await first).delivered, true)
    assert.equal((await f.db.select().from(f.schema.orderDeliveries)).length, 1)
    assert.equal(purchases, 1)
})

test('products keep independent supplier addresses, tokens, modes and enabled states during delivery', async t => {
    const f = await setup(t)
    await f.db.insert(f.schema.products).values({ id: 'second', name: 'Second', price: '4' })
    await f.db.insert(f.schema.orders).values([
        { orderId: 'first-order', productId: 'product', productName: 'First', amount: '3', status: 'paid' },
        { orderId: 'second-order', productId: 'second', productName: 'Second', amount: '4', status: 'paid' },
    ])
    const cardApi = f.load('lib/card-api')
    await cardApi.saveProductCardApiConfig('product', { enabled: true, mode: 'on_demand', url: 'https://first.example/cards', token: 'ISOLATED-FIRST' })
    await cardApi.saveProductCardApiConfig('second', { enabled: false, mode: 'stock', url: 'https://second.example/cards', token: 'ISOLATED-SECOND' })
    const firstConfig = await cardApi.getProductCardApiConfig('product')
    assert.equal(firstConfig.enabled, true)
    assert.equal(firstConfig.mode, 'on_demand')
    assert.equal(firstConfig.token, 'ISOLATED-FIRST')
    const calls = []
    f.setFetch(async (url, options) => {
        const body = JSON.parse(options.body)
        calls.push({ url, token: options.headers.Authorization, productId: body.productId })
        return Response.json({ success: true, requestId: body.requestId, data: { cardKey: `ISOLATED-CARD-${body.productId}` } })
    })
    const retry = f.load('lib/retry-delivery').retryPaidOrderDelivery
    assert.equal((await retry('first-order')).delivered, true)
    assert.equal((await retry('second-order')).delivered, false)
    assert.equal(calls.length, 1)
    await cardApi.saveProductCardApiConfig('second', { enabled: true, mode: 'on_demand', url: 'https://second.example/cards', token: 'ISOLATED-SECOND' })
    assert.equal((await retry('second-order')).delivered, true)
    assert.deepEqual(calls, [
        { url: 'https://first.example/cards', token: 'Bearer ISOLATED-FIRST', productId: 'product' },
        { url: 'https://second.example/cards', token: 'Bearer ISOLATED-SECOND', productId: 'second' },
    ])
})
