import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fixture, API_KEY } from './database-fixture.mjs'

async function setup(t) {
    const f = fixture(t, { mocks: {
        '@/lib/auth': { auth: async () => null },
        '@/actions/settings': { getActiveAnnouncement: async () => null },
        '@/components/home-content': { HomeContent: () => null },
        '@/components/search-content': { SearchContent: () => null },
    } })
    await f.ready
    return f
}

async function pageProducts(f) {
    const home = await f.load('app/page').default({})
    const search = await f.load('app/search/page').default({ searchParams: Promise.resolve({}) })
    return [home.props.products, search.props.products]
}

test('zero-card procurement products remain purchasable on home and search while API stock stays real', async t => {
    const f = await setup(t)
    await f.db.insert(f.schema.products).values({ id: 'supplier', name: 'Supplier product', price: '1' })
    const cardApi = f.load('lib/card-api')
    await cardApi.saveProductCardApiConfig('supplier', { enabled: true, mode: 'on_demand', url: 'https://supplier.example/cards', token: '' })
    for (const products of await pageProducts(f)) {
        assert.equal(products.length, 1)
        assert.equal(products[0].onDemand, true)
        assert.ok(products[0].stockCount > 0)
    }
    const response = await f.load('lib/inventory-api').getInventoryStock(
        new Request('https://shop.example', { headers: { Authorization: `Bearer ${API_KEY}` } }),
        { params: Promise.resolve({ productId: 'supplier' }) },
    )
    assert.equal(response.status, 200)
    const data = (await response.json()).data
    assert.equal(data.fulfillmentMode, 'on_demand')
    assert.deepEqual(data.stock, { unused: 0, available: 0, locked: 0 })
    await cardApi.saveProductCardApiConfig('supplier', { enabled: false, mode: 'on_demand', url: 'https://supplier.example/cards', token: '' })
    for (const products of await pageProducts(f)) {
        assert.equal(products[0].onDemand, false)
        assert.equal(products[0].stockCount, 0)
    }
})

test('mixed variant groups retain procurement availability even when representative has no supplier', async t => {
    const f = await setup(t)
    await f.db.insert(f.schema.products).values([
        { id: 'ordinary', name: 'Ordinary', price: '1', variantGroupId: 'group', sortOrder: 0 },
        { id: 'supplier', name: 'Supplier', price: '2', variantGroupId: 'group', sortOrder: 1 },
    ])
    await f.load('lib/card-api').saveProductCardApiConfig('supplier', { enabled: true, mode: 'on_demand', url: 'https://supplier.example/cards', token: '' })
    const [group] = await f.queries.getActiveProducts()
    assert.equal(group.id, 'ordinary')
    assert.equal(group.isOnDemand, 0)
    assert.equal(group.groupOnDemand, true)
    for (const products of await pageProducts(f)) {
        assert.equal(products.length, 1)
        assert.equal(products[0].onDemand, true)
        assert.ok(products[0].stockCount > 0)
    }
})

test('empty shared variants do not turn ordinary inventory into infinite stock; expired cards stay excluded', async t => {
    const f = await setup(t)
    await f.db.insert(f.schema.products).values([
        { id: 'shared', name: 'Shared', price: '1', isShared: true, variantGroupId: 'group', sortOrder: 0 },
        { id: 'ordinary', name: 'Ordinary', price: '2', variantGroupId: 'group', sortOrder: 1 },
        { id: 'expired', name: 'Expired', price: '3' },
    ])
    await f.db.insert(f.schema.cards).values([
        { productId: 'ordinary', cardKey: 'available' },
        { productId: 'ordinary', cardKey: 'locked', reservedAt: new Date(), reservedOrderId: 'pending' },
        { productId: 'ordinary', cardKey: 'used', isUsed: true },
        { productId: 'expired', cardKey: 'expired', expiresAt: new Date(Date.now() - 10_000) },
    ])
    for (const products of await pageProducts(f)) {
        assert.equal(products.find(p => p.id === 'shared').stockCount, 2)
        assert.equal(products.find(p => p.id === 'expired').stockCount, 0)
    }
    await f.db.insert(f.schema.cards).values({ productId: 'shared', cardKey: 'shared-active' })
    for (const products of await pageProducts(f)) {
        assert.ok(products.find(p => p.id === 'shared').stockCount > 2)
    }
})
