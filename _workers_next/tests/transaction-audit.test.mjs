import assert from 'node:assert/strict'
import { test } from 'node:test'
import { eq, sql } from 'drizzle-orm'
import { fixture } from './database-fixture.mjs'

async function setup(t, { user = { id: 'owner', username: 'buyer' }, cookie } = {}) {
    const f = fixture(t, { mocks: {
        '@/lib/auth': { auth: async () => user ? { user } : null },
        '@/actions/admin': { checkAdmin: async () => {} },
        'next/headers': { cookies: async () => ({ get: () => cookie ? { value: cookie } : undefined }) },
        'next/navigation': { notFound() { throw new Error('Not found') } },
        '@/components/order-content': { OrderContent() {} },
    } })
    await f.ready
    await f.db.insert(f.schema.products).values({ id: 'product', name: 'Product', price: '3' })
    await f.db.insert(f.schema.loginUsers).values({ userId: 'owner', username: 'buyer', points: 8 })
    return f
}
const order = (id = 'order', extra = {}) => ({ orderId: id, productId: 'product', productName: 'Product', userId: 'owner', username: 'buyer', amount: '3', pointsUsed: 2, ...extra })

test('order page does not send card secrets to anonymous or unrelated users, including a forged pending cookie', async t => {
    for (const user of [null, { id: 'other', username: 'other' }]) {
        const f = await setup(t, { user, cookie: 'order' })
        await f.db.insert(f.schema.orders).values(order('order', { status: 'delivered', cardKey: 'PRIVATE-CARD' }))
        const page = await f.load('app/order/[id]/page').default({ params: Promise.resolve({ id: 'order' }) })
        assert.equal(page.props.canViewKey, false)
        assert.equal(page.props.order.cardKey, null)
    }
})

test('order status checks reject another user even if its pending cookie names the order', async t => {
    const f = await setup(t, { user: { id: 'other', username: 'other' }, cookie: 'order' })
    await f.db.insert(f.schema.orders).values(order('order', { status: 'paid' }))
    assert.equal((await f.load('actions/order').checkOrderStatus('order')).success, false)
})

test('deleting a cancelled or refunded order does not return its points twice', async t => {
    for (const kind of ['cancelled', 'refunded']) {
        const f = await setup(t)
        await f.db.insert(f.schema.orders).values(order('order', { status: kind === 'cancelled' ? 'pending' : 'paid' }))
        const transitions = f.load('lib/order-transitions')
        if (kind === 'cancelled') await transitions.cancelPendingOrder('order')
        else await transitions.refundOrderInventory('order', true)
        assert.equal((await f.db.select().from(f.schema.loginUsers))[0].points, 10)
        await f.load('actions/admin-orders').deleteOrder('order')
        assert.equal((await f.db.select().from(f.schema.loginUsers))[0].points, 10)
    }
})

test('concurrent pending order deletion returns points once and rolls back when deletion fails', async t => {
    const f = await setup(t)
    await f.db.insert(f.schema.orders).values(order())
    await f.db.insert(f.schema.cards).values({ productId: 'product', cardKey: 'reserved', reservedOrderId: 'order', reservedAt: new Date() })
    await f.dbRun(sql.raw("CREATE TRIGGER isolated_delete_failure BEFORE DELETE ON orders BEGIN SELECT RAISE(ABORT, 'test'); END;"))
    const actions = f.load('actions/admin-orders')
    await assert.rejects(actions.deleteOrder('order'))
    assert.equal((await f.db.select().from(f.schema.loginUsers))[0].points, 8)
    assert.equal((await f.db.select().from(f.schema.cards))[0].reservedOrderId, 'order')
    await f.dbRun(sql.raw('DROP TRIGGER isolated_delete_failure'))
    await Promise.all([actions.deleteOrder('order'), actions.deleteOrder('order')])
    assert.equal((await f.db.select().from(f.schema.loginUsers))[0].points, 10)
    assert.equal((await f.db.select().from(f.schema.orders)).length, 0)
})

test('refund verification applies the same card and point recovery as normal refunds', async t => {
    const f = await setup(t)
    f.env.MERCHANT_ID = 'test-merchant'; f.env.MERCHANT_KEY = 'test-merchant-key'
    await f.db.insert(f.schema.orders).values(order('order', { status: 'paid', tradeNo: 'test-trade' }))
    await f.db.insert(f.schema.cards).values({ productId: 'product', cardKey: 'card' })
    await f.load('lib/fulfillment').fulfillPaidOrder('order')
    f.setFetch(async () => Response.json({ code: 1, status: 0, trade_no: 'test-trade' }))
    assert.equal((await f.load('actions/admin-orders').verifyOrderRefundStatus('order')).success, true)
    assert.equal((await f.db.select().from(f.schema.cards))[0].isUsed, false)
    assert.equal((await f.db.select().from(f.schema.loginUsers))[0].points, 10)
    await f.load('actions/admin-orders').verifyOrderRefundStatus('order')
    assert.equal((await f.db.select().from(f.schema.loginUsers))[0].points, 10)
})

