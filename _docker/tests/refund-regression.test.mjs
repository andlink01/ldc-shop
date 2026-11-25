import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fixture } from './database-fixture.mjs'

async function setup(t, { amount = '3', tradeNo = '7654321', status = 'delivered', user = { id: 'admin', username: 'boss' }, mocks = {} } = {}) {
    const f = fixture(t, { env: { ADMIN_USERS: 'boss', MERCHANT_ID: 'test-merchant', MERCHANT_KEY: 'test-key' }, mocks: {
        '@/lib/auth': { auth: async () => user ? { user } : null }, ...mocks,
    } })
    await f.ready
    await f.db.insert(f.schema.products).values({ id: 'product', name: 'Product', price: '5' })
    await f.db.insert(f.schema.loginUsers).values({ userId: 'buyer', username: 'buyer', points: 18 })
    await f.db.insert(f.schema.orders).values({ orderId: 'ORDER', productId: 'product', productName: 'Product', amount,
        status, tradeNo, userId: 'buyer', pointsUsed: 2, cardIds: '1', cardKey: 'CARD', deliveredAt: new Date(1000) })
    await f.db.insert(f.schema.cards).values({ id: 1, productId: 'product', cardKey: 'CARD', isUsed: true, usedAt: new Date(1000) })
    const [request] = await f.db.insert(f.schema.refundRequests).values({ orderId: 'ORDER', userId: 'buyer', status: 'pending' }).returning()
    const snapshot = async () => ({
        orders: await f.db.select().from(f.schema.orders), cards: await f.db.select().from(f.schema.cards),
        users: await f.db.select().from(f.schema.loginUsers), requests: await f.db.select().from(f.schema.refundRequests),
    })
    return { ...f, requestId: request.id, snapshot }
}

test('a positive-payment refund request without a transaction number stays pending and never reports a refund', async t => {
    const f = await setup(t, { tradeNo: null })
    const before = await f.snapshot()
    let calls = 0
    f.setFetch(async () => { calls++; assert.fail('No payment request should be sent') })
    const result = await f.load('actions/refund-requests').adminApproveRefund(f.requestId)
    assert.equal(result.ok, false)
    assert.equal(result.processed, false)
    assert.equal(result.error, 'admin.orders.refundMissingTrade')
    assert.equal(calls, 0)
    assert.deepEqual(await f.snapshot(), before)
    assert.equal((await f.load('actions/admin-orders').verifyOrderRefundStatus('ORDER')).success, false)
})

test('zero-payment approval returns shop points once without calling the payment platform or reopening the processed request', async t => {
    const f = await setup(t, { amount: '0', tradeNo: null })
    const approve = f.load('actions/refund-requests').adminApproveRefund
    assert.equal((await approve(f.requestId)).processed, true)
    assert.equal((await approve(f.requestId)).processed, true)
    const state = await f.snapshot()
    assert.equal(state.orders[0].status, 'refunded')
    assert.equal(state.users[0].points, 20)
    assert.equal(state.requests[0].status, 'processed')
})

test('invalid payment amounts cannot be approved as local refunds', async t => {
    for (const amount of ['NaN', 'Infinity', '-1', '', ' ']) {
        const f = await setup(t, { amount, tradeNo: null })
        const before = await f.snapshot()
        await assert.rejects(f.load('actions/refund-requests').adminApproveRefund(f.requestId), /Invalid payment refund amount/)
        assert.deepEqual(await f.snapshot(), before)
    }
})

test('refunds use the paid retry number and an explicit successful payment response before restoring stock', async t => {
    const f = await setup(t)
    await f.db.update(f.schema.orders).set({ currentPaymentId: 'ORDER_retry123' })
    let calls = 0
    f.setFetch(async (url, options) => {
        calls++
        assert.equal(url, 'https://credit.linux.do/epay/api.php?act=refund')
        assert.equal(options.method, 'POST')
        assert.equal(options.redirect, 'manual')
        const form = new URLSearchParams(options.body)
        assert.equal(form.get('pid'), 'test-merchant')
        assert.equal(form.get('key'), 'test-key')
        assert.equal(form.get('trade_no'), '7654321')
        assert.equal(form.get('out_trade_no'), 'ORDER_retry123')
        assert.equal(form.get('money'), '3.00')
        return Response.json({ code: 1, msg: 'Refund completed' })
    })
    const refund = f.load('actions/refund').proxyRefund
    assert.equal((await refund('ORDER')).processed, true)
    assert.equal((await refund('ORDER')).processed, true)
    const state = await f.snapshot()
    assert.equal(calls, 1)
    assert.equal(state.orders[0].status, 'refunded')
    assert.equal(state.cards[0].isUsed, false)
    assert.equal(state.users[0].points, 20)
})

test('plain success, messages without a success code and failed HTTP responses cannot complete a payment refund', async t => {
    for (const response of [new Response('success'), Response.json({ msg: 'success' }), Response.json({ status: 'success' }),
        Response.json({ code: 1 }, { status: 500 })]) {
        const f = await setup(t)
        const before = await f.snapshot()
        f.setFetch(async () => response)
        const result = await f.load('actions/refund').proxyRefund('ORDER')
        assert.equal(result.processed, false)
        assert.equal(result.needsVerification, true)
        assert.deepEqual(await f.snapshot(), before)
    }
})

test('an inbox failure does not block an approved payment refund', async t => {
    const f = await setup(t)
    f.queries.createUserNotification = async () => { throw new Error('Isolated inbox failure') }
    f.setFetch(async () => Response.json({ code: 1 }))
    assert.equal((await f.load('actions/refund-requests').adminApproveRefund(f.requestId)).processed, true)
    assert.equal((await f.snapshot()).orders[0].status, 'refunded')
})

test('refund mutations refuse visitors and ordinary buyers before any payment call or database change', async t => {
    for (const user of [null, { id: 'buyer', username: 'buyer' }]) {
        const f = await setup(t, { user })
        const before = await f.snapshot()
        for (const invoke of [() => f.load('actions/refund').proxyRefund('ORDER'),
            () => f.load('actions/refund').markOrderRefunded('ORDER', true),
            () => f.load('actions/refund-requests').adminApproveRefund(f.requestId),
            () => f.load('actions/admin-orders').verifyOrderRefundStatus('ORDER')]) await assert.rejects(invoke)
        assert.deepEqual(await f.snapshot(), before)
    }
})
