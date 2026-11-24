import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fixture } from './database-fixture.mjs'

class NextResponse extends Response {
    static json(data, init) { return Response.json(data, init) }
}

async function setup(t, { user = { id: 'buyer', username: 'buyer', trustLevel: 0 }, env = {}, mocks = {} } = {}) {
    const state = { user }
    const f = fixture(t, { env: { ADMIN_USERS: 'boss', MERCHANT_ID: 'test-merchant', MERCHANT_KEY: 'test-merchant-key', ...env }, mocks: {
        '@/lib/auth': { auth: async () => state.user ? { user: state.user } : null },
        'next/headers': { cookies: async () => ({ get() {}, set() {} }) },
        'next/server': { NextResponse, after() {} },
        ...mocks,
    } })
    await f.ready
    await f.db.insert(f.schema.products).values({ id: 'product', name: 'Product', price: '3' })
    await f.db.insert(f.schema.loginUsers).values({ userId: 'buyer', username: 'buyer', points: 10 })
    return Object.assign(f, { state })
}

async function deliveredOrder(f, orderId = 'ORDER-1') {
    await f.db.insert(f.schema.orders).values({ orderId, productId: 'product', productName: 'Product', amount: '3',
        status: 'delivered', userId: 'buyer', username: 'buyer', createdAt: new Date() })
}

test('reviews accept only whole star ratings, bounded comments and one review per order under concurrency', async t => {
    const f = await setup(t)
    await deliveredOrder(f)
    const { submitReview } = f.load('actions/reviews')
    for (const rating of [2.7, 0, 6, NaN, '5', null]) {
        assert.equal((await submitReview('product', 'ORDER-1', rating, 'ok')).error, 'review.invalidRating')
    }
    assert.equal((await submitReview('product', 'ORDER-1', 5, 'x'.repeat(1001))).error, 'review.commentTooLong')
    assert.equal((await f.db.select().from(f.schema.reviews)).length, 0)
    const results = await Promise.all(Array.from({ length: 5 }, () => submitReview('product', 'ORDER-1', 4, ' Good ')))
    assert.equal(results.filter(result => result.success).length, 1)
    assert.ok(results.filter(result => !result.success).every(result => result.error === 'review.alreadyReviewed'))
    const saved = await f.db.select().from(f.schema.reviews)
    assert.equal(saved.length, 1)
    assert.equal(saved[0].comment, 'Good')
    assert.equal(saved[0].rating, 4)
    const product = (await f.db.select().from(f.schema.products))[0]
    assert.equal(product.reviewCount, 1)
    assert.equal(product.rating, 4)
})

test('blocked users cannot review or reply and replies are rate limited per account', async t => {
    const f = await setup(t)
    await deliveredOrder(f)
    const { submitReview, submitReviewReply } = f.load('actions/reviews')
    assert.equal((await submitReview('product', 'ORDER-1', 5, 'First')).success, true)
    for (let i = 0; i < 10; i++) assert.equal((await submitReviewReply(1, 'product', 'Reply ' + i)).success, true)
    assert.equal((await submitReviewReply(1, 'product', 'One too many')).error, 'review.replyRateLimited')
    assert.equal((await submitReviewReply('1; DROP TABLE reviews', 'product', 'Bad id')).error, 'review.replyInvalidReview')
    assert.equal((await f.db.select().from(f.schema.reviewReplies)).length, 10)

    await deliveredOrder(f, 'ORDER-2')
    await f.db.update(f.schema.loginUsers).set({ isBlocked: true })
    assert.equal((await submitReview('product', 'ORDER-2', 5, 'Blocked')).error, 'review.blocked')
    assert.equal((await submitReviewReply(1, 'product', 'Blocked')).error, 'review.blocked')
    assert.equal((await f.db.select().from(f.schema.reviews)).length, 1)
})

