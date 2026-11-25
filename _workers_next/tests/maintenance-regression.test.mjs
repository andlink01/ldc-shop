import assert from 'node:assert/strict'
import { test } from 'node:test'
import { eq, sql } from 'drizzle-orm'
import { fixture } from './database-fixture.mjs'

class NextResponse extends Response {
    static json(data, init) { return Response.json(data, init) }
}

async function setup(t, { user = { id: 'buyer', username: 'buyer', trustLevel: 0 }, product = {} } = {}) {
    const f = fixture(t, { env: { ADMIN_USERS: 'buyer', MERCHANT_ID: 'test-merchant', MERCHANT_KEY: 'test-merchant-key' }, mocks: {
        '@/lib/auth': { auth: async () => user ? { user } : null },
        '@/actions/admin': { checkAdmin: async () => {} },
        'next/headers': { cookies: async () => ({ get() {}, set() {} }) },
        'next/server': { NextResponse, after() {} },
    } })
    await f.ready
    await f.db.insert(f.schema.products).values({ id: 'product', name: 'Product', price: '0', ...product })
    await f.db.insert(f.schema.loginUsers).values({ userId: 'buyer', username: 'buyer', points: 10 })
    await f.db.insert(f.schema.cards).values({ productId: 'product', cardKey: 'TEST-CARD' })
    return f
}

test('direct checkout enforces the product trust threshold without consuming stock or points', async t => {
    for (const trustLevel of [undefined, 0, 1, 2, 3]) {
        const f = await setup(t, { user: { id: 'buyer', username: 'buyer', trustLevel }, product: { visibilityLevel: 3 } })
        const result = await f.load('actions/checkout').createOrder('product', 1, undefined, true)
        assert.equal(result.success, trustLevel === 3)
        const saved = await f.db.select().from(f.schema.orders)
        assert.equal(saved.length, trustLevel === 3 ? 1 : 0)
        assert.equal((await f.db.select().from(f.schema.cards))[0].isUsed, trustLevel === 3)
        assert.equal((await f.db.select().from(f.schema.loginUsers))[0].points, 10)
    }
})

test('public and login-only products keep their normal checkout behavior', async t => {
    for (const visibilityLevel of [-1, 0]) {
        const f = await setup(t, { product: { visibilityLevel } })
        assert.equal((await f.load('actions/checkout').createOrder('product')).success, true)
    }
})

test('checkout rechecks raised visibility and newly required questions inside the commit transaction', async t => {
    for (const change of [{ visibilityLevel: 3 }, { purchaseQuestions: JSON.stringify([{ q: 'New question', a: 'Required' }]) }]) {
        const f = await setup(t, { product: { visibilityLevel: 0 } })
        const original = f.db.query.products.findFirst.bind(f.db.query.products)
        let changed = false
        f.db.query.products.findFirst = async (...args) => {
            const row = await original(...args)
            if (!changed) {
                changed = true
                await f.db.update(f.schema.products).set(change)
            }
            return row
        }
        assert.equal((await f.load('actions/checkout').createOrder('product')).success, false)
        assert.equal((await f.db.select().from(f.schema.orders)).length, 0)
        assert.equal((await f.db.select().from(f.schema.cards))[0].isUsed, false)
        assert.equal((await f.db.select().from(f.schema.loginUsers))[0].points, 10)
    }
})

test('purchase verification rejects malformed answer values and still accepts a valid answer', async t => {
    const questions = JSON.stringify([{ q: 'Type the word', a: 'required' }])
    for (const answers of [undefined, [{}], [123], 'required', { length: 1, 0: 'required' }, ['wrong'], []]) {
        const f = await setup(t, { product: { purchaseQuestions: questions } })
        assert.equal((await f.load('actions/checkout').createOrder('product', 1, undefined, false, answers)).success, false)
        assert.equal((await f.db.select().from(f.schema.orders)).length, 0)
    }
    const f = await setup(t, { product: { purchaseQuestions: questions } })
    assert.equal((await f.load('actions/checkout').createOrder('product', 1, undefined, false, [' REQUIRED '])).success, true)
})

test('invalid stored questions refuse checkout instead of silently disabling verification', async t => {
    for (const purchaseQuestions of ['{invalid', '{}', '[{"q":"Question","a":7}]']) {
        const f = await setup(t, { product: { purchaseQuestions } })
        const result = await f.load('actions/checkout').createOrder('product', 1, undefined, false, ['anything'])
        assert.equal(result.success, false)
        assert.equal((await f.db.select().from(f.schema.orders)).length, 0)
    }
})

