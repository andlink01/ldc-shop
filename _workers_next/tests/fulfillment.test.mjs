import assert from 'node:assert/strict'
import { test } from 'node:test'
import { eq, sql } from 'drizzle-orm'
import { fixture } from './database-fixture.mjs'

async function setup(t, shared = false) {
    const f = fixture(t)
    await f.ready
    await f.db.insert(f.schema.products).values({ id: 'product', name: 'Product', price: '1.00', isShared: shared })
    await f.db.insert(f.schema.loginUsers).values({ userId: 'user', username: 'buyer' })
    return { ...f, ...f.load('lib/fulfillment') }
}
const order = (id, quantity = 1, extra = {}) => ({ orderId: id, productId: 'product', productName: 'Product', amount: '1.00', status: 'paid', quantity, userId: 'user', paidAt: new Date(), ...extra })

test('paid orders prefer expiring stock and reject expired, used and other active reservations', async (t) => {
    const f = await setup(t)
    await f.db.insert(f.schema.orders).values(order('order'))
    await f.db.insert(f.schema.cards).values([
        { productId: 'product', cardKey: 'permanent' },
        { productId: 'product', cardKey: 'expired', expiresAt: new Date(Date.now() - 1) },
        { productId: 'product', cardKey: 'used', isUsed: true },
        { productId: 'product', cardKey: 'locked', reservedOrderId: 'other', reservedAt: new Date() },
        { productId: 'product', cardKey: 'soon', expiresAt: new Date(Date.now() + 60_000) },
    ])
    assert.equal((await f.fulfillPaidOrder('order')).delivered, true)
    assert.equal((await f.db.select().from(f.schema.orders))[0].cardKey, 'soon')
    assert.equal((await f.db.select().from(f.schema.cards).where(eq(f.schema.cards.cardKey, 'locked')))[0].isUsed, false)
})

test('an order keeps its own valid reservation before claiming free stock', async (t) => {
    const f = await setup(t)
    await f.db.insert(f.schema.orders).values(order('order'))
    await f.db.insert(f.schema.cards).values([
        { productId: 'product', cardKey: 'free', expiresAt: new Date(Date.now() + 60_000) },
        { productId: 'product', cardKey: 'reserved', reservedOrderId: 'order', reservedAt: new Date() },
    ])
    await f.fulfillPaidOrder('order')
    assert.equal((await f.db.select().from(f.schema.orders))[0].cardKey, 'reserved')
})

test('quantity is fulfilled all at once; shortages consume no cards', async (t) => {
    const f = await setup(t)
    await f.db.insert(f.schema.orders).values(order('order', 2))
    await f.db.insert(f.schema.cards).values({ productId: 'product', cardKey: 'one' })
    assert.equal((await f.fulfillPaidOrder('order')).delivered, false)
    assert.equal((await f.db.select().from(f.schema.cards))[0].isUsed, false)
    assert.equal((await f.db.select().from(f.schema.orderDeliveries)).length, 0)
    await f.db.insert(f.schema.cards).values({ productId: 'product', cardKey: 'two' })
    assert.equal((await f.fulfillPendingOrders('product')).delivered, 1)
    assert.equal((await f.db.select().from(f.schema.orders))[0].cardKey, 'one\ntwo')
})

test('concurrent attempts for the same order produce one receipt, inbox message and delivery event', async (t) => {
    const f = await setup(t)
    await f.db.insert(f.schema.orders).values(order('order'))
    await f.db.insert(f.schema.cards).values([{ productId: 'product', cardKey: 'one' }, { productId: 'product', cardKey: 'two' }])
    const replies = await Promise.all(Array.from({ length: 4 }, () => f.fulfillPaidOrder('order')))
    assert.equal(replies.filter((reply) => reply.delivered && !reply.replayed).length, 1)
    assert.equal((await f.db.select().from(f.schema.orderDeliveries)).length, 1)
    assert.equal((await f.db.select().from(f.schema.userNotifications)).length, 1)
    assert.equal((await f.db.select().from(f.schema.inventoryEvents)).length, 1)
    assert.equal((await f.db.select().from(f.schema.cards)).filter((card) => card.isUsed).length, 1)
})

test('two concurrent paid orders cannot receive the same finite card', async (t) => {
    const f = await setup(t)
    await f.db.insert(f.schema.orders).values([order('first'), order('second')])
    await f.db.insert(f.schema.cards).values({ productId: 'product', cardKey: 'unique' })
    const replies = await Promise.all(['first', 'second'].map(f.fulfillPaidOrder))
    assert.equal(replies.filter((reply) => reply.delivered).length, 1)
    assert.equal((await f.db.select().from(f.schema.orders)).filter((row) => row.status === 'paid').length, 1)
})

test('shared products repeat one valid key and keep the inventory unused', async (t) => {
    const f = await setup(t, true)
    await f.db.insert(f.schema.orders).values(order('order', 3))
    await f.db.insert(f.schema.cards).values([{ productId: 'product', cardKey: 'expired', expiresAt: new Date(0) }, { productId: 'product', cardKey: 'shared' }])
    await f.fulfillPaidOrder('order')
    assert.equal((await f.db.select().from(f.schema.orders))[0].cardKey, 'shared\nshared\nshared')
    assert.ok((await f.db.select().from(f.schema.cards)).every((card) => !card.isUsed))
})

test('unpaid, cancelled and refunded orders do not consume stock', async (t) => {
    const f = await setup(t)
    await f.db.insert(f.schema.cards).values({ productId: 'product', cardKey: 'key' })
    for (const status of ['pending', 'cancelled', 'refunded']) {
        await f.db.insert(f.schema.orders).values(order(status, 1, { status }))
        assert.equal((await f.fulfillPaidOrder(status)).delivered, false)
    }
    assert.equal((await f.db.select().from(f.schema.cards))[0].isUsed, false)
})

test('a storage failure rolls back stock consumption, receipt and order state', async (t) => {
    const f = await setup(t)
    await f.db.insert(f.schema.orders).values(order('order'))
    await f.db.insert(f.schema.cards).values({ productId: 'product', cardKey: 'key' })
    await f.dbRun(sql.raw("CREATE TRIGGER fail_delivery BEFORE UPDATE ON orders WHEN NEW.status = 'delivered' BEGIN SELECT RAISE(ABORT, 'test'); END;"))
    await assert.rejects(f.fulfillPaidOrder('order'))
    assert.equal((await f.db.select().from(f.schema.cards))[0].isUsed, false)
    assert.equal((await f.db.select().from(f.schema.orders))[0].status, 'paid')
    assert.equal((await f.db.select().from(f.schema.orderDeliveries)).length, 0)
})