test('review totals cover every review while the returned list stays bounded', async t => {
    const f = await setup(t)
    await f.dbBatchRaw(Array.from({ length: 205 }, (_, i) => ({
        sql: 'INSERT INTO reviews (product_id,order_id,user_id,username,rating,comment,created_at) VALUES (?,?,?,?,?,?,?)',
        params: ['product', 'review-order-' + i, 'buyer', 'buyer', i < 5 ? 1 : 5, 'Review ' + i, 1_000 + i],
    })))
    await f.db.insert(f.schema.reviewReplies).values([
        { reviewId: 205, userId: 'buyer', username: 'buyer', comment: 'Newest reply', createdAt: new Date() },
        { reviewId: 1, userId: 'buyer', username: 'buyer', comment: 'Oldest reply', createdAt: new Date() },
    ])
    const result = await f.load('actions/buy').getBuyPageMeta('product')
    assert.equal(result.reviewCount, 205)
    assert.equal(Number(result.averageRating.toFixed(4)), Number(((5 * 1 + 200 * 5) / 205).toFixed(4)))
    assert.equal(result.reviews.length, 200)
    assert.equal(result.reviews[0].id, 205)
    assert.equal(result.reviews[0].replies[0].comment, 'Newest reply')
    assert.ok(!result.reviews.some(review => review.id === 1))
})

test('price sorting compares stored text prices as numbers', async t => {
    const f = await setup(t)
    // Distinct creation times: the chosen order must survive variant grouping.
    const at = offset => new Date(Date.now() - offset * 60_000)
    await f.db.insert(f.schema.products).values([
        { id: 'p9', name: 'Nine', price: '9', createdAt: at(1) }, { id: 'p10', name: 'Ten', price: '10.00', createdAt: at(4) },
        { id: 'p100', name: 'Hundred', price: '100', createdAt: at(2) }, { id: 'p2', name: 'Two', price: '2.5', createdAt: at(3) },
    ])
    const { searchActiveProducts } = f.queries
    assert.equal((await searchActiveProducts({ sort: 'priceAsc' })).items.map(item => item.id).join(), 'p2,product,p9,p10,p100')
    assert.equal((await searchActiveProducts({ sort: 'priceDesc' })).items.map(item => item.id).join(), 'p100,p10,p9,product,p2')
})

test('one account cannot hold unlimited unpaid orders or keep abandoning them', async t => {
    const f = await setup(t)
    await f.dbBatchRaw(Array.from({ length: 40 }, (_, i) => ({ sql: 'INSERT INTO cards (product_id, card_key) VALUES (?, ?)', params: ['product', 'CARD-' + i] })))
    const { createOrder } = f.load('actions/checkout')
    for (let i = 0; i < 5; i++) assert.equal((await createOrder('product', 1)).success, true)
    const refused = await createOrder('product', 1)
    assert.equal(refused.error, 'buy.tooManyPending')
    assert.equal((await f.db.select().from(f.schema.orders)).length, 5)
    assert.equal((await f.db.select().from(f.schema.cards)).filter(card => card.reservedOrderId).length, 5)

    // The transaction also refuses a request that passed the earlier read.
    const { commitCheckoutOrder } = f.load('lib/checkout-inventory')
    const raced = await commitCheckoutOrder({ orderId: 'RACED', productId: 'product', productName: 'Product', price: '3', shared: false,
        quantity: 1, amount: 3, points: 0, userId: 'buyer', username: 'buyer', email: null, purchaseLimit: null, onDemand: false,
        trustLevel: 0, purchaseQuestions: null })
    assert.equal(raced.success, false)
    assert.equal((await f.db.select().from(f.schema.cards)).filter(card => card.reservedOrderId).length, 5)

    // Abandoned orders free the open slots but still count toward the hourly bound.
    await f.dbBatchRaw([{ sql: "UPDATE orders SET status = 'cancelled'", params: [] },
        { sql: 'UPDATE cards SET reserved_order_id = NULL, reserved_at = NULL', params: [] }])
    await f.dbBatchRaw(Array.from({ length: 15 }, (_, i) => ({
        sql: "INSERT INTO orders (order_id, product_id, product_name, amount, status, user_id, created_at) VALUES (?, 'product', 'Product', '3', 'cancelled', 'buyer', ?)",
        params: ['ABANDONED-' + i, Date.now()],
    })))
    assert.equal((await createOrder('product', 1)).error, 'buy.tooManyPending')
    await f.dbBatchRaw([{ sql: 'UPDATE orders SET created_at = ?', params: [Date.now() - 2 * 60 * 60 * 1000] }])
    assert.equal((await createOrder('product', 1)).success, true)

    // Paid and delivered orders never count against the buyer.
    await f.dbBatchRaw([{ sql: "UPDATE orders SET status = 'delivered', created_at = ?", params: [Date.now()] }])
    assert.equal((await createOrder('product', 1)).success, true)
})