test('automatic GET restocking rejects previously used or expired card values', async t => {
    for (const previous of [{ isUsed: true, usedAt: new Date() }, { expiresAt: new Date(0) }]) {
        const f = await setup(t)
        await f.db.update(f.schema.cards).set(previous)
        for (const [key, value] of Object.entries({ cards_api_enabled_product: 'true', cards_api_mode_product: 'stock', cards_api_url_product: 'https://supplier.example/cards' })) await f.queries.setSetting(key, value)
        f.setFetch(async () => Response.json({ cardKey: ' TEST-CARD ' }))
        const result = await f.load('lib/card-api').pullOneCardFromApi('product')
        assert.equal(result.ok, false)
        assert.equal(result.error, 'api_card_duplicate')
        assert.equal((await f.db.select().from(f.schema.cards)).length, 1)
    }
})

test('concurrent GET restocking inserts one new card while manual duplicate stock stays supported', async t => {
    const f = await setup(t)
    for (const [key, value] of Object.entries({ cards_api_enabled_product: 'true', cards_api_mode_product: 'stock', cards_api_url_product: 'https://supplier.example/cards' })) await f.queries.setSetting(key, value)
    f.setFetch(async () => Response.json({ cardKey: 'NEW-CARD' }))
    const results = await Promise.all(Array.from({ length: 3 }, () => f.load('lib/card-api').pullOneCardFromApi('product')))
    assert.equal(results.filter(result => result.ok).length, 1)
    assert.equal((await f.db.select().from(f.schema.cards).where(eq(f.schema.cards.cardKey, 'NEW-CARD'))).length, 1)
    await f.db.insert(f.schema.cards).values({ productId: 'product', cardKey: 'NEW-CARD' })
    assert.equal((await f.db.select().from(f.schema.cards).where(eq(f.schema.cards.cardKey, 'NEW-CARD'))).length, 2)
})

test('full backup remains internally consistent when delivery commits during export', async t => {
    const f = await setup(t, { product: { price: '1' } })
    await f.db.insert(f.schema.orders).values({ orderId: 'original', productId: 'product', productName: 'Product', amount: '1', status: 'paid', userId: 'buyer' })
    let interleaved = false
    const deliver = async () => {
        if (interleaved) return
        interleaved = true
        assert.equal((await f.load('lib/fulfillment').fulfillPaidOrder('original')).delivered, true)
    }
    const originalSelect = f.db.select.bind(f.db)
    if (!f.isDocker) f.db.select = (...args) => {
        const selection = originalSelect(...args), originalFrom = selection.from.bind(selection)
        selection.from = table => {
            const query = originalFrom(table)
            if (table === f.schema.cards) {
                const originalAll = query.all.bind(query)
                query.all = async () => { const rows = await originalAll(); await deliver(); return rows }
            }
            return query
        }
        return selection
    }
    const originalBatch = f.db.batch.bind(f.db)
    f.db.batch = async queries => { const result = await originalBatch(queries); await deliver(); return result }
    const response = await f.load('app/admin/data/download/route').GET(new Request('https://shop.example/admin/data/download?type=full&format=sql'))
    assert.equal(response.status, 200)
    assert.equal(interleaved, true)
    const restored = await setup(t, { product: { price: '1' } })
    await restored.db.delete(restored.schema.cards)
    await restored.db.delete(restored.schema.products)
    const dump = await response.text()
    const imported = await restored.load('actions/data').importData({ get: () => ({ text: async () => dump }) })
    assert.equal(imported.success, true)
    assert.equal(imported.errors, 0)
    const order = (await restored.db.select().from(restored.schema.orders))[0]
    const card = (await restored.db.select().from(restored.schema.cards))[0]
    assert.equal(order.status === 'delivered', card.isUsed)
    await restored.load('lib/fulfillment').fulfillPaidOrder('original')
    await restored.db.insert(restored.schema.orders).values({ orderId: 'second', productId: 'product', productName: 'Product', amount: '1', status: 'paid', userId: 'buyer' })
    assert.equal((await restored.load('lib/fulfillment').fulfillPaidOrder('second')).delivered, false)
    assert.equal((await restored.db.select().from(restored.schema.orderDeliveries)).length, 1)
})

