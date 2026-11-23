import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fixture } from './database-fixture.mjs'

async function setup(t) {
    const f = fixture(t, { mocks: {
        '@/lib/auth': { auth: async () => null },
        '@/actions/settings': { getActiveAnnouncement: async () => null },
        '@/components/home-content': { HomeContent: () => null },
        '@/components/buy-content': { BuyContent: () => null },
        '@/components/buy-restricted': { BuyRestricted: () => null },
    } })
    await f.ready
    return f
}

test('storefront settings read only public keys and reflect subsequent updates', async t => {
    const f = await setup(t)
    for (const [key, value] of Object.entries({ shop_name: 'First', shop_footer: 'Footer', checkin_enabled: 'false', bark_device_key: 'PRIVATE-DEVICE', merchant_key: 'PRIVATE-PAYMENT', 'product_card_api_token:test': 'PRIVATE-SUPPLIER' })) {
        await f.queries.setSetting(key, value)
    }
    const { getStorefrontSettings } = f.load('lib/storefront')
    const settings = await getStorefrontSettings()
    assert.equal(settings.shop_name, 'First')
    assert.equal(settings.checkin_enabled, 'false')
    assert.ok(!JSON.stringify(settings).includes('PRIVATE'))
    await f.queries.setSetting('shop_name', 'Updated')
    assert.equal((await getStorefrontSettings()).shop_name, 'Updated')
})

test('home keeps the entire searchable description but excludes gallery and checkout-only fields', async t => {
    const f = await setup(t)
    await f.db.insert(f.schema.products).values({ id: 'product', name: 'Product', price: '3',
        description: '**Details** ' + 'search text '.repeat(80) + 'last-word',
        productImages: '["https://images.example/PRIVATE-GALLERY.png"]', purchaseWarning: 'Checkout warning',
        purchaseLimit: 2, purchaseQuestions: '[{"question":"Checkout question"}]', category: 'Tools' })
    const page = await f.load('app/page').default({})
    const [product] = page.props.products
    assert.equal(product.descriptionPlain.startsWith('Details'), true)
    assert.equal(product.descriptionPlain.endsWith('last word'), true)
    for (const field of ['description', 'productImages', 'purchaseLimit', 'purchaseWarning', 'purchaseQuestions', 'allVariantIds', 'createdAt', 'visibilityLevel']) {
        assert.equal(Object.hasOwn(product, field), false, field)
    }
    assert.equal(product.category, 'Tools')
    assert.ok(!JSON.stringify(product).includes('PRIVATE-GALLERY'))
})

test('variant page shares one real stock read and preserves reservations, expiry and procurement availability', async t => {
    const f = await setup(t)
    await f.db.insert(f.schema.products).values([
        { id: 'ordinary', name: 'Ordinary', price: '3', variantGroupId: 'group' },
        { id: 'supplier', name: 'Supplier', price: '4', variantGroupId: 'group' },
        { id: 'shared', name: 'Shared', price: '5', variantGroupId: 'group', isShared: true },
    ])
    await f.db.insert(f.schema.cards).values([
        { productId: 'ordinary', cardKey: 'available' },
        { productId: 'ordinary', cardKey: 'reserved', reservedAt: new Date(), reservedOrderId: 'pending' },
        { productId: 'ordinary', cardKey: 'expired', expiresAt: new Date(Date.now() - 10_000) },
    ])
    await f.load('lib/card-api').saveProductCardApiConfig('supplier', { enabled: true, mode: 'on_demand', url: 'https://supplier.example/cards', token: '' })
    const read = f.queries.getLiveCardStats, calls = []
    f.queries.getLiveCardStats = ids => { calls.push(ids); return read(ids) }
    const page = await f.load('app/buy/[id]/page').default({ params: Promise.resolve({ id: 'ordinary' }) })
    assert.equal(calls.length, 1)
    assert.equal(page.props.stockCount, 1)
    assert.equal(page.props.lockedStockCount, 1)
    assert.equal(page.props.variants.find(v => v.id === 'ordinary').stockCount, 1)
    assert.equal(page.props.variants.find(v => v.id === 'shared').stockCount, 0)
    assert.ok(page.props.variants.find(v => v.id === 'supplier').stockCount > 1)
})