test('user messages are rate limited before another admin notification is sent', async t => {
    let notified = 0
    const f = await setup(t, { mocks: { '@/lib/notifications': { notifyAdminUserMessage: async () => { notified++ } },
        '@/actions/admin': { checkAdmin: async () => {} } } })
    const { sendUserMessage } = f.load('actions/user-messages')
    for (let i = 0; i < 5; i++) assert.equal((await sendUserMessage('Title', 'Body ' + i)).success, true)
    assert.equal((await sendUserMessage('Title', 'Too fast')).error, 'profile.messages.rateLimited')
    assert.equal(notified, 5)
    assert.equal((await f.db.select().from(f.schema.userMessages)).length, 5)
    await f.dbBatchRaw([{ sql: 'UPDATE user_messages SET created_at = ?', params: [Date.now() - 11 * 60 * 1000] }])
    assert.equal((await sendUserMessage('Title', 'Later')).success, true)
})

test('check-in survives an invalid reward setting and follows the shop day', async t => {
    for (const [reward, expected] of [['abc', 10], ['', 10], ['-5', 10], ['25', 25], ['0', 0]]) {
        const f = await setup(t)
        await f.queries.setSetting('checkin_reward', reward)
        const result = await f.load('actions/points').checkIn()
        assert.equal(result.success, true, JSON.stringify(result))
        assert.equal((await f.db.select().from(f.schema.loginUsers))[0].points, 10 + expected)
        assert.equal((await f.load('actions/points').checkIn()).success, false)
        assert.equal((await f.load('actions/points').getCheckinStatus()).checkedIn, true)
    }

    const f = await setup(t)
    const { shopDayStartMs, shopMonthStartMs } = f.load('lib/shop-time')
    // 2026-03-01 00:30 in UTC+8 is still 2026-02-28 16:30 UTC.
    const now = Date.UTC(2026, 1, 28, 16, 30)
    assert.equal(shopDayStartMs(now), Date.UTC(2026, 1, 28, 16, 0))
    assert.equal(shopMonthStartMs(now), Date.UTC(2026, 1, 28, 16, 0))
    assert.equal(shopDayStartMs(Date.UTC(2026, 1, 28, 15, 59)), Date.UTC(2026, 1, 27, 16, 0))
    assert.equal(shopMonthStartMs(Date.UTC(2026, 1, 28, 15, 59)), Date.UTC(2026, 0, 31, 16, 0))

    // A check-in late on the previous shop day does not block the new shop day.
    await f.dbBatchRaw([{ sql: 'UPDATE login_users SET last_checkin_at = ?, consecutive_days = 3', params: [shopDayStartMs() - 60_000] }])
    assert.equal((await f.load('actions/points').getCheckinStatus()).checkedIn, false)
    const next = await f.load('actions/points').checkIn()
    assert.equal(next.success, true)
    assert.equal(next.consecutiveDays, 4)

    const utc = await setup(t, { env: { SHOP_UTC_OFFSET_MINUTES: '0' } })
    assert.equal(utc.load('lib/shop-time').shopDayStartMs(now), Date.UTC(2026, 1, 28))
})

