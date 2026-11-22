import assert from 'node:assert/strict'
import { test } from 'node:test'
import { eq, sql } from 'drizzle-orm'
import { fixture } from './database-fixture.mjs'

async function setup(t) {
    const f = fixture(t)
    await f.ready
    await f.db.insert(f.schema.products).values({ id: 'product', name: 'Product', price: '1' })
    await f.db.insert(f.schema.loginUsers).values({ userId: 'user', username: 'buyer', points: 10 })
    await f.load('lib/card-api').saveProductCardApiConfig('product', { enabled: true, mode: 'on_demand', url: 'https://supplier.example/cards', token: 'PRIVATE-TOKEN' })
    return { ...f, ...f.load('lib/supplier-fulfillment'), ...f.load('lib/checkout-inventory'), ...f.load('lib/order-processing'), ...f.load('lib/order-transitions') }
}
const input = (id, extra = {}) => ({ orderId: id, productId: 'product', productName: 'Product', price: '1', shared: false, onDemand: true, quantity: 1, amount: 1, points: 0, userId: 'user', username: 'buyer', email: null, purchaseLimit: null, ...extra })
async function paid(f, id = 'order', quantity = 1) {
    assert.equal((await f.commitCheckoutOrder(input(id, { quantity, amount: quantity }))).success, true)
    await f.processOrderFulfillment(id, quantity, `trade-${id}`)
}
function success(requestId, key = `key-${requestId}`) {
    return Response.json({ success: true, requestId, data: { cardKey: key, expiresAt: new Date(Date.now() + 3600000).toISOString() } })
}

test('on-demand checkout succeeds with zero cards and purchases only after payment', async t => {
    const f = await setup(t)
    let fetched = 0
    f.setFetch(async (url, options) => {
        fetched++
        assert.equal(url, 'https://supplier.example/cards')
        assert.equal(options.method, 'POST')
        const body = JSON.parse(options.body)
        assert.equal(options.headers['Idempotency-Key'], body.requestId)
        assert.equal(options.headers.Authorization, 'Bearer PRIVATE-TOKEN')
        assert.equal(body.orderId, 'order')
        assert.equal(body.quantity, 1)
        return success(body.requestId)
    })
    await f.commitCheckoutOrder(input('order'))
    assert.equal((await f.procureOrderCards('order')).done, true)
    assert.equal(fetched, 0)
    assert.equal((await f.db.select().from(f.schema.cards)).length, 0)
    await f.processOrderFulfillment('order', 1, 'trade')
    assert.equal((await f.db.select().from(f.schema.orders))[0].status, 'paid')
    assert.equal((await f.procureOrderCards('order')).done, true)
    assert.equal(fetched, 1)
    assert.equal((await f.db.select().from(f.schema.orders))[0].status, 'delivered')
    await f.procureOrderCards('order')
    assert.equal(fetched, 1)
})

test('timeouts and HTTP 202 retain the same request ID across retries and module reloads', async t => {
    const f = await setup(t)
    await paid(f)
    const ids = []
    f.setFetch(async (_, options) => {
        const body = JSON.parse(options.body); ids.push(body.requestId)
        if (ids.length === 1) throw new Error('Simulated timeout')
        if (ids.length === 2) return Response.json({ requestId: body.requestId, status: 'processing' }, { status: 202 })
        return success(body.requestId)
    })
    assert.equal((await f.procureOrderCards('order')).done, false)
    assert.equal((await f.reload('lib/supplier-fulfillment').procureOrderCards('order')).done, false)
    assert.equal((await f.procureOrderCards('order')).done, true)
    assert.equal(new Set(ids).size, 1)
    assert.equal((await f.db.select().from(f.schema.cards)).length, 1)
})

test('a slow supplier request is leased so concurrent recovery cannot purchase twice', async t => {
    const f = await setup(t)
    await paid(f)
    let release, started
    const requested = new Promise(resolve => { started = resolve })
    let calls = 0
    f.setFetch(async (_, options) => {
        calls++; started()
        await new Promise(resolve => { release = resolve })
        return success(JSON.parse(options.body).requestId)
    })
    const first = f.procureOrderCards('order')
    await requested
    assert.equal((await f.procureOrderCards('order')).done, false)
    assert.equal(calls, 1)
    release()
    assert.equal((await first).done, true)
    assert.equal((await f.db.select().from(f.schema.orderDeliveries)).length, 1)
})