test('notification providers must confirm success before events are marked complete', async t => {
    const f = await setup(t)
    for (const [key, value] of Object.entries({ telegram_enabled: 'true', telegram_bot_token: 'TEST-BOT', telegram_chat_id: 'TEST-CHAT', resend_enabled: 'true', resend_api_key: 'TEST-RESEND', resend_from_email: 'shop@example.com' })) await f.queries.setSetting(key, value)
    f.setFetch(async () => Response.json({ ok: false, error: { message: 'PRIVATE-TOKEN' } }))
    assert.equal((await f.load('lib/notifications').sendTelegramMessage('Test')).success, false)
    assert.equal((await f.load('lib/email').sendOrderEmail({ to: 'buyer@example.com', orderId: 'order', productName: 'Product', cardKeys: 'PRIVATE-CARD' })).success, false)
    await f.db.insert(f.schema.orders).values(order('order', { status: 'paid', email: 'buyer@example.com' }))
    await f.load('lib/fulfillment').queuePaymentNotification('order')
    await f.load('lib/inventory-events').processInventoryEvents()
    const [event] = await f.db.select().from(f.schema.inventoryEvents)
    assert.equal(event.telegramSent, false)
    assert.equal(event.completedAt, null)
    f.setFetch(async () => Response.json({ ok: true }))
    await f.db.update(f.schema.inventoryEvents).set({ nextAttemptAt: new Date(0) }).where(eq(f.schema.inventoryEvents.eventId, event.eventId))
    await f.load('lib/inventory-events').processInventoryEvents()
    assert.ok((await f.db.select().from(f.schema.inventoryEvents))[0].completedAt)
})

test('verified payment requires a valid amount and transaction ID, and rejects HTTP failures', async t => {
    const f = await setup(t)
    f.env.MERCHANT_ID = 'test-merchant'; f.env.MERCHANT_KEY = 'test-merchant-key'
    await f.db.insert(f.schema.orders).values(order('order', { status: 'pending' }))
    const actions = f.load('actions/order')
    for (const money of [undefined, '', '3invalid', '2.99']) {
        f.setFetch(async () => Response.json({ code: 1, status: 1, trade_no: 'trade', money }))
        assert.equal((await actions.checkOrderStatus('order')).success, false)
        assert.equal((await f.db.select().from(f.schema.orders))[0].status, 'pending')
    }
    f.setFetch(async () => Response.json({ code: 1, status: 1, money: '3.00' }))
    assert.equal((await actions.checkOrderStatus('order')).success, false)
    f.setFetch(async () => Response.json({ code: 1, status: 1, money: '3.00', trade_no: 'trade' }, { status: 500 }))
    assert.equal((await actions.checkOrderStatus('order')).success, false)
    f.setFetch(async () => Response.json({ code: 1, status: 1, money: '3.00', trade_no: 'trade' }))
    assert.equal((await actions.checkOrderStatus('order')).success, true)
})

test('refunds use the configured payment API and reject unsuccessful responses without repeating an accepted refund', async t => {
    const f = await setup(t)
    f.env.MERCHANT_ID = 'test-merchant'; f.env.MERCHANT_KEY = 'test-merchant-key'; f.env.PAY_URL = 'https://payment.example/epay/pay/submit.php'
    await f.db.insert(f.schema.orders).values(order('order', { status: 'paid', tradeNo: 'trade' }))
    const action = f.load('actions/refund').proxyRefund
    let calls = 0, accepted = false
    f.setFetch(async (url, options) => {
        calls++
        assert.equal(url, 'https://payment.example/epay/api.php?act=refund')
        assert.equal(options.redirect, 'manual')
        return accepted ? Response.json({ code: 1 }) : new Response('unsuccessful')
    })
    assert.equal((await action('order')).processed, false)
    assert.equal((await f.db.select().from(f.schema.orders))[0].status, 'paid')
    accepted = true
    assert.equal((await action('order')).processed, true)
    assert.equal((await action('order')).processed, true)
    assert.equal(calls, 2)
})

test('owners retain access and legacy guest keys remain limited to the matching pending cookie', async t => {
    const f = await setup(t)
    await f.db.insert(f.schema.orders).values(order('order', { status: 'delivered', cardKey: 'OWNER-CARD' }))
    const page = await f.load('app/order/[id]/page').default({ params: Promise.resolve({ id: 'order' }) })
    assert.equal(page.props.order.cardKey, 'OWNER-CARD')
    const guest = await setup(t, { user: null, cookie: 'guest' })
    await guest.db.insert(guest.schema.orders).values(order('guest', { userId: null, username: null, status: 'delivered', cardKey: 'GUEST-CARD' }))
    assert.equal((await guest.load('app/order/[id]/page').default({ params: Promise.resolve({ id: 'guest' }) })).props.order.cardKey, 'GUEST-CARD')
})