test('sales statistics use shop-day boundaries', async t => {
    const f = await setup(t)
    const now = Date.UTC(2026, 1, 28, 16, 30) // 00:30 on 1 March in UTC+8
    const paid = (orderId, paidAt) => ({ orderId, productId: 'product', productName: 'Product', amount: '3', status: 'delivered', paidAt: new Date(paidAt), createdAt: new Date(paidAt) })
    await f.db.insert(f.schema.orders).values([
        paid('TODAY', Date.UTC(2026, 1, 28, 16, 10)), paid('YESTERDAY', Date.UTC(2026, 1, 28, 15, 50)), paid('LAST-MONTH', Date.UTC(2026, 1, 10)),
    ])
    const stats = await f.queries.getDashboardStats(now)
    t.diagnostic(JSON.stringify(stats))
    assert.equal(stats.today.count, 1)
    assert.equal(stats.month.count, 1)
    assert.equal(stats.week.count, 2)
    assert.equal(stats.total.count, 3)
})

test('expired card cleanup releases reservations once and later runs skip old expired stock', async t => {
    const f = await setup(t)
    const now = Date.now()
    await f.db.insert(f.schema.products).values({ id: 'other', name: 'Other', price: '1' })
    await f.db.insert(f.schema.cards).values([
        { productId: 'product', cardKey: 'EXPIRED-RESERVED', expiresAt: new Date(now - 60_000), reservedOrderId: 'GONE', reservedAt: new Date(now) },
        { productId: 'product', cardKey: 'EXPIRED-SOLD', expiresAt: new Date(now - 60_000), isUsed: true },
        { productId: 'product', cardKey: 'LIVE' },
        { productId: 'other', cardKey: 'OTHER-SOLD-EXPIRED', expiresAt: new Date(now - 60_000), isUsed: true },
    ])
    await f.queries.recalcProductAggregates('product')
    assert.equal(await f.queries.cleanupExpiredCardsIfNeeded(0), true)
    const cardsAfter = await f.db.select().from(f.schema.cards)
    assert.equal(cardsAfter.find(card => card.cardKey === 'EXPIRED-RESERVED').reservedOrderId, null)
    assert.equal((await f.db.select().from(f.schema.products)).find(product => product.id === 'product').stockCount, 1)
    const marker = Number(await f.queries.getSetting('cards_expiry_cleanup_at'))
    assert.ok(marker >= now)

    // Old expired rows fall outside the window of the next run; newly expired ones are handled.
    await f.dbBatchRaw([{ sql: 'UPDATE cards SET expires_at = ? WHERE card_key = ?', params: [now - 3 * 60 * 60 * 1000, 'EXPIRED-RESERVED'] },
        { sql: 'UPDATE settings SET value = ? WHERE key = ?', params: [String(now - 60 * 60 * 1000), 'cards_expiry_cleanup_at'] },
        { sql: 'INSERT INTO cards (product_id, card_key, expires_at, reserved_order_id, reserved_at) VALUES (?,?,?,?,?)', params: ['product', 'NEWLY-EXPIRED', now - 1_000, 'GONE-2', now] }])
    assert.equal(await f.queries.cleanupExpiredCardsIfNeeded(0), true)
    assert.equal((await f.db.select().from(f.schema.cards)).find(card => card.cardKey === 'NEWLY-EXPIRED').reservedOrderId, null)
    assert.equal(await f.queries.cleanupExpiredCardsIfNeeded(10 * 60 * 1000), false)
})

