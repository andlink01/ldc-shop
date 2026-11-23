import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fixture } from './database-fixture.mjs'

async function setup(t, { session = { user: { id: 'buyer', username: 'buyer', trustLevel: 2 } }, product = {}, user = {} } = {}) {
    const f = fixture(t, { mocks: { '@/lib/auth': { auth: async () => session } } })
    await f.ready
    await f.db.insert(f.schema.loginUsers).values({ userId: 'buyer', username: 'buyer', points: 10, ...user })
    await f.db.insert(f.schema.products).values({ id: 'product', name: 'Product', price: '1', purchaseQuestions: JSON.stringify([{ q: 'Question?', a: 'PRIVATE-PURCHASE-ANSWER' }]), ...product })
    return f
}

test('public product and variant data omit answers while administrators retain the original questions', async t => {
    const f = await setup(t, { product: { variantGroupId: 'group' } })
    await f.db.insert(f.schema.products).values({ id: 'variant', name: 'Variant', price: '2', variantGroupId: 'group', purchaseQuestions: JSON.stringify([{ q: 'Variant question?', a: 'PRIVATE-VARIANT-ANSWER' }]) })
    const product = await f.queries.getProduct('product', { isLoggedIn: true, trustLevel: 2 })
    const variants = await f.queries.getProductVariants('group', { isLoggedIn: true, trustLevel: 2 })
    assert.deepEqual(JSON.parse(product.purchaseQuestions), [{ q: 'Question?' }])
    assert.deepEqual(JSON.parse(variants.find(variant => variant.id === 'variant').purchaseQuestions), [{ q: 'Variant question?' }])
    assert.ok(!JSON.stringify([product, variants]).includes('PRIVATE-'))
    assert.equal(JSON.parse((await f.queries.getProductForAdmin('product')).purchaseQuestions)[0].a, 'PRIVATE-PURCHASE-ANSWER')
})

test('answer verification uses the server without creating orders or consuming points and stock', async t => {
    const f = await setup(t)
    const verify = f.load('actions/buy').verifyPurchaseAnswers
    for (const answers of [undefined, [{}], [null], Array(1), 'PRIVATE-PURCHASE-ANSWER', ['wrong']]) {
        assert.equal((await verify('product', answers)).success, false)
    }
    assert.equal((await verify('product', [' private-purchase-answer '])).success, true)
    assert.equal((await f.db.select().from(f.schema.orders)).length, 0)
    assert.equal((await f.db.select().from(f.schema.cards)).length, 0)
    assert.equal((await f.db.select().from(f.schema.loginUsers))[0].points, 10)
})

test('answer verification refuses anonymous, blocked and lower-trust users', async t => {
    for (const [options, error] of [
        [{ session: null }, 'common.loginRequired'],
        [{ user: { isBlocked: true } }, 'buy.userBlocked'],
        [{ product: { visibilityLevel: 3 } }, 'buy.visibilityDenied'],
    ]) {
        const f = await setup(t, options)
        const result = await f.load('actions/buy').verifyPurchaseAnswers('product', ['PRIVATE-PURCHASE-ANSWER'])
        assert.equal(result.success, false)
        assert.equal(result.error, error)
    }
})

test('answer verification refuses invalid stored questions and preserves products without questions', async t => {
    const invalid = await setup(t, { product: { purchaseQuestions: '{invalid' } })
    assert.equal((await invalid.load('actions/buy').verifyPurchaseAnswers('product', ['anything'])).error, 'buy.questionsUnavailable')
    const normal = await setup(t, { product: { purchaseQuestions: null } })
    assert.equal((await normal.load('actions/buy').verifyPurchaseAnswers('product')).success, true)
})