test('101 reviews and their replies remain visible with the correct count and rating', async t => {
    const f = await setup(t)
    await f.dbBatchRaw(Array.from({ length: 101 }, (_, i) => ({
        sql: 'INSERT INTO reviews (product_id,order_id,user_id,username,rating,comment,created_at) VALUES (?,?,?,?,?,?,?)',
        params: ['product', 'review-order-' + i, 'buyer', 'buyer', 5, 'Review ' + i, Date.now() + i],
    })))
    await f.db.insert(f.schema.reviewReplies).values({ reviewId: 1, userId: 'buyer', username: 'buyer', comment: 'Reply', createdAt: new Date() })
    const result = await f.load('actions/buy').getBuyPageMeta('product')
    assert.equal(result.reviewCount, 101)
    assert.equal(result.averageRating, 5)
    assert.equal(result.reviews.length, 101)
    assert.equal(result.reviews.find(review => review.id === 1).replies[0].comment, 'Reply')
})

test('global recovery advances beyond 50 old out-of-stock orders to another product', async t => {
    const f = await setup(t, { product: { price: '1' } })
    await f.db.insert(f.schema.products).values({ id: 'empty', name: 'No stock', price: '1' })
    for (let i = 0; i < 50; i++) await f.db.insert(f.schema.orders).values({ orderId: 'older-' + i, productId: 'empty', productName: 'No stock', amount: '1', status: 'paid', paidAt: new Date(1), userId: 'buyer' })
    await f.db.insert(f.schema.orders).values({ orderId: 'ready', productId: 'product', productName: 'Product', amount: '1', status: 'paid', paidAt: new Date(), userId: 'buyer' })
    const fulfillment = f.load('lib/fulfillment')
    assert.equal((await fulfillment.fulfillPendingOrders(undefined, 50)).checked, 50)
    assert.equal((await fulfillment.fulfillPendingOrders(undefined, 50)).delivered, 1)
    assert.equal((await f.db.query.orders.findFirst({ where: eq(f.schema.orders.orderId, 'ready') })).status, 'delivered')
})

test('recovery keeps older orders first within one product and wraps its global scan', async t => {
    const f = await setup(t, { product: { price: '1' } })
    await f.db.insert(f.schema.orders).values([
        { orderId: 'older', productId: 'product', productName: 'Product', amount: '1', status: 'paid', paidAt: new Date(1), quantity: 2, userId: 'buyer' },
        { orderId: 'newer', productId: 'product', productName: 'Product', amount: '1', status: 'paid', paidAt: new Date(2), userId: 'buyer' },
    ])
    assert.equal((await f.load('lib/fulfillment').fulfillPendingOrders(undefined, 50)).delivered, 0)
    assert.equal((await f.db.select().from(f.schema.cards))[0].reservedOrderId, 'older')
    await f.db.insert(f.schema.cards).values({ productId: 'product', cardKey: 'SECOND-CARD' })
    assert.equal((await f.load('lib/fulfillment').fulfillPendingOrders(undefined, 50)).delivered, 1)
    assert.equal((await f.db.query.orders.findFirst({ where: eq(f.schema.orders.orderId, 'older') })).status, 'delivered')
    assert.equal((await f.db.query.orders.findFirst({ where: eq(f.schema.orders.orderId, 'newer') })).status, 'paid')
})

test('complete buyer reservations recover beyond 50 missing-stock orders of the same product', async t => {
    for (const productId of [undefined, 'product']) {
        const f = await setup(t, { product: { price: '1' } })
        await f.dbBatchRaw(Array.from({ length: 50 }, (_, i) => ({
            sql: 'INSERT INTO orders (order_id,product_id,product_name,amount,status,quantity,paid_at,user_id) VALUES (?,?,?,?,?,?,?,?)',
            params: ['older-' + String(i).padStart(2, '0'), 'product', 'Product', '1', 'paid', 3, 1, 'buyer'],
        })))
        await f.db.insert(f.schema.orders).values({ orderId: 'reserved', productId: 'product', productName: 'Product', amount: '1', status: 'paid', quantity: 2, paidAt: new Date(2), userId: 'buyer' })
        await f.db.update(f.schema.cards).set({ reservedOrderId: 'reserved', reservedAt: new Date(1) })
        await f.db.insert(f.schema.cards).values([
            { productId: 'product', cardKey: 'RESERVED-SECOND', reservedOrderId: 'reserved', reservedAt: new Date(1) },
            { productId: 'product', cardKey: 'OLDER-STOCK' },
        ])
        const recover = f.load('lib/fulfillment').fulfillPendingOrders
        for (let attempt = 0; attempt < 3; attempt++) await recover(productId, 50)
        const delivered = await f.db.query.orders.findFirst({ where: eq(f.schema.orders.orderId, 'reserved') })
        assert.equal(delivered.status, 'delivered', 'A full reservation must not be starved by missing-stock orders')
        assert.deepEqual(delivered.cardKey.split('\n').sort(), ['RESERVED-SECOND', 'TEST-CARD'])
        assert.equal((await f.db.query.cards.findFirst({ where: eq(f.schema.cards.cardKey, 'OLDER-STOCK') })).reservedOrderId, 'older-00')
        assert.equal((await f.db.select().from(f.schema.orderDeliveries)).length, 1)
    }
})