test('supplier cards are reserved to their paid order and delivered only when the entire quantity is ready', async t => {
    const f = await setup(t)
    await paid(f, 'first', 2)
    await paid(f, 'second')
    f.setFetch(async (_, options) => success(JSON.parse(options.body).requestId))
    assert.equal((await f.procureOrderCards('first', 1)).done, false)
    const card = (await f.db.select().from(f.schema.cards))[0]
    assert.equal(card.reservedOrderId, 'first')
    assert.equal(card.isUsed, false)
    assert.equal((await f.load('lib/fulfillment').fulfillPaidOrder('second')).delivered, false)
    assert.equal((await f.procureOrderCards('first', 1)).done, true)
    const delivered = (await f.db.select().from(f.schema.orders).where(eq(f.schema.orders.orderId, 'first')))[0]
    assert.equal(delivered.cardKey.split('\n').length, 2)
})

test('supplier storage failure rolls back the new card and retries the same upstream purchase', async t => {
    const f = await setup(t)
    await paid(f)
    const ids = []
    f.setFetch(async (_, options) => { const id = JSON.parse(options.body).requestId; ids.push(id); return success(id) })
    await f.dbRun(sql.raw("CREATE TRIGGER fail_supplier BEFORE UPDATE ON supplier_requests WHEN NEW.state = 'received' BEGIN SELECT RAISE(ABORT, 'test'); END;"))
    assert.equal((await f.procureOrderCards('order')).done, false)
    assert.equal((await f.db.select().from(f.schema.cards)).length, 0)
    await f.dbRun(sql.raw('DROP TRIGGER fail_supplier'))
    assert.equal((await f.procureOrderCards('order')).done, true)
    assert.equal(new Set(ids).size, 1)
})

test('a refund while the supplier is generating prevents delivery and preserves the purchased card as stock', async t => {
    const f = await setup(t)
    await paid(f)
    let release, started
    const requested = new Promise(resolve => { started = resolve })
    f.setFetch(async (_, options) => { started(); await new Promise(resolve => { release = resolve }); return success(JSON.parse(options.body).requestId) })
    const purchase = f.procureOrderCards('order')
    await requested
    await f.refundOrderInventory('order', true)
    release(); await purchase
    assert.equal((await f.db.select().from(f.schema.orders))[0].status, 'refunded')
    const card = (await f.db.select().from(f.schema.cards))[0]
    assert.equal(card.isUsed, false)
    assert.equal(card.reservedOrderId, null)
    assert.equal((await f.db.select().from(f.schema.orderDeliveries)).length, 0)
})

test('invalid, expired or duplicate supplier cards never produce a partial delivery', async t => {
    const f = await setup(t)
    await paid(f, 'order', 2)
    f.setFetch(async (_, options) => success(JSON.parse(options.body).requestId, 'duplicate'))
    assert.equal((await f.procureOrderCards('order')).done, false)
    assert.equal((await f.db.select().from(f.schema.orders))[0].status, 'paid')
    assert.equal((await f.db.select().from(f.schema.cards)).length, 1)
    const row = (await f.db.select().from(f.schema.supplierRequests)).find(r => r.state === 'pending')
    assert.equal(row.error, 'supplier_duplicate_card')
    f.setFetch(async (_, options) => Response.json({ success: true, requestId: JSON.parse(options.body).requestId, data: { cardKey: 'expired', expiresAt: new Date(0).toISOString() } }))
    assert.equal((await f.procureOrderCards('order')).done, false)
    assert.equal((await f.db.select().from(f.schema.cards)).length, 1)
})

test('changing the supplier endpoint cannot send an existing purchase ID to another supplier', async t => {
    const f = await setup(t)
    await paid(f)
    let calls = 0
    f.setFetch(async () => { calls++; return new Response(null, { status: 503 }) })
    await f.procureOrderCards('order')
    await f.load('lib/card-api').saveProductCardApiConfig('product', { enabled: true, mode: 'on_demand', url: 'https://another.example/cards', token: '' })
    assert.equal((await f.procureOrderCards('order')).error, 'supplier_endpoint_changed')
    assert.equal(calls, 1)
})

test('ordinary products still require stock; points and order writes roll back on failure', async t => {
    const f = await setup(t)
    assert.equal((await f.commitCheckoutOrder(input('no-stock', { onDemand: false }))).success, false)
    await f.db.insert(f.schema.cards).values({ productId: 'product', cardKey: 'key' })
    await f.dbRun(sql.raw("CREATE TRIGGER fail_claim BEFORE UPDATE ON cards WHEN NEW.reserved_order_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'test'); END;"))
    await assert.rejects(f.commitCheckoutOrder(input('failure', { onDemand: false, amount: 0, points: 1 })))
    assert.equal((await f.db.select().from(f.schema.loginUsers))[0].points, 10)
    assert.equal((await f.db.select().from(f.schema.orders)).length, 0)
})
