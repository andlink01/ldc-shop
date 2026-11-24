import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fixture } from './database-fixture.mjs'

async function setup(t, user = { id: 'boss-id', username: 'boss' }) {
    const f = fixture(t, { env: { ADMIN_USERS: 'boss' }, mocks: {
        '@/lib/auth': { auth: async () => user ? { user } : null },
        'next/headers': { cookies: async () => ({ get() {}, set() {} }) },
    } })
    await f.ready
    return f
}

const form = values => ({ get: key => values[key] ?? null, getAll: key => values[key] === undefined ? [] : [values[key]] })

test('saving a product rejects prices and limits that checkout cannot charge correctly', async t => {
    const f = await setup(t)
    const { saveProduct } = f.load('actions/admin')
    const base = { slug: 'item', name: 'Item', description: '', category: '', image: '' }
    for (const price of ['', 'abc', '-1', '1.005', '1e3', ' ', '1,5', 'NaN', '12345678901']) {
        await assert.rejects(saveProduct(form({ ...base, price })), /Invalid price/, 'price ' + price)
    }
    await assert.rejects(saveProduct(form({ ...base, price: '3', compareAtPrice: 'free' })), /compare-at/)
    for (const purchaseLimit of ['abc', '-2', '1.5']) {
        await assert.rejects(saveProduct(form({ ...base, price: '3', purchaseLimit })), /purchase limit/)
    }
    await assert.rejects(saveProduct(form({ ...base, name: '   ', price: '3' })), /product name/)
    assert.equal((await f.db.select().from(f.schema.products)).length, 0)

    await saveProduct(form({ ...base, price: ' 03.50 ', compareAtPrice: '5', purchaseLimit: '2' }))
    const saved = (await f.db.select().from(f.schema.products))[0]
    assert.equal(saved.price, '3.5')
    assert.equal(saved.compareAtPrice, '5')
    assert.equal(saved.purchaseLimit, 2)
    await saveProduct(form({ ...base, id: 'item', price: '0' }))
    assert.equal((await f.db.select().from(f.schema.products))[0].price, '0')
})

test('point balances can only be set to whole non-negative numbers', async t => {
    const f = await setup(t)
    await f.db.insert(f.schema.loginUsers).values({ userId: 'buyer', username: 'buyer', points: 10 })
    const { saveUserPoints } = f.load('actions/admin-users')
    for (const points of [-1, 1.5, NaN, Infinity, '7', null]) {
        await assert.rejects(saveUserPoints('buyer', points), /Invalid points/)
    }
    assert.equal((await f.db.select().from(f.schema.loginUsers))[0].points, 10)
    await saveUserPoints('buyer', 25)
    assert.equal((await f.db.select().from(f.schema.loginUsers))[0].points, 25)
})

test('recording a visit writes only when something changed or the last visit is old', async t => {
    const f = await setup(t)
    const { recordLoginUser } = f.queries
    const row = async () => (await f.db.select().from(f.schema.loginUsers))[0]
    await recordLoginUser('buyer', 'buyer', null)
    assert.equal((await row()).username, 'buyer')
    await f.dbBatchRaw([{ sql: 'UPDATE login_users SET last_login_at = ?', params: [Date.now() - 60_000] }])
    const before = new Date((await row()).lastLoginAt).getTime()
    await recordLoginUser('buyer', 'buyer', null)
    assert.equal(new Date((await row()).lastLoginAt).getTime(), before)

    await recordLoginUser('buyer', 'renamed', null)
    assert.equal((await row()).username, 'renamed')
    await recordLoginUser('buyer', 'renamed', 'buyer@example.com')
    assert.equal((await row()).email, 'buyer@example.com')

    await f.dbBatchRaw([{ sql: 'UPDATE login_users SET last_login_at = ?', params: [Date.now() - 11 * 60_000] }])
    await recordLoginUser('buyer', 'renamed', 'buyer@example.com')
    assert.ok(Date.now() - new Date((await row()).lastLoginAt).getTime() < 60_000)
})

test('a large backup imports in groups and one bad row does not drop its neighbours', async t => {
    const f = await setup(t)
    await f.db.insert(f.schema.products).values({ id: 'product', name: 'Product', price: '3' })
    const lines = ['-- Database Migration Dump']
    for (let i = 0; i < 120; i++) lines.push("INSERT OR IGNORE INTO cards (id, productId, cardKey, isUsed) VALUES (" + (i + 1) + ", 'product', 'IMPORTED-" + i + "', 0);")
    lines.splice(30, 0, "INSERT OR IGNORE INTO table_from_another_version (id) VALUES (1);")
    lines.splice(90, 0, "INSERT OR IGNORE INTO cards (id, productId, no_such_column) VALUES (999, 'product', 'SECRET-IN-BAD-ROW');")
    const logged = []
    const original = console.error
    console.error = (...args) => logged.push(args.join(' '))
    t.after(() => { console.error = original })
    const result = await f.load('actions/data').importData({ get: () => ({ text: async () => lines.join('\n') }) })
    assert.equal(result.success, true, JSON.stringify(result))
    assert.equal(result.count, 120)
    assert.equal(result.errors, 2)
    assert.equal((await f.db.select().from(f.schema.cards)).length, 120)
    assert.ok(!logged.some(line => line.includes('SECRET-IN-BAD-ROW') || line.includes('IMPORTED-')))
    assert.equal((await f.db.select().from(f.schema.products))[0].stockCount, 120)
})

test('recalculating many products at once updates each one from its own rows', async t => {
    const f = await setup(t)
    await f.db.insert(f.schema.products).values([{ id: 'a', name: 'A', price: '1' }, { id: 'b', name: 'B', price: '1' }, { id: 'c', name: 'C', price: '1', isShared: true }])
    await f.dbBatchRaw([
        { sql: "INSERT INTO cards (product_id, card_key, is_used) VALUES ('a','A1',0),('a','A2',0),('a','A3',1),('b','B1',0),('c','C1',0)", params: [] },
        { sql: "INSERT INTO orders (order_id, product_id, product_name, amount, status, quantity, created_at) VALUES ('O1','a','A','1','delivered',2,1),('O2','b','B','1','pending',5,1),('O3','b','B','1','paid',1,1)", params: [] },
        { sql: "INSERT INTO reviews (product_id, order_id, user_id, username, rating, created_at) VALUES ('a','O1','u','u',4,1),('a','O9','u','u',2,1)", params: [] },
    ])
    await f.queries.recalcProductAggregatesForMany(['a', 'b', 'c', 'missing'])
    const rows = Object.fromEntries((await f.db.select().from(f.schema.products)).map(row => [row.id, row]))
    assert.equal(rows.a.stockCount, 2)
    assert.equal(rows.a.soldCount, 2)
    assert.equal(rows.a.reviewCount, 2)
    assert.equal(rows.a.rating, 3)
    assert.equal(rows.b.stockCount, 1)
    assert.equal(rows.b.soldCount, 1)
    assert.equal(rows.b.reviewCount, 0)
    assert.equal(rows.c.stockCount, 999999)
})