test('signature and token comparison rejects missing, empty and different values', async t => {
    const f = await setup(t)
    const { safeEqual, generateSign } = f.load('lib/crypto')
    assert.equal(safeEqual('secret', 'secret'), true)
    for (const [a, b] of [['secret', 'secreT'], ['secret', 'secret '], ['', ''], [undefined, undefined], [null, 'x'], ['x', undefined], [1, 1]]) {
        assert.equal(safeEqual(a, b), false)
    }
    const params = { pid: 'm', out_trade_no: 'ORDER', trade_no: 'T', trade_status: 'TRADE_SUCCESS', money: '3.00', sign_type: 'MD5' }
    const { GET } = f.load('app/api/notify/route')
    const call = extra => GET(new Request('https://shop.example/api/notify?' + new URLSearchParams({ ...params, ...extra })))
    assert.equal((await call({ sign: 'wrong' })).status, 400)
    assert.equal((await call({})).status, 400)
    assert.equal((await call({ sign: generateSign(params, 'another-key') })).status, 400)
    const accepted = await call({ sign: generateSign(params, 'test-merchant-key') })
    assert.equal(accepted.status, 200)
    assert.equal(await accepted.text(), 'success')

    const missing = await setup(t, { env: { MERCHANT_KEY: '' } })
    const unsigned = await missing.load('app/api/notify/route').GET(new Request('https://shop.example/api/notify?' + new URLSearchParams({ ...params, sign: generateSign(params, '') })))
    assert.equal(unsigned.status, 500)
})

test('an order paid through an earlier retry link is still verifiable on the payment platform after delivery', async t => {
    const f = await setup(t, { mocks: { '@/actions/admin': { checkAdmin: async () => {} } } })
    await f.db.insert(f.schema.cards).values({ productId: 'product', cardKey: 'CARD' })
    await f.db.insert(f.schema.orders).values({ orderId: 'ORDER', productId: 'product', productName: 'Product', amount: '3',
        status: 'pending', userId: 'buyer', username: 'buyer', currentPaymentId: 'ORDER_retry222' })
    const { generateSign } = f.load('lib/crypto')
    const params = { pid: 'test-merchant', out_trade_no: 'ORDER_retry111', trade_no: 'PAID-TRADE', trade_status: 'TRADE_SUCCESS', money: '3.00', sign_type: 'MD5' }
    const notified = await f.load('app/api/notify/route').GET(new Request('https://shop.example/api/notify?'
        + new URLSearchParams({ ...params, sign: generateSign(params, 'test-merchant-key') })))
    assert.equal(await notified.text(), 'success')
    const [order] = await f.db.select().from(f.schema.orders)
    assert.equal(order.status, 'delivered')
    assert.equal(order.currentPaymentId, 'ORDER_retry111')

    // The platform finds an order by out_trade_no alone; the other two attempts were never paid.
    const records = { ORDER: { status: 0, trade_no: 'UNPAID-1' }, ORDER_retry222: { status: 0, trade_no: 'UNPAID-2' }, ORDER_retry111: { status: 1, trade_no: 'PAID-TRADE' } }
    const queried = []
    f.setFetch(async url => {
        const outTradeNo = new URL(url).searchParams.get('out_trade_no')
        queried.push(outTradeNo)
        return records[outTradeNo] ? Response.json({ code: 1, out_trade_no: outTradeNo, ...records[outTradeNo] }) : Response.json({ code: -1 }, { status: outTradeNo ? 404 : 400 })
    })
    const verified = await f.load('actions/admin-orders').verifyOrderRefundStatus('ORDER')
    assert.equal(verified.success, true, verified.error)
    assert.equal(verified.status, 1)
    assert.deepEqual(queried, ['ORDER_retry111'])
    assert.equal((await f.db.select().from(f.schema.orders))[0].status, 'delivered')

    // An order delivered before the number was recorded cannot be matched: it reports that, and changes nothing.
    await f.db.update(f.schema.orders).set({ currentPaymentId: null })
    const unmatched = await f.load('actions/admin-orders').verifyOrderRefundStatus('ORDER')
    assert.equal(unmatched.success, false)
    assert.equal(unmatched.errorKey, 'admin.orders.paymentRecordUnmatched')
    assert.equal((await f.db.select().from(f.schema.orders))[0].status, 'delivered')
})

