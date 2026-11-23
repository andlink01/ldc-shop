import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sql } from 'drizzle-orm'
import { fixture } from './database-fixture.mjs'

async function setup(t) {
    const f = fixture(t, { env: { ADMIN_USERS: 'buyer' }, mocks: {
        '@/lib/auth': { auth: async () => ({ user: { id: 'user', username: 'buyer' } }) },
    } })
    await f.ready
    await f.db.insert(f.schema.products).values([
        { id: 'product', name: 'Product', price: '3' },
        { id: 'shared', name: 'Shared', price: '3', isShared: true },
    ])
    return { ...f, ...f.load('actions/admin'), ...f.load('lib/card-api') }
}

test('both modes save empty disabled drafts and return a readable error when enabling without a URL', async t => {
    const f = await setup(t)
    for (const mode of ['stock', 'on_demand']) {
        const saved = await f.saveCardsApiConfig('product', '', '', false, mode)
        assert.equal(saved.success, true)
        assert.equal(saved.enabled, false)
        assert.equal(saved.autoPulled, false)
        const enabled = await f.setCardsApiEnabled('product', true)
        assert.equal(enabled.success, false)
        assert.equal(enabled.error, 'admin.cards.apiUrlRequired')
        assert.equal((await f.getProductCardApiConfig('product')).enabled, false)
        const saveEnabled = await f.saveCardsApiConfig('product', '', '', true, mode)
        assert.equal(saveEnabled.success, false)
        assert.equal(saveEnabled.error, 'admin.cards.apiUrlRequired')
    }
})

test('invalid configuration never overwrites saved settings and returns structured errors without secrets', async t => {
    const f = await setup(t)
    await f.saveCardsApiConfig('product', 'https://supplier.example/cards', '', false, 'stock')
    const cases = [
        ['not-a-url', '', 'stock', 'apiUrlInvalid'],
        ['ftp://supplier.example/cards', '', 'stock', 'apiUrlInvalid'],
        ['https://user:PRIVATE-PASSWORD@supplier.example/cards', '', 'stock', 'apiUrlInvalid'],
        ['https://supplier.example/cards?token=PRIVATE-TOKEN', '', 'on_demand', 'apiUrlQueryUnsupported'],
        ['https://supplier.example/cards', 'PRIVATE\nTOKEN', 'stock', 'apiTokenInvalid'],
        ['https://supplier.example/cards', 'x'.repeat(1001), 'stock', 'apiTokenTooLong'],
        ['https://supplier.example/cards', '', 'bad-mode', 'apiModeInvalid'],
    ]
    for (const [url, token, mode, code] of cases) {
        const result = await f.saveCardsApiConfig('product', url, token, true, mode)
        assert.equal(result.success, false)
        assert.equal(result.error, `admin.cards.${code}`)
        assert.ok(!JSON.stringify(result).includes('PRIVATE'))
        assert.equal((await f.getProductCardApiConfig('product')).url, 'https://supplier.example/cards')
        assert.equal((await f.getProductCardApiConfig('product')).enabled, false)
    }
    assert.equal((await f.saveCardsApiConfig('shared', '', '', false, 'on_demand')).error, 'admin.cards.apiSharedUnsupported')
    assert.equal((await f.saveCardsApiConfig('missing', '', '', false, 'stock')).error, 'admin.cards.apiProductMissing')
})

test('procurement can be enabled and disabled with an empty optional token without purchasing', async t => {
    const f = await setup(t)
    const saved = await f.saveCardsApiConfig('product', 'https://supplier.example/cards', '', false, 'on_demand')
    assert.equal(saved.success, true)
    const enabled = await f.setCardsApiEnabled('product', true)
    assert.equal(enabled.success, true)
    assert.equal(enabled.autoPulled, false)
    assert.equal((await f.getProductCardApiConfig('product')).token, '')
    assert.equal((await f.setCardsApiEnabled('product', false)).success, true)
    assert.equal((await f.db.select().from(f.schema.supplierRequests)).length, 0)
    assert.equal((await f.db.select().from(f.schema.cards)).length, 0)
})

test('legacy automatic pull connection failures do not turn a saved configuration into a Server Action exception', async t => {
    const f = await setup(t)
    f.setFetch(async () => { throw new Error('PRIVATE-TOKEN') })
    const result = await f.saveCardsApiConfig('product', 'https://supplier.example/cards', 'PRIVATE-TOKEN', true, 'stock')
    assert.equal(result.success, true)
    assert.equal(result.autoPulled, false)
    assert.equal(result.autoPullError, 'api_network_error')
    assert.ok(!JSON.stringify(result).includes('PRIVATE-TOKEN'))
    assert.equal((await f.getProductCardApiConfig('product')).enabled, true)
})

test('manual stock pulls report provider failures as data and add no unusable card', async t => {
    const f = await setup(t)
    await f.saveProductCardApiConfig('product', { enabled: true, mode: 'stock', url: 'https://supplier.example/cards', token: '' })
    const cases = [
        [async () => { throw new Error('PRIVATE-TOKEN') }, 'api_network_error'],
        [async () => { throw Object.assign(new Error('PRIVATE-TOKEN'), { name: 'TimeoutError' }) }, 'api_timeout'],
        [async () => new Response('PRIVATE-TOKEN', { status: 520 }), 'api_request_failed_520'],
        [async () => new Response('PRIVATE-TOKEN', { headers: { 'Content-Type': 'application/json' } }), 'api_invalid_response'],
        [async () => Response.json({}), 'api_card_missing'],
    ]
    for (const [fetch, error] of cases) {
        f.setFetch(fetch)
        const result = await f.pullCardFromApi('product')
        assert.equal(result.success, false)
        assert.equal(result.error, error)
        assert.ok(!JSON.stringify(result).includes('PRIVATE'))
        assert.equal((await f.db.select().from(f.schema.cards)).length, 0)
    }
    f.setFetch(async () => Response.json({ cardKey: 'USABLE-CARD' }))
    assert.equal((await f.pullCardFromApi('product')).success, true)
    assert.equal((await f.db.select().from(f.schema.cards))[0].cardKey, 'USABLE-CARD')
})

test('failed manual card persistence reports a safe error without exposing the card or database details', async t => {
    const f = await setup(t)
    await f.saveProductCardApiConfig('product', { enabled: true, mode: 'stock', url: 'https://supplier.example/cards', token: '' })
    f.setFetch(async () => Response.json({ cardKey: 'PRIVATE-CARD' }))
    await f.dbRun(sql.raw("CREATE TRIGGER isolated_pull_failure BEFORE INSERT ON cards BEGIN SELECT RAISE(ABORT, 'PRIVATE-CARD'); END;"))
    const result = await f.pullCardFromApi('product')
    assert.equal(result.success, false)
    assert.equal(result.error, 'api_insert_failed')
    assert.ok(!JSON.stringify(result).includes('PRIVATE'))
    assert.equal((await f.db.select().from(f.schema.cards)).length, 0)
})
