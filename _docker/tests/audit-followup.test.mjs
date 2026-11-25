import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToString } from 'react-dom/server'
import { fixture } from './database-fixture.mjs'

class NextResponse extends Response {
    static json(data, init) { return Response.json(data, init) }
}

async function setup(t, user = { id: 'boss-id', username: 'boss' }) {
    const f = fixture(t, { env: { ADMIN_USERS: 'boss' }, mocks: {
        '@/lib/auth': { auth: async () => user ? { user } : null },
        'next/headers': { cookies: async () => ({ get() {}, set() {} }) },
        'next/server': { NextResponse, after() {} },
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

test('maintenance recalculates stale stored totals once for an existing shop', async t => {
    const f = await setup(t)
    await f.db.insert(f.schema.products).values({ id: 'stale', name: 'Stale', price: '1' })
    await f.dbBatchRaw([
        { sql: "INSERT INTO cards (product_id, card_key, is_used) VALUES ('stale','S1',0),('stale','S2',0)", params: [] },
        { sql: "INSERT INTO orders (order_id, product_id, product_name, amount, status, quantity, created_at) VALUES ('S-O','stale','Stale','1','delivered',3,1)", params: [] },
        // An upgraded shop has wrong totals and no marker for this recalculation yet.
        { sql: "DELETE FROM settings WHERE key = 'product_aggregates_backfilled_v3'", params: [] },
        { sql: "UPDATE products SET stock_count = 99, sold_count = 0 WHERE id = 'stale'", params: [] },
    ])
    await f.reload('lib/db/queries').backfillProductAggregatesOnce()
    let row = (await f.db.select().from(f.schema.products))[0]
    assert.equal(row.stockCount, 2)
    assert.equal(row.soldCount, 3)
    // A later run in a new instance sees the marker and leaves the rows alone.
    await f.dbBatchRaw([{ sql: "UPDATE products SET stock_count = 77 WHERE id = 'stale'", params: [] }])
    await f.reload('lib/db/queries').backfillProductAggregatesOnce()
    row = (await f.db.select().from(f.schema.products))[0]
    assert.equal(row.stockCount, 77)
})

test('variant labels load for more products than one statement can bind', async t => {
    const f = await setup(t)
    await f.dbBatchRaw(Array.from({ length: 230 }, (_, i) => ({ sql: 'INSERT INTO products (id, name, price, variant_label) VALUES (?, ?, ?, ?)', params: ['v' + i, 'V' + i, '1', i % 2 ? 'Label ' + i : null] })))
    const labels = await f.queries.getProductVariantLabels(Array.from({ length: 230 }, (_, i) => 'v' + i))
    assert.equal(Object.keys(labels).length, 115)
    assert.equal(labels.v229, 'Label 229')
})

test('stored and third-party links are restricted before they reach an href', async t => {
    const f = await setup(t)
    const { safeExternalUrl, safeInternalPath } = f.load('lib/safe-url')
    assert.equal(safeExternalUrl('https://shop.example/a?b=1'), 'https://shop.example/a?b=1')
    for (const bad of ['javascript:alert(1)', ' JavaScript:alert(1)', 'data:text/html,x', 'https://user:pw@evil.example', '/relative', '', null, 5]) {
        assert.equal(safeExternalUrl(bad), '#')
    }
    assert.equal(safeInternalPath('/order/ORD1'), '/order/ORD1')
    for (const bad of ['//evil.example', '/' + String.fromCharCode(92) + 'evil.example', 'https://evil.example', 'javascript:alert(1)', 'order/1', '/a b', null]) {
        assert.equal(safeInternalPath(bad), undefined)
    }
})

test('order IDs are unpredictable and keep the expected format', async t => {
    const f = await setup(t)
    const { generateOrderId } = f.load('lib/crypto')
    const ids = new Set(Array.from({ length: 2000 }, () => generateOrderId()))
    assert.equal(ids.size, 2000)
    for (const id of ids) assert.match(id, /^ORD[0-9A-Z]{17,20}$/)
})

test('provider-scoped admin checks prevent cross-provider username collision', async t => {
    const f = await setup(t)
    f.env.ADMIN_USERS = 'gh_boss,linux_boss'
    const { isAdminUser } = f.load('lib/admin-auth')

    // GitHub admins require provider=github or legacy github: user ID.
    assert.equal(isAdminUser({ id: '999', username: 'gh_boss', provider: 'linuxdo' }), false)
    assert.equal(isAdminUser({ id: '999', username: 'gh_boss' }), false)
    assert.equal(isAdminUser({ id: 'github:123', username: 'gh_boss', provider: 'github' }), true)
    assert.equal(isAdminUser({ id: 'github:123', username: 'gh_boss' }), true)

    // GitHub users cannot claim non-gh_ admin names, while Linux DO admins can.
    assert.equal(isAdminUser({ id: 'github:123', username: 'linux_boss', provider: 'github' }), false)
    assert.equal(isAdminUser({ id: '456', username: 'linux_boss', provider: 'linuxdo' }), true)
    assert.equal(isAdminUser({ id: 'owner', username: 'linux_boss' }), true)

    // checkAdmin must reject a Linux DO user attempting to impersonate gh_boss.
    const spoofed = await setup(t, { id: '999', username: 'gh_boss', provider: 'linuxdo' })
    spoofed.env.ADMIN_USERS = 'gh_boss'
    await assert.rejects(spoofed.load('actions/admin').checkAdmin(), /Unauthorized/)

    // GitHub login must never merge a Linux DO row sharing numeric ID + gh_ username.
    let authConfig
    const authFixture = fixture(t, {
        mocks: {
            'next-auth': { __esModule: true, default: (value) => { authConfig = value; return { handlers: {}, auth: async () => null, signIn() {}, signOut() {} } } },
            'next-auth/providers/github': { __esModule: true, default: (value) => ({ id: 'github', ...value }) },
            '@/lib/auth': undefined,
        },
    })
    await authFixture.ready
    authFixture.load('lib/auth')
    await authFixture.db.insert(authFixture.schema.loginUsers).values({ userId: '111', username: 'gh_shared', points: 99 })
    const ghToken = await authConfig.callbacks.jwt({
        token: {},
        user: { id: '111', username: 'gh_shared' },
        profile: { login: 'shared' },
        account: { provider: 'github', providerAccountId: '111' },
    })
    assert.equal(ghToken.provider, 'github')
    assert.equal(ghToken.id, 'github:111')
    const linuxRow = (await authFixture.db.select().from(authFixture.schema.loginUsers)).find((r) => r.userId === '111')
    assert.equal(linuxRow?.points, 99)
    assert.equal(linuxRow?.username, 'gh_shared')
})

test('outbound URL checks block internal and metadata hosts', async t => {
    const f = await setup(t)
    const { safeOutboundHttpUrl } = f.load('lib/safe-url')

    for (const unsafe of [
        'http://127.0.0.1/cards',
        'http://localhost:8080/x',
        'http://169.254.169.254/latest/meta-data',
        'http://10.0.0.1/x',
        'http://172.16.0.1/x',
        'http://192.168.1.1/x',
        'http://100.64.0.1/x',
        'http://[::1]/x',
        'http://[::ffff:127.0.0.1]/x',
        'http://[fe80::1]/x',
        'http://2130706433/x',
        'http://metadata.google.internal/x',
        'http://redis/x',
        'https://user:pass@supplier.example/cards',
        'ftp://supplier.example/cards',
    ]) {
        assert.equal(safeOutboundHttpUrl(unsafe), null, unsafe)
    }

    assert.equal(safeOutboundHttpUrl('https://supplier.example/cards?a=1'), 'https://supplier.example/cards?a=1')
    assert.equal(safeOutboundHttpUrl('https://supplier.example/cards?a=1', { disallowSearch: true }), null)
    assert.equal(safeOutboundHttpUrl('https://api.day.app', { disallowSearch: true }), 'https://api.day.app/')

    const { saveProductCardApiConfig } = f.load('lib/card-api')
    await f.db.insert(f.schema.products).values({ id: 'p-ssrf', name: 'P', price: '1' })
    await assert.rejects(
        saveProductCardApiConfig('p-ssrf', { enabled: true, mode: 'stock', url: 'http://169.254.169.254/latest', token: '' }),
        /apiUrlInvalid/
    )
})

test('shop logo saving and /favicon route neutralize SVG XSS, non-image responses, and SSRF targets', async t => {
    const f = await setup(t)
    const { saveShopLogo } = f.load('actions/admin')

    for (const unsafeLogo of [
        'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>',
        'data:image/svg+xml,<svg/onload=alert(1)></svg>',
        'data:image/svg+xml,<svg><a xlink:href="&#x6a;avascript:alert(1)"><text>x</text></a></svg>',
        `data:image/svg+xml;base64,${Buffer.from('<svg><script>alert(1)</script></svg>').toString('base64')}`,
        'data:image/svg+xml,<svg><foreignObject><body onload=alert(1)></body></foreignObject></svg>',
        'data:text/html,<script>alert(1)</script>',
        'http://169.254.169.254/latest/meta-data',
        '/favicon',
        'javascript:alert(1)',
    ]) {
        await assert.rejects(saveShopLogo(unsafeLogo), /Only safe image data URLs|Invalid logo/, unsafeLogo)
    }

    const safeSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>'
    const safeSvgDataUrl = `data:image/svg+xml;base64,${Buffer.from(safeSvg).toString('base64')}`
    await saveShopLogo(safeSvgDataUrl)

    const { GET: getFaviconSafe } = f.reload('app/favicon/route')
    const safeRes = await getFaviconSafe(new Request('https://shop.example/favicon'))
    assert.equal(safeRes.status, 200)
    assert.equal(safeRes.headers.get('content-type'), 'image/svg+xml')
    assert.equal(safeRes.headers.get('x-content-type-options'), 'nosniff')
    assert.match(safeRes.headers.get('content-security-policy') || '', /\bsandbox\b/)
    assert.match(await safeRes.text(), /<circle/)

    // Even if database contains poisoned SVG or internal URL, /favicon refuses and falls back to generated logo without calling fetch.
    await f.queries.setSetting('shop_logo', 'data:image/svg+xml,<svg onload="alert(1)"></svg>')
    await f.queries.setSetting('shop_logo_source', 'custom')
    const { GET: getFaviconUnsafeSvg } = f.reload('app/favicon/route')
    const fallbackRes = await getFaviconUnsafeSvg(new Request('https://shop.example/favicon'))
    const fallbackBody = await fallbackRes.text()
    assert.doesNotMatch(fallbackBody, /onload=/)
    assert.match(fallbackRes.headers.get('content-security-policy') || '', /\bsandbox\b/)

    let fetchedCount = 0
    f.setFetch(async (url) => {
        fetchedCount++
        if (String(url).includes('html-logo.example')) {
            return new Response('<script>alert(1)</script>', { status: 200, headers: { 'content-type': 'text/html' } })
        }
        return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/secret' } })
    })

    await f.queries.setSetting('shop_logo', 'http://127.0.0.1:9999/secret.png')
    const ssrfRes = await f.reload('app/favicon/route').GET(new Request('https://shop.example/favicon'))
    assert.equal(fetchedCount, 0)
    assert.equal(ssrfRes.headers.get('content-type'), 'image/svg+xml')

    await f.queries.setSetting('shop_logo', 'https://html-logo.example/logo')
    const htmlRes = await f.reload('app/favicon/route').GET(new Request('https://shop.example/favicon'))
    assert.equal(fetchedCount, 1)
    assert.equal(htmlRes.headers.get('content-type'), 'image/svg+xml')
    assert.doesNotMatch(await htmlRes.text(), /<script>/)

    await f.queries.setSetting('shop_logo', 'https://cdn-redirect.example/logo')
    const redirectRes = await f.reload('app/favicon/route').GET(new Request('https://shop.example/favicon'))
    assert.equal(fetchedCount, 2)
    assert.equal(redirectRes.headers.get('content-type'), 'image/svg+xml')
})

test('FooterContent renders safe links without dangerouslySetInnerHTML or script injection', async t => {
    const f = fixture(t, {
        initialize: false,
        mocks: {
            react: React,
            '@/lib/i18n/context': { useI18n: () => ({ t: (k) => k }) },
        },
    })
    await f.ready
    const { FooterContent } = f.load('components/footer-content')
    const html = renderToString(React.createElement(FooterContent, {
        version: '1.5.24',
        customFooter: 'Shop <a href="https://example.com" onclick="alert(1)">Link</a> <a href="javascript:alert(1)">Bad</a> <script>alert(1)</script><img src=x onerror=alert(1)>',
    }))
    assert.match(html, /href="https:\/\/example\.com\/"/)
    assert.match(html, /rel="noopener noreferrer"/)
    assert.doesNotMatch(html, /href="javascript:/)
    assert.doesNotMatch(html, /<script>/)
    assert.doesNotMatch(html, /<img\b/)
    assert.doesNotMatch(html, /onclick=/)
})

test('late payment on a cancelled order cannot create negative points when returned points were spent', async t => {
    const f = await setup(t)
    await f.db.insert(f.schema.products).values({ id: 'p-pts', name: 'Pts', price: '10', stockCount: 2 })
    await f.db.insert(f.schema.cards).values([
        { productId: 'p-pts', cardKey: 'C1', isUsed: false },
        { productId: 'p-pts', cardKey: 'C2', isUsed: false },
    ])
    await f.db.insert(f.schema.loginUsers).values([
        { userId: 'spender', username: 'spender', points: 0 },
        { userId: 'keeper', username: 'keeper', points: 50 },
    ])
    await f.db.insert(f.schema.orders).values([
        { orderId: 'ORD-SPENT', productId: 'p-pts', productName: 'Pts', amount: '5', status: 'pending', userId: 'spender', username: 'spender', pointsUsed: 100, quantity: 1, createdAt: new Date() },
        { orderId: 'ORD-KEPT', productId: 'p-pts', productName: 'Pts', amount: '5', status: 'pending', userId: 'keeper', username: 'keeper', pointsUsed: 100, quantity: 1, createdAt: new Date() },
    ])

    const { cancelPendingOrder } = f.load('lib/order-transitions')
    const { processOrderFulfillment } = f.load('lib/order-processing')
    assert.equal(await cancelPendingOrder('ORD-SPENT'), true)
    assert.equal(await cancelPendingOrder('ORD-KEPT'), true)

    // Spender uses the refunded points down to 40 (< 100 required to reactivate ORD-SPENT).
    await f.dbBatchRaw([{ sql: "UPDATE login_users SET points = 40 WHERE user_id = 'spender'", params: [] }])
    const denied = await processOrderFulfillment('ORD-SPENT', 5, 'TRADE-SPENT')
    assert.equal(denied.status, 'points_insufficient')

    const spenderRow = (await f.db.select().from(f.schema.loginUsers)).find((u) => u.userId === 'spender')
    const spentOrder = (await f.db.select().from(f.schema.orders)).find((o) => o.orderId === 'ORD-SPENT')
    const conflict = (await f.db.select().from(f.schema.inventoryEvents)).find((e) => e.orderId === 'ORD-SPENT' && e.kind === 'payment_conflict')
    assert.equal(spenderRow?.points, 40)
    assert.equal(spentOrder?.status, 'cancelled')
    assert.ok(conflict, 'insufficient points late payment must record payment_conflict')

    // Keeper kept all refunded points (150 >= 100), so late payment succeeds cleanly.
    const ok = await processOrderFulfillment('ORD-KEPT', 5, 'TRADE-KEPT')
    assert.equal(ok.status, 'processed')
    const keeperRow = (await f.db.select().from(f.schema.loginUsers)).find((u) => u.userId === 'keeper')
    const keptOrder = (await f.db.select().from(f.schema.orders)).find((o) => o.orderId === 'ORD-KEPT')
    assert.equal(keeperRow?.points, 50)
    assert.equal(keptOrder?.status, 'delivered')
})

test('importData blocks stacked queries, subqueries, and non-INSERT SQL while supporting valid multiline values', async t => {
    const f = await setup(t)
    await f.db.insert(f.schema.products).values({ id: 'keep-prod', name: 'Keep', price: '1' })
    const lines = [
        "INSERT INTO cards (id, productId, cardKey, isUsed) VALUES (1, 'keep-prod', 'L1' || char(10) || 'L2', 0);",
        "INSERT INTO cards (id, productId, cardKey, isUsed) VALUES (2, 'keep-prod', 'X', 0); DROP TABLE products; --",
        "DELETE FROM products;",
        "INSERT INTO sqlite_master (name) VALUES ('evil');",
        "INSERT INTO cards (id, productId, cardKey, isUsed) VALUES (3, 'keep-prod', (SELECT 'sub'), 0);",
        "INSERT INTO cards (id, bad$col, cardKey) VALUES (4, 'keep-prod', 'Z');",
    ]
    const result = await f.load('actions/data').importData({ get: () => ({ text: async () => lines.join('\n') }) })
    assert.equal(result.success, true, JSON.stringify(result))
    assert.equal(result.count, 1)
    assert.equal(result.errors, 5)
    assert.equal((await f.db.select().from(f.schema.products)).length, 1)
    const cardsRows = await f.db.select().from(f.schema.cards)
    assert.equal(cardsRows.length, 1)
    assert.equal(cardsRows[0].cardKey, 'L1\nL2')
})