test('partial or expired buyer reservations do not jump the queue for unreserved stock', async t => {
    const f = await setup(t, { product: { price: '1' } })
    await f.db.insert(f.schema.orders).values([
        { orderId: 'older', productId: 'product', productName: 'Product', amount: '1', status: 'paid', paidAt: new Date(1), userId: 'buyer' },
        { orderId: 'partial', productId: 'product', productName: 'Product', amount: '1', status: 'paid', quantity: 2, paidAt: new Date(2), userId: 'buyer' },
    ])
    await f.db.insert(f.schema.cards).values([
        { productId: 'product', cardKey: 'PARTIAL-RESERVED', reservedOrderId: 'partial', reservedAt: new Date(1) },
        { productId: 'product', cardKey: 'EXPIRED-RESERVED', reservedOrderId: 'partial', reservedAt: new Date(1), expiresAt: new Date(0) },
    ])
    assert.equal((await f.load('lib/fulfillment').fulfillPendingOrders('product', 1)).delivered, 1)
    assert.equal((await f.db.query.orders.findFirst({ where: eq(f.schema.orders.orderId, 'older') })).cardKey, 'TEST-CARD')
    assert.equal((await f.db.query.orders.findFirst({ where: eq(f.schema.orders.orderId, 'partial') })).status, 'paid')
    assert.equal((await f.db.query.cards.findFirst({ where: eq(f.schema.cards.cardKey, 'PARTIAL-RESERVED') })).isUsed, false)
})

test('a reservation released before commit rejoins the queue instead of taking older buyers stock', async t => {
    const f = await setup(t, { product: { price: '1' } })
    await f.db.insert(f.schema.orders).values([
        { orderId: 'older', productId: 'product', productName: 'Product', amount: '1', status: 'paid', paidAt: new Date(1), userId: 'buyer' },
        { orderId: 'reserved', productId: 'product', productName: 'Product', amount: '1', status: 'paid', paidAt: new Date(2), userId: 'buyer' },
    ])
    await f.db.update(f.schema.cards).set({ reservedOrderId: 'reserved', reservedAt: new Date(1) })
    const driver = f.load('lib/db/index'), originalBatch = driver.dbBatchRaw
    let released = false
    driver.dbBatchRaw = async statements => {
        if (!released && statements.some(({ sql }) => sql.includes('INSERT INTO order_deliveries'))) {
            released = true
            await f.db.update(f.schema.cards).set({ reservedOrderId: null, reservedAt: null })
        }
        return originalBatch(statements)
    }
    const fulfillment = f.load('lib/fulfillment')
    assert.equal((await fulfillment.fulfillPaidOrder('reserved', { reservationOnly: true })).delivered, false)
    assert.equal(released, true)
    assert.equal((await f.db.select().from(f.schema.cards))[0].isUsed, false)
    assert.equal((await f.db.select().from(f.schema.orderDeliveries)).length, 0)
    assert.equal((await fulfillment.fulfillPendingOrders('product', 1)).delivered, 1)
    assert.equal((await f.db.query.orders.findFirst({ where: eq(f.schema.orders.orderId, 'older') })).status, 'delivered')
    assert.equal((await f.db.query.orders.findFirst({ where: eq(f.schema.orders.orderId, 'reserved') })).status, 'paid')
})

