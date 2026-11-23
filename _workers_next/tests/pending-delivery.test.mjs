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
