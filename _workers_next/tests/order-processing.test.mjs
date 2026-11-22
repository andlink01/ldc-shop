import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sql } from 'drizzle-orm'
import { fixture } from './database-fixture.mjs'

async function setup(t) {
    const f = fixture(t, { mocks: { '@/actions/admin': { checkAdmin: async () => {} } } })
    await f.ready
    await f.db.insert(f.schema.products).values({ id: 'product', name: 'Product', price: '3' })
    await f.db.insert(f.schema.loginUsers).values({ userId: 'user', username: 'buyer', points: 10 })
    return { ...f, ...f.load('lib/order-processing'), ...f.load('lib/order-transitions'), ...f.load('lib/fulfillment'), ...f.load('lib/checkout-inventory') }
}
const order = (extra = {}) => ({ orderId: 'order', productId: 'product', productName: 'Product', amount: '3', status: 'pending', userId: 'user', ...extra })

test('payment validates finite non-negative amounts and cannot revive refunded orders', async t => {
    const f = await setup(t)
    await f.db.insert(f.schema.orders).values(order())
    for (const amount of [NaN, Infinity, -3, 2.99]) await assert.rejects(f.processOrderFulfillment('order', amount, 'trade'))
    assert.equal((await f.db.select().from(f.schema.orders))[0].status, 'pending')
    await f.db.update(f.schema.orders).set({ status: 'refunded' })
    await f.processOrderFulfillment('order', 3, 'trade')
    assert.equal((await f.db.select().from(f.schema.orders))[0].status, 'refunded')
})

test('concurrent payment callbacks deliver and notify exactly once', async t => {
    const f = await setup(t)
    await f.db.insert(f.schema.orders).values(order())
    await f.db.insert(f.schema.cards).values({ productId: 'product', cardKey: 'key' })
    await Promise.all(Array.from({ length: 4 }, () => f.processOrderFulfillment('order', 3, 'trade')))
    assert.equal((await f.db.select().from(f.schema.orderDeliveries)).length, 1)
    assert.equal((await f.db.select().from(f.schema.userNotifications)).length, 1)
    const events = await f.db.select().from(f.schema.inventoryEvents)
    assert.equal(events.filter(e => e.kind === 'payment').length, 1)
    assert.equal(events.filter(e => e.kind === 'delivery').length, 1)
})

test('cancel returns points once; a late successful payment recharges them once and recovers delivery', async t => {
    const f = await setup(t)
    await f.db.insert(f.schema.orders).values(order({ pointsUsed: 2 }))
    await f.db.insert(f.schema.cards).values({ productId: 'product', cardKey: 'key', reservedOrderId: 'order', reservedAt: new Date() })
    await Promise.all([f.cancelPendingOrder('order'), f.cancelPendingOrder('order')])
    assert.equal((await f.db.select().from(f.schema.loginUsers))[0].points, 12)
    await Promise.all([f.processOrderFulfillment('order', 3, 'trade'), f.processOrderFulfillment('order', 3, 'trade')])
    assert.equal((await f.db.select().from(f.schema.loginUsers))[0].points, 10)
    assert.equal((await f.db.select().from(f.schema.orders))[0].status, 'delivered')
})

test('duplicate refunds return points and reclaim finite inventory only once', async t => {
    const f = await setup(t)
    await f.db.insert(f.schema.orders).values(order({ status: 'paid', pointsUsed: 2 }))
    await f.db.insert(f.schema.cards).values({ productId: 'product', cardKey: 'key' })
    await f.fulfillPaidOrder('order')
    await Promise.all([f.refundOrderInventory('order', true), f.refundOrderInventory('order', true)])
    assert.equal((await f.db.select().from(f.schema.loginUsers))[0].points, 12)
    assert.equal((await f.db.select().from(f.schema.cards))[0].isUsed, false)
    assert.equal((await f.db.select().from(f.schema.orders))[0].status, 'refunded')
    await f.processOrderFulfillment('order', 3, 'trade')
    assert.equal((await f.db.select().from(f.schema.cards))[0].isUsed, false)
})

test('paid stale reservations stay unavailable to other orders, expiry cleanup and normal checkout', async t => {
    const f = await setup(t)
    await f.db.insert(f.schema.orders).values(order({ status: 'paid', quantity: 2 }))
    await f.db.insert(f.schema.cards).values({ productId: 'product', cardKey: 'key', reservedOrderId: 'order', reservedAt: new Date(0) })
    const stats = await f.queries.getLiveCardStats(['product'])
    assert.equal(stats.get('product').available, 0)
    assert.equal(stats.get('product').locked, 1)
    assert.equal((await f.commitCheckoutOrder({ orderId: 'other', productId: 'product', productName: 'Product', price: '3', shared: false, onDemand: false,
        quantity: 1, amount: 3, points: 0, userId: 'user', username: 'buyer', email: null, purchaseLimit: null })).success, false)
})

test('zero price and points orders use the same atomic fulfillment and protect concurrent points balances', async t => {
    const f = await setup(t)
    await f.db.insert(f.schema.cards).values([{ productId: 'product', cardKey: 'one' }, { productId: 'product', cardKey: 'two' }])
    const input = id => ({ orderId: id, productId: 'product', productName: 'Product', price: '3', shared: false, onDemand: false,
        quantity: 1, amount: 0, points: 8, userId: 'user', username: 'buyer', email: null, purchaseLimit: null })
    const results = await Promise.all([f.commitCheckoutOrder(input('first')), f.commitCheckoutOrder(input('second'))])
    assert.equal(results.filter(r => r.success).length, 1)
    assert.equal((await f.db.select().from(f.schema.loginUsers))[0].points, 2)
    assert.equal((await f.db.select().from(f.schema.orders))[0].status, 'delivered')
    assert.equal((await f.db.select().from(f.schema.orderDeliveries)).length, 1)
})

test('legacy paid orders containing keys can be marked delivered without issuing another key or duplicating inbox messages', async t => {
    const f = await setup(t)
    await f.db.insert(f.schema.orders).values(order({ status: 'paid', cardKey: 'existing-key', cardIds: '1' }))
    await f.db.insert(f.schema.cards).values({ productId: 'product', cardKey: 'existing-key', isUsed: true })
    const actions = f.load('actions/admin-orders')
    await Promise.all([actions.markOrderDelivered('order'), actions.markOrderDelivered('order')])
    assert.equal((await f.db.select().from(f.schema.orders))[0].status, 'delivered')
    assert.equal((await f.db.select().from(f.schema.cards)).length, 1)
    assert.equal((await f.db.select().from(f.schema.userNotifications)).length, 1)
})

test('a delivery storage failure preserves confirmed payment and is recoverable without charging again', async t => {
    const f = await setup(t)
    await f.db.insert(f.schema.orders).values(order())
    await f.db.insert(f.schema.cards).values({ productId: 'product', cardKey: 'key' })
    await f.dbRun(sql.raw("CREATE TRIGGER fail_delivery BEFORE UPDATE ON orders WHEN NEW.status = 'delivered' BEGIN SELECT RAISE(ABORT, 'test'); END;"))
    assert.equal((await f.processOrderFulfillment('order', 3, 'trade')).success, true)
    assert.equal((await f.db.select().from(f.schema.orders))[0].status, 'paid')
    assert.equal((await f.db.select().from(f.schema.cards))[0].isUsed, false)
    await f.dbRun(sql.raw('DROP TRIGGER fail_delivery'))
    assert.equal((await f.fulfillPendingOrders('product')).delivered, 1)
})
