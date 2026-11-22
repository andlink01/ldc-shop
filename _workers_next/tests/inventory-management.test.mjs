import assert from 'node:assert/strict'
import { test } from 'node:test'
import { eq, sql } from 'drizzle-orm'
import { fixture } from './database-fixture.mjs'

async function setup(t, options) {
    const f = fixture(t, options)
    await f.ready
    await f.db.insert(f.schema.products).values([{ id: 'one', name: 'One', price: '1' }, { id: 'two', name: 'Two', price: '1' }])
    return { ...f, ...f.load('lib/inventory-management'), ...f.load('lib/inventory-api') }
}
const context = id => ({ params: Promise.resolve({ productId: id }) })
const request = (token, body) => new Request('https://shop.example/api/v1/products/one/cards', {
    method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'request' },
    ...(body ? { body: JSON.stringify(body) } : {}),
})
const keyInput = extra => ({ name: 'Tool', canRead: true, canWrite: true, productIds: ['one'], expiresAt: null, ...extra })

test('managed keys are random, stored as hashes and usable without the environment key', async t => {
    const f = await setup(t, { env: { INVENTORY_API_KEY: '' } })
    const first = await f.createManagedInventoryKey(keyInput(), 'admin')
    const second = await f.createManagedInventoryKey(keyInput(), 'admin')
    assert.notEqual(first.token, second.token)
    const rows = await f.db.select().from(f.schema.inventoryApiKeys)
    assert.equal(rows[0].tokenHash, await f.hashInventoryToken(first.token))
    assert.ok(!JSON.stringify(rows).includes(first.token))
    assert.equal((await f.getInventoryStock(request(first.token), context('one'))).status, 200)
})

test('managed keys filter product lists and reject product or operation escalation', async t => {
    const f = await setup(t)
    const { token } = await f.createManagedInventoryKey(keyInput({ canWrite: false }), 'admin')
    const list = await (await f.listInventoryProducts(request(token))).json()
    assert.deepEqual(list.data.products.map(p => p.id), ['one'])
    assert.equal((await f.getInventoryStock(request(token), context('two'))).status, 403)
    assert.equal((await f.addInventoryCards(request(token, { cards: ['SECRET'] }), context('one'))).status, 403)
    const write = await f.createManagedInventoryKey(keyInput({ canRead: false }), 'admin')
    assert.equal((await f.listInventoryProducts(request(write.token))).status, 403)
    assert.equal((await f.addInventoryCards(request(write.token, { cards: ['SECRET'] }), context('one'))).status, 201)
})

test('disabled or expired keys reject access and their errors are audited without card values', async t => {
    const f = await setup(t)
    const { token } = await f.createManagedInventoryKey(keyInput(), 'admin')
    await f.db.update(f.schema.inventoryApiKeys).set({ isEnabled: false })
    assert.equal((await f.addInventoryCards(request(token, { cards: ['PRIVATE-CARD'] }), context('one'))).status, 401)
    await f.db.update(f.schema.inventoryApiKeys).set({ isEnabled: true, expiresAt: new Date(Date.now() - 1) })
    assert.equal((await f.getInventoryStock(request(token), context('one'))).status, 401)
    const logs = await f.db.select().from(f.schema.inventoryApiRequests)
    assert.equal(logs.length, 2)
    assert.ok(!JSON.stringify(logs).includes(token))
    assert.ok(!JSON.stringify(logs).includes('PRIVATE-CARD'))
})

test('imports recover paid orders and retries log zero new cards with separate key namespaces', async t => {
    const f = await setup(t)
    await f.db.insert(f.schema.orders).values({ orderId: 'waiting', productId: 'one', productName: 'One', amount: '1', status: 'paid' })
    const { token } = await f.createManagedInventoryKey(keyInput(), 'admin')
    assert.equal((await f.addInventoryCards(request(token, { cards: ['PRIVATE-CARD'] }), context('one'))).status, 201)
    assert.equal((await f.addInventoryCards(request(token, { cards: ['PRIVATE-CARD'] }), context('one'))).status, 200)
    const delivered = (await f.db.select().from(f.schema.orders))[0]
    assert.equal(delivered.status, 'delivered')
    assert.equal(delivered.cardKey, 'PRIVATE-CARD')
    const logs = await f.db.select().from(f.schema.inventoryApiRequests)
    assert.deepEqual(logs.map(l => l.addedCount), [1, 0])
    assert.ok(!JSON.stringify(logs).includes('PRIVATE-CARD'))
    const another = await f.createManagedInventoryKey(keyInput(), 'admin')
    assert.equal((await f.addInventoryCards(request(another.token, { cards: ['another'] }), context('one'))).status, 201)
})

test('expiry changes are all-or-nothing and reject used cards, active locks and paid stale reservations', async t => {
    const f = await setup(t)
    await f.db.insert(f.schema.orders).values({ orderId: 'paid', productId: 'one', productName: 'One', amount: '1', status: 'paid' })
    await f.db.insert(f.schema.cards).values([
        { productId: 'one', cardKey: 'free', expiresAt: new Date(Date.now() - 1) },
        { productId: 'one', cardKey: 'used', isUsed: true },
        { productId: 'one', cardKey: 'locked', reservedOrderId: 'pending', reservedAt: new Date() },
        { productId: 'one', cardKey: 'paid-lock', reservedOrderId: 'paid', reservedAt: new Date(0) },
    ])
    const rows = await f.db.select().from(f.schema.cards)
    for (const blocked of rows.slice(1)) {
        await assert.rejects(f.changeCardExpiry('one', [rows[0].id, blocked.id], null))
        assert.ok((await f.db.select().from(f.schema.cards).where(eq(f.schema.cards.id, rows[0].id)))[0].expiresAt)
        await assert.rejects(f.deleteUnconsumedCards([blocked.id]))
    }
    await assert.rejects(f.changeCardExpiry('two', [rows[0].id], null))
})

test('extending an expired unused card recovers a paid order; cleanup retains used and expired history', async t => {
    const f = await setup(t)
    await f.db.insert(f.schema.orders).values({ orderId: 'paid', productId: 'one', productName: 'One', amount: '1', status: 'paid' })
    await f.db.insert(f.schema.cards).values([{ productId: 'one', cardKey: 'expired', expiresAt: new Date(Date.now() - 1) }, { productId: 'one', cardKey: 'used', expiresAt: new Date(0), isUsed: true }])
    await f.queries.cleanupExpiredCardsIfNeeded(0)
    assert.equal((await f.db.select().from(f.schema.cards)).length, 2)
    const expired = (await f.db.select().from(f.schema.cards))[0]
    await f.changeCardExpiry('one', [expired.id], new Date(Date.now() + 3600000).toISOString())
    assert.equal((await f.db.select().from(f.schema.orders))[0].status, 'delivered')
})

test('inventory actions reject non-admin callers before touching storage', async t => {
    const f = fixture(t, { initialize: false, mocks: { '@/actions/admin': { checkAdmin: async () => { throw new Error('Unauthorized') } } } })
    const actions = f.load('actions/inventory')
    for (const [name, args] of [['createInventoryKey', [keyInput()]], ['setInventoryKeyEnabled', ['id', true]], ['updateCardsExpiry', ['one', [1], null]], ['retryOrderDelivery', ['paid']], ['saveExpiryAlertMinutes', [60]]]) {
        await assert.rejects(actions[name](...args), /Unauthorized/)
    }
    assert.equal((await f.dbRun(sql`SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table'`)).results[0].count, 0)
})