test('admin name lists are parsed the same way everywhere', async t => {
    const f = await setup(t, { env: { ADMIN_USERS: ' Boss , second ,, ' } })
    const { isAdminUsername, getAdminUsernames } = f.load('lib/admin-auth')
    assert.equal(getAdminUsernames().join('|'), 'Boss|second')
    for (const name of ['boss', 'BOSS', 'second', 'Second']) assert.equal(isAdminUsername(name), true)
    for (const name of [' second', '', null, undefined, 'bos', 'buyer']) assert.equal(isAdminUsername(name), false)

    let redirected = null
    const guard = (user) => setup(t, { user, env: { ADMIN_USERS: ' Boss , second ' }, mocks: {
        'next/navigation': { redirect: (target) => { redirected = target; throw new Error('NEXT_REDIRECT') } } } })
    for (const user of [null, { id: 'buyer', username: 'buyer' }, { id: 'x' }]) {
        redirected = null
        await assert.rejects((await guard(user)).load('lib/admin-guard').requireAdminPage(), /NEXT_REDIRECT/)
        assert.equal(redirected, '/')
    }
    const admin = await (await guard({ id: 'second-id', username: 'Second' })).load('lib/admin-guard').requireAdminPage()
    assert.equal(admin.username, 'Second')
})

test('a GitHub login reassigned to another account never takes over the previous owner orders', async t => {
    let config
    const f = await setup(t, { mocks: {
        'next-auth': { __esModule: true, default: (value) => { config = value; return { handlers: {}, auth: async () => null, signIn() {}, signOut() {} } } },
        'next-auth/providers/github': { __esModule: true, default: (value) => ({ id: 'github', ...value }) },
        '@/lib/auth': undefined,
    } })
    f.load('lib/auth')
    const login = (accountId) => config.callbacks.jwt({ token: {}, user: { id: accountId, username: 'gh_recycled' },
        profile: { login: 'recycled' }, account: { provider: 'github', providerAccountId: accountId } })

    await f.db.insert(f.schema.loginUsers).values({ userId: 'github:111', username: 'gh_recycled', points: 50 })
    await f.db.insert(f.schema.orders).values({ orderId: 'OLD-OWNER', productId: 'product', productName: 'Product', amount: '3',
        status: 'delivered', cardKey: 'OLD-OWNER-CARD', userId: 'github:111', username: 'gh_recycled', createdAt: new Date() })

    const token = await login('222')
    assert.equal(token.id, 'github:222')
    const order = (await f.db.select().from(f.schema.orders))[0]
    assert.equal(order.userId, 'github:111')
    const previous = (await f.db.select().from(f.schema.loginUsers)).find(user => user.userId === 'github:111')
    assert.equal(previous.points, 50)
    assert.equal(previous.username, null)
    const { canAccessOrder } = f.load('lib/order-access')
    assert.equal(canAccessOrder({ id: token.id, username: token.username }, order, 'OLD-OWNER'), false)
    assert.equal(canAccessOrder({ id: 'github:111', username: 'gh_renamed' }, order, 'OLD-OWNER'), true)

    // The same stable account stored in a legacy ID format is still migrated.
    await f.db.insert(f.schema.loginUsers).values({ userId: 'github:github:333', username: 'gh_legacy', points: 7 })
    await f.db.insert(f.schema.orders).values({ orderId: 'LEGACY', productId: 'product', productName: 'Product', amount: '3',
        status: 'delivered', userId: 'github:github:333', username: 'gh_legacy', createdAt: new Date() })
    const legacy = await config.callbacks.jwt({ token: {}, user: { id: '333', username: 'gh_legacy' },
        profile: { login: 'legacy' }, account: { provider: 'github', providerAccountId: '333' } })
    assert.equal(legacy.id, 'github:333')
    assert.equal((await f.db.select().from(f.schema.orders)).find(row => row.orderId === 'LEGACY').userId, 'github:333')
    assert.equal((await f.db.select().from(f.schema.loginUsers)).find(user => user.userId === 'github:333').points, 7)
})
