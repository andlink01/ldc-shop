import assert from 'node:assert/strict'
import { test } from 'node:test'
import { eq, sql } from 'drizzle-orm'
import { fixture } from './database-fixture.mjs'

async function setup(t) {
    let authorized = true
    const f = fixture(t, { mocks: { '@/actions/admin': { checkAdmin: async () => { if (!authorized) throw new Error('Unauthorized') } } } })
    await f.ready
    await f.db.insert(f.schema.products).values({ id: 'product', name: 'Product', price: '1' })
    const manager = f.load('lib/inventory-management')
    const actions = f.load('actions/inventory')
    const api = f.load('lib/inventory-api')
    return { ...f, ...manager, ...actions, ...api, deny() { authorized = false } }
}
const input = { name: 'Tool', productIds: ['product'], canRead: true, canWrite: false, expiresAt: null }
const request = token => new Request('https://shop.example/api/v1/products', { headers: { Authorization: `Bearer ${token}` } })

test('keys are encrypted at rest and remain viewable after module reload', async t => {
    const f = await setup(t)
    const issued = await f.createManagedInventoryKey(input, 'admin')
    const [key] = await f.db.select().from(f.schema.inventoryApiKeys)
    assert.match(key.tokenEncrypted, /^v1\./)
    assert.ok(!JSON.stringify(key).includes(issued.token))
    assert.equal((await f.reload('lib/inventory-management').readManagedInventoryToken(key.id)).token, issued.token)
    const viewed = await f.viewInventoryKey(key.id)
    assert.equal(viewed.success, true)
    assert.equal(viewed.token, issued.token)
})

test('reset invalidates the old key, keeps permissions and expiry, and preserves its request history', async t => {
    const f = await setup(t)
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString()
    const issued = await f.createManagedInventoryKey({ ...input, expiresAt }, 'admin')
    const [before] = await f.db.select().from(f.schema.inventoryApiKeys)
    assert.equal((await f.listInventoryProducts(request(issued.token))).status, 200)
    const reset = await f.resetInventoryKey(before.id)
    assert.equal(reset.success, true)
    assert.notEqual(reset.token, issued.token)
    assert.equal((await f.listInventoryProducts(request(issued.token))).status, 401)
    assert.equal((await f.listInventoryProducts(request(reset.token))).status, 200)
    const [after] = await f.db.select().from(f.schema.inventoryApiKeys)
    for (const field of ['id', 'name', 'productIds', 'canRead', 'canWrite', 'isEnabled']) assert.equal(after[field], before[field])
    assert.equal(after.expiresAt.getTime(), before.expiresAt.getTime())
    assert.ok((await f.db.select().from(f.schema.inventoryApiRequests)).some(row => row.keyId === before.id))
})

test('legacy hashes remain usable and can be reset in place to become viewable', async t => {
    const f = await setup(t)
    const old = 'ldc_inv_' + 'a'.repeat(64)
    await f.db.insert(f.schema.inventoryApiKeys).values({ id: 'legacy', name: 'Legacy', tokenHash: await f.hashInventoryToken(old),
        tokenPrefix: old.slice(0, 16), productIds: '["product"]', canRead: true, canWrite: false, createdAt: new Date() })
    assert.equal((await f.listInventoryProducts(request(old))).status, 200)
    const viewed = await f.viewInventoryKey('legacy')
    assert.equal(viewed.success, false)
    assert.equal(viewed.error, 'inventory.keyLegacyUnavailable')
    const reset = await f.resetInventoryKey('legacy')
    assert.equal(reset.success, true)
    assert.equal((await f.viewInventoryKey('legacy')).token, reset.token)
    assert.equal((await f.db.select().from(f.schema.inventoryApiKeys)).length, 1)
})

test('changed secrets and altered ciphertext return readable failures without disabling hash authentication', async t => {
    const f = await setup(t)
    const issued = await f.createManagedInventoryKey(input, 'admin')
    const [key] = await f.db.select().from(f.schema.inventoryApiKeys)
    f.env.AUTH_SECRET = 'changed-test-secret'
    assert.equal((await f.viewInventoryKey(key.id)).error, 'inventory.keyDecryptFailed')
    assert.equal((await f.listInventoryProducts(request(issued.token))).status, 200)
    const reset = await f.resetInventoryKey(key.id)
    assert.equal((await f.viewInventoryKey(key.id)).token, reset.token)
    await f.db.update(f.schema.inventoryApiKeys).set({ tokenEncrypted: 'v1.invalid.invalid' }).where(eq(f.schema.inventoryApiKeys.id, key.id))
    assert.equal((await f.viewInventoryKey(key.id)).error, 'inventory.keyDecryptFailed')
})

test('view and reset require administrator authentication before accessing token values', async t => {
    const f = await setup(t)
    await f.createManagedInventoryKey(input, 'admin')
    const [key] = await f.db.select().from(f.schema.inventoryApiKeys)
    f.deny()
    await assert.rejects(f.viewInventoryKey(key.id), /Unauthorized/)
    await assert.rejects(f.resetInventoryKey(key.id), /Unauthorized/)
    assert.equal((await f.db.select().from(f.schema.inventoryApiKeys))[0].tokenHash, key.tokenHash)
})

test('schema 24 upgrades preserve legacy keys, card stock and request history', async t => {
    const f = await setup(t)
    const old = 'ldc_inv_' + 'b'.repeat(64)
    await f.db.insert(f.schema.inventoryApiKeys).values({ id: 'legacy', name: 'Legacy', tokenHash: await f.hashInventoryToken(old), tokenPrefix: old.slice(0, 16), createdAt: new Date() })
    await f.db.insert(f.schema.cards).values({ productId: 'product', cardKey: 'STOCK' })
    await f.listInventoryProducts(request(old))
    await f.dbRun(sql.raw('ALTER TABLE inventory_api_keys DROP COLUMN token_encrypted'))
    await f.queries.setSetting('schema_version', '24')
    const upgraded = f.reload('lib/db/queries')
    await upgraded.ensureDatabaseInitialized()
    assert.equal(await upgraded.getSetting('schema_version'), '25')
    const [key] = await f.db.select().from(f.schema.inventoryApiKeys)
    assert.equal(key.tokenEncrypted, null)
    assert.equal(key.tokenHash, await f.hashInventoryToken(old))
    assert.equal((await f.listInventoryProducts(request(old))).status, 200)
    assert.equal((await f.db.select().from(f.schema.cards))[0].cardKey, 'STOCK')
    assert.ok((await f.db.select().from(f.schema.inventoryApiRequests)).length > 0)
})