test('one failed delivery does not prevent another product from recovering', async t => {
    const f = await setup(t, { product: { price: '1' } })
    await f.db.insert(f.schema.products).values({ id: 'blocked', name: 'Blocked', price: '1' })
    await f.db.insert(f.schema.cards).values({ productId: 'blocked', cardKey: 'BLOCKED-CARD' })
    await f.db.insert(f.schema.orders).values([
        { orderId: 'blocked-order', productId: 'blocked', productName: 'Blocked', amount: '1', status: 'paid' },
        { orderId: 'ready-order', productId: 'product', productName: 'Product', amount: '1', status: 'paid' },
    ])
    await f.dbRun(sql.raw("CREATE TRIGGER fail_one_delivery BEFORE UPDATE ON orders WHEN NEW.order_id = 'blocked-order' AND NEW.status = 'delivered' BEGIN SELECT RAISE(ABORT, 'test'); END;"))
    assert.equal((await f.load('lib/fulfillment').fulfillPendingOrders(undefined, 50)).delivered, 1)
    assert.equal((await f.db.query.orders.findFirst({ where: eq(f.schema.orders.orderId, 'blocked-order') })).status, 'paid')
})

async function refundSetup(t) {
    const f = await setup(t, { product: { price: '1' } })
    await f.db.insert(f.schema.orders).values({ orderId: 'refund-order', productId: 'product', productName: 'Product', amount: '1', status: 'paid', userId: 'buyer', tradeNo: 'test-trade', pointsUsed: 2 })
    return f
}

test('concurrent refunds submit one payment request and credit points only once', async t => {
    const f = await refundSetup(t)
    let calls = 0, release, started
    const gate = new Promise(resolve => { release = resolve })
    const submitted = new Promise(resolve => { started = resolve })
    f.setFetch(async () => { calls++; started(); await gate; return Response.json({ code: 1 }) })
    const action = f.load('actions/refund').proxyRefund
    const first = action('refund-order')
    await submitted
    const second = action('refund-order')
    await new Promise(resolve => setTimeout(resolve, 0))
    release()
    const result = await Promise.all([first, second])
    assert.equal(calls, 1)
    assert.ok(result.some(value => value.processed))
    assert.equal((await f.db.select().from(f.schema.loginUsers))[0].points, 12)
})

test('a refund accepted by the gateway survives local rollback without another external refund', async t => {
    const f = await refundSetup(t)
    let calls = 0
    f.setFetch(async () => { calls++; return Response.json({ code: 1 }) })
    await f.dbRun(sql.raw("CREATE TRIGGER fail_refund_save BEFORE UPDATE ON orders WHEN NEW.status = 'refunded' BEGIN SELECT RAISE(ABORT, 'test'); END;"))
    const action = f.load('actions/refund').proxyRefund
    const first = await action('refund-order')
    assert.equal(first.processed, false)
    assert.equal((await f.db.select().from(f.schema.orders))[0].status, 'paid')
    assert.equal((await f.db.select().from(f.schema.loginUsers))[0].points, 10)
    await f.dbRun(sql.raw('DROP TRIGGER fail_refund_save'))
    assert.equal((await action('refund-order')).processed, true)
    assert.equal(calls, 1)
    assert.equal((await f.db.select().from(f.schema.loginUsers))[0].points, 12)
})

test('querying an uncertain refund by transaction ID cannot interpret status zero as refund evidence', async t => {
    const f = await refundSetup(t)
    let posts = 0, queries = 0
    f.setFetch(async (url, options) => {
        if (options.method === 'POST') { posts++; throw new Error('simulated response loss') }
        queries++
        assert.equal(new URL(url).searchParams.get('trade_no'), 'test-trade')
        return Response.json({ code: 1, status: 0, trade_no: 'test-trade', out_trade_no: 'refund-order_retry123' })
    })
    const action = f.load('actions/refund').proxyRefund
    assert.equal((await action('refund-order')).processed, false)
    assert.equal((await action('refund-order')).needsVerification, true)
    assert.equal(posts, 1)
    assert.equal(queries, 1)
    assert.equal((await f.db.select().from(f.schema.loginUsers))[0].points, 10)
})

// Mirrors the payment platform: an order is found by out_trade_no alone, and a query without it is HTTP 400.
function paymentPlatform(records) {
    const queried = []
    const fetch = async url => {
        const outTradeNo = new URL(url).searchParams.get('out_trade_no')
        if (!outTradeNo) return Response.json({ code: -1, msg: 'out_trade_no is required' }, { status: 400 })
        queried.push(outTradeNo)
        const record = records[outTradeNo]
        return record ? Response.json({ code: 1, out_trade_no: outTradeNo, ...record }) : Response.json({ code: -1 }, { status: 404 })
    }
    return { fetch, queried }
}

