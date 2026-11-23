import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fixture } from './database-fixture.mjs'

class NextResponse extends Response {
    static json(data, init) { return Response.json(data, init) }
}
const options = {
    env: { ADMIN_USERS: 'admin' },
    mocks: { 'next/server': { NextResponse, after() {} }, '@/lib/auth': { auth: async () => ({ user: { id: 'admin', username: 'admin' } }) }, '@/actions/admin': { checkAdmin: async () => {} } },
}

test('full SQL backup restores key hashes, procurement IDs and delivery deduplication including multiline cards', async t => {
    const f = fixture(t, options)
    await f.ready
    await f.db.insert(f.schema.products).values({ id: 'product', name: 'Product', price: '1' })
    await f.db.insert(f.schema.loginUsers).values({ userId: 'user', username: 'buyer' })
    await f.db.insert(f.schema.orders).values({ orderId: 'order', productId: 'product', productName: 'Product', amount: '1', status: 'paid', userId: 'user' })
    await f.db.insert(f.schema.cards).values({ productId: 'product', cardKey: "line 1\nline '2'\rline 3", supplierRequestId: 'purchase' })
    const card = (await f.db.select().from(f.schema.cards))[0]
    await f.db.insert(f.schema.supplierRequests).values({ requestId: 'purchase', orderId: 'order', itemIndex: 0, serverUrl: 'https://supplier.example/cards', cardId: card.id, state: 'received', createdAt: new Date() })
    const issued = await f.load('lib/inventory-management').createManagedInventoryKey({ name: 'Tool', productIds: ['product'], canRead: true, canWrite: false, expiresAt: null }, 'admin')
    await f.load('lib/fulfillment').fulfillPaidOrder('order')
    const response = await f.load('app/admin/data/download/route').GET(new Request('https://shop.example/admin/data/download?type=full&format=sql'))
    assert.equal(response.status, 200)
    const dump = await response.text()
    assert.ok(!dump.includes(issued.token))
    assert.ok(dump.includes('token_encrypted'))
    assert.match(dump, /char\(10\)/)
    for (const name of ['inventory_api_keys', 'order_deliveries', 'inventory_events', 'supplier_requests']) assert.ok(dump.includes(`INTO ${name}`))
    const restored = fixture(t, options)
    await restored.ready
    const result = await restored.load('actions/data').importData({ get: () => ({ text: async () => dump }) })
    assert.equal(result.success, true)
    assert.equal(result.errors, 0)
    assert.equal((await restored.db.select().from(restored.schema.orders))[0].cardKey, "line 1\nline '2'\rline 3")
    assert.equal((await restored.db.select().from(restored.schema.supplierRequests))[0].requestId, 'purchase')
    assert.equal((await restored.db.select().from(restored.schema.cards))[0].supplierRequestId, 'purchase')
    assert.equal((await restored.db.select().from(restored.schema.inventoryApiKeys))[0].tokenHash, await restored.load('lib/inventory-management').hashInventoryToken(issued.token))
    const restoredKey = (await restored.db.select().from(restored.schema.inventoryApiKeys))[0]
    assert.equal((await restored.load('lib/inventory-management').readManagedInventoryToken(restoredKey.id)).token, issued.token)
    assert.equal((await restored.load('lib/fulfillment').fulfillPaidOrder('order')).replayed, true)
    assert.equal((await restored.db.select().from(restored.schema.userNotifications)).length, 1)
})