test('refund status checks query the payment platform by merchant order number', async t => {
    const f = await refundSetup(t)
    const verify = () => f.load('actions/admin-orders').verifyOrderRefundStatus('refund-order')
    const platform = paymentPlatform({ 'refund-order': { status: 1, trade_no: 'test-trade' } })
    f.setFetch(platform.fetch)
    const paid = await verify()
    assert.equal(paid.success, true, paid.error)
    assert.equal(paid.status, 1)
    assert.deepEqual(platform.queried, ['refund-order'])
    f.setFetch(paymentPlatform({}).fetch)
    assert.equal((await verify()).error, 'Payment query HTTP 404')
    assert.equal((await f.db.select().from(f.schema.orders))[0].status, 'paid')
})

test('a payment completed on a retry is checked under the retry number, never the unpaid first attempt', async t => {
    const f = await refundSetup(t)
    await f.db.update(f.schema.orders).set({ currentPaymentId: 'refund-order_retry123' })
    const verify = () => f.load('actions/admin-orders').verifyOrderRefundStatus('refund-order')
    const unpaidFirstAttempt = { status: 0, trade_no: 'unpaid-trade' }
    let platform = paymentPlatform({ 'refund-order': unpaidFirstAttempt, 'refund-order_retry123': { status: 1, trade_no: 'test-trade' } })
    f.setFetch(platform.fetch)
    assert.equal((await verify()).status, 1)
    assert.deepEqual(platform.queried, ['refund-order_retry123'])
    // The paid attempt is unknown to the shop: the unpaid attempt must not be read as a refund.
    platform = paymentPlatform({ 'refund-order': unpaidFirstAttempt })
    f.setFetch(platform.fetch)
    assert.equal((await verify()).success, false)
    assert.deepEqual(platform.queried, ['refund-order_retry123', 'refund-order'])
    assert.equal((await f.db.select().from(f.schema.orders))[0].status, 'paid')
    assert.equal((await f.db.select().from(f.schema.loginUsers))[0].points, 10)
    f.setFetch(paymentPlatform({ 'refund-order_retry123': { status: 0, trade_no: 'test-trade' } }).fetch)
    assert.equal((await verify()).needsVerification, true)
    assert.equal((await f.db.select().from(f.schema.orders))[0].status, 'paid')
})

test('an unconfirmed refund cannot be resubmitted until verification and administrator confirmation', async t => {
    const f = await refundSetup(t)
    let posts = 0, rejectResponse = true
    f.setFetch(async (url, options) => {
        if (options.method === 'POST') {
            posts++
            if (rejectResponse) throw new Error('simulated lost response')
            return Response.json({ code: 1 })
        }
        return Response.json({ code: 1, status: 1, trade_no: 'test-trade', out_trade_no: 'refund-order' })
    })
    const action = f.load('actions/refund').proxyRefund
    assert.equal((await action('refund-order')).needsVerification, true)
    assert.equal((await action('refund-order', true)).needsVerification, true)
    assert.equal(posts, 1)
    const verified = await f.load('actions/admin-orders').verifyOrderRefundStatus('refund-order')
    assert.equal(verified.canRetry, true)
    assert.equal(verified.needsReview, true)
    assert.equal((await action('refund-order')).needsReview, true)
    assert.equal(posts, 1)
    rejectResponse = false
    assert.equal((await action('refund-order', true)).processed, true)
    assert.equal(posts, 2)
    assert.equal((await f.db.select().from(f.schema.loginUsers))[0].points, 12)
})

test('refund verification cannot release an active request or accept a different transaction', async t => {
    const f = await refundSetup(t)
    const claim = await f.load('lib/payment-refund').claimPaymentRefund({ orderId: 'refund-order', amount: '1', tradeNo: 'test-trade' })
    assert.equal(claim.claimed, true)
    let posts = 0
    f.setFetch(async (_, options) => {
        if (options.method === 'POST') { posts++; return Response.json({ code: 1 }) }
        return Response.json({ code: 1, status: 1, trade_no: 'test-trade' })
    })
    assert.equal((await f.load('actions/admin-orders').verifyOrderRefundStatus('refund-order')).canRetry, false)
    assert.equal((await f.load('actions/refund').proxyRefund('refund-order', true)).inProgress, true)
    assert.equal(posts, 0)
    f.setFetch(async () => Response.json({ code: 1, status: 0, trade_no: 'other-trade' }))
    assert.equal((await f.load('actions/admin-orders').verifyOrderRefundStatus('refund-order')).success, false)
    assert.equal((await f.db.select().from(f.schema.orders))[0].status, 'paid')
    assert.equal((await f.db.select().from(f.schema.loginUsers))[0].points, 10)
})
