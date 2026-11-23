import assert from 'node:assert/strict'
import { test } from 'node:test'
import { eq, sql } from 'drizzle-orm'
import { fixture } from './database-fixture.mjs'

async function setup(t) {
    let admin = true
    const f = fixture(t, { mocks: { '@/actions/admin': { checkAdmin: async () => { if (!admin) throw new Error('Unauthorized') } } } })
    await f.ready
    await f.db.insert(f.schema.products).values({ id: 'product', name: 'Product', price: '3' })
    await f.db.insert(f.schema.orders).values({ orderId: 'recovery', productId: 'product', productName: 'Product', amount: '3', status: 'paid' })
    const api = f.load('lib/card-api')
    await api.saveProductCardApiConfig('product', { mode: 'on_demand', enabled: true, url: 'https://new.example/cards', token: 'ISOLATED-SUPPLIER-TOKEN' })
    await f.db.insert(f.schema.supplierRequests).values({ requestId: 'preserved-id', orderId: 'recovery', itemIndex: 0,
        serverUrl: 'https://old.example/cards', createdAt: new Date(), attempts: 2, error: 'supplier_http_401' })
    await f.db.update(f.schema.inventoryEvents).set({ error: 'supplier_endpoint_changed', nextAttemptAt: new Date(Date.now() + 3_600_000) })
        .where(eq(f.schema.inventoryEvents.eventId, 'supplier:recovery'))
    return { ...f, api, recovery: f.load('lib/supplier-recovery'), actions: f.load('actions/inventory'), setAdmin(value) { admin = value } }
}

test('confirmed recovery preserves the purchase ID, uses the current product token and delivers once', async t => {
    const f = await setup(t)
    const preview = await f.actions.getSupplierRecoveryInfo('recovery')
    assert.equal(preview.success, true)
    assert.equal(preview.info.currentUrl, 'https://new.example/cards')
    assert.deepEqual(Array.from(preview.info.requestIds), ['preserved-id'])
    assert.ok(!JSON.stringify(preview).includes('ISOLATED-SUPPLIER-TOKEN'))
    let calls = 0
    f.setFetch(async (url, options) => {
        calls++
        assert.equal(url, preview.info.currentUrl)
        assert.equal(options.headers.Authorization, 'Bearer ISOLATED-SUPPLIER-TOKEN')
        assert.equal(JSON.parse(options.body).requestId, 'preserved-id')
        assert.equal(options.headers['Idempotency-Key'], 'preserved-id')
        return Response.json({ success: true, requestId: 'preserved-id', data: { cardKey: 'RECOVERY-CARD' } })
    })
    const result = await f.actions.resumeSupplierOrder('recovery', preview.info.currentUrl, true)
    assert.equal(result.success, true)
    assert.equal(result.delivered, true)
    assert.equal(calls, 1)
    const request = await f.db.query.supplierRequests.findFirst()
    assert.equal(request.requestId, 'preserved-id')
    assert.equal(request.state, 'received')
    const audit = await f.db.query.inventoryEvents.findFirst({ where: eq(f.schema.inventoryEvents.kind, 'supplier_recovery') })
    assert.ok(audit.completedAt)
    assert.ok(audit.data.includes('https://old.example/cards'))
    assert.ok(!audit.data.includes('ISOLATED-SUPPLIER-TOKEN'))
    assert.equal((await f.load('lib/admin-fulfillment').getPendingDeliveryOrders()).total, 0)
    assert.equal((await f.actions.resumeSupplierOrder('recovery', preview.info.currentUrl, true)).success, false)
    assert.equal(calls, 1)
})

test('unconfirmed, unauthorized or stale recovery cannot modify requests or call the supplier', async t => {
    const f = await setup(t)
    f.setFetch(() => assert.fail('Rejected recovery must not call a supplier'))
    assert.equal((await f.actions.resumeSupplierOrder('recovery', 'https://new.example/cards', false)).error, 'inventory.recovery.confirmationRequired')
    f.setAdmin(false)
    await assert.rejects(f.actions.getSupplierRecoveryInfo('recovery'), /Unauthorized/)
    await assert.rejects(f.actions.resumeSupplierOrder('recovery', 'https://new.example/cards', true), /Unauthorized/)
    f.setAdmin(true)
    const preview = await f.actions.getSupplierRecoveryInfo('recovery')
    await f.api.saveProductCardApiConfig('product', { mode: 'on_demand', enabled: true, url: 'https://changed.example/cards', token: '' })
    assert.equal((await f.actions.resumeSupplierOrder('recovery', preview.info.currentUrl, true)).error, 'inventory.recovery.stateChanged')
    const request = await f.db.query.supplierRequests.findFirst()
    assert.equal(request.serverUrl, 'https://old.example/cards')
    assert.equal(request.requestId, 'preserved-id')
    assert.equal((await f.db.select().from(f.schema.inventoryEvents).where(eq(f.schema.inventoryEvents.kind, 'supplier_recovery'))).length, 0)
})

test('active task and request leases block address recovery, and refunded orders cannot be recovered', async t => {
    const f = await setup(t)
    const until = new Date(Date.now() + 60_000)
    await f.db.update(f.schema.supplierRequests).set({ leaseUntil: until, leaseToken: 'active' })
    assert.equal((await f.actions.resumeSupplierOrder('recovery', 'https://new.example/cards', true)).error, 'inventory.recovery.busy')
    await f.db.update(f.schema.supplierRequests).set({ leaseUntil: null, leaseToken: null })
    await f.db.update(f.schema.inventoryEvents).set({ leaseUntil: until, leaseToken: 'background' }).where(eq(f.schema.inventoryEvents.eventId, 'supplier:recovery'))
    assert.equal((await f.actions.resumeSupplierOrder('recovery', 'https://new.example/cards', true)).error, 'inventory.recovery.busy')
    await f.db.update(f.schema.inventoryEvents).set({ leaseUntil: null, leaseToken: null }).where(eq(f.schema.inventoryEvents.eventId, 'supplier:recovery'))
    await f.load('lib/order-transitions').refundOrderInventory('recovery', true)
    assert.equal((await f.actions.resumeSupplierOrder('recovery', 'https://new.example/cards', true)).error, 'inventory.recovery.stateChanged')
    assert.equal((await f.load('lib/admin-fulfillment').getPendingDeliveryOrders()).total, 0)
})

test('address recovery updates only pending requests on the selected order and preserves partial receipts', async t => {
    const f = await setup(t)
    await f.db.update(f.schema.orders).set({ quantity: 2 }).where(eq(f.schema.orders.orderId, 'recovery'))
    await f.db.update(f.schema.supplierRequests).set({ itemIndex: 1 })
    await f.db.insert(f.schema.supplierRequests).values({ requestId: 'received-id', orderId: 'recovery', itemIndex: 0,
        serverUrl: 'https://old.example/cards', state: 'received', createdAt: new Date() })
    await f.db.insert(f.schema.cards).values({ productId: 'product', cardKey: 'EXISTING-PARTIAL-CARD', supplierRequestId: 'received-id',
        reservedOrderId: 'recovery', reservedAt: new Date() })
    await f.db.insert(f.schema.orders).values({ orderId: 'other', productId: 'product', productName: 'Other', amount: '3', status: 'paid' })
    await f.db.insert(f.schema.supplierRequests).values({ requestId: 'other-id', orderId: 'other', itemIndex: 0,
        serverUrl: 'https://old.example/cards', createdAt: new Date() })
    let purchases = 0
    f.setFetch(async (_, options) => {
        purchases++
        assert.equal(JSON.parse(options.body).requestId, 'preserved-id')
        return Response.json({ success: true, requestId: 'preserved-id', data: { cardKey: 'NEW-PARTIAL-CARD' } })
    })
    assert.equal((await f.actions.resumeSupplierOrder('recovery', 'https://new.example/cards', true)).delivered, true)
    const rows = await f.db.select().from(f.schema.supplierRequests)
    assert.equal(rows.find(row => row.requestId === 'preserved-id').serverUrl, 'https://new.example/cards')
    assert.equal(rows.find(row => row.requestId === 'preserved-id').attempts, 3)
    assert.equal(rows.find(row => row.requestId === 'received-id').serverUrl, 'https://old.example/cards')
    assert.equal(rows.find(row => row.requestId === 'other-id').serverUrl, 'https://old.example/cards')
    assert.equal(purchases, 1)
    const order = await f.db.query.orders.findFirst({ where: eq(f.schema.orders.orderId, 'recovery') })
    assert.ok(order.cardKey.includes('EXISTING-PARTIAL-CARD'))
    assert.ok(order.cardKey.includes('NEW-PARTIAL-CARD'))
})

test('a failed address update rolls back the audit and request changes and returns a readable error', async t => {
    const f = await setup(t)
    await f.db.run(sql`CREATE TRIGGER reject_recovery BEFORE UPDATE OF server_url ON supplier_requests BEGIN SELECT RAISE(ABORT, 'isolated recovery failure'); END`)
    const result = await f.actions.resumeSupplierOrder('recovery', 'https://new.example/cards', true)
    assert.equal(result.error, 'inventory.recovery.saveFailed')
    assert.equal((await f.db.query.supplierRequests.findFirst()).serverUrl, 'https://old.example/cards')
    assert.equal((await f.db.select().from(f.schema.inventoryEvents).where(eq(f.schema.inventoryEvents.kind, 'supplier_recovery'))).length, 0)
})

test('a background task claiming work after preview prevents the address transaction from overwriting its lease', async t => {
    const f = await setup(t)
    const driver = f.load('lib/db')
    const original = driver.dbBatchRaw
    driver.dbBatchRaw = async statements => {
        if (statements[0].sql.includes("'supplier_recovery'")) {
            await f.db.update(f.schema.inventoryEvents).set({ leaseToken: 'parallel-worker', leaseUntil: new Date(Date.now() + 60_000) })
                .where(eq(f.schema.inventoryEvents.eventId, 'supplier:recovery'))
        }
        return original(statements)
    }
    assert.equal((await f.actions.resumeSupplierOrder('recovery', 'https://new.example/cards', true)).error, 'inventory.recovery.stateChanged')
    assert.equal((await f.db.query.supplierRequests.findFirst()).serverUrl, 'https://old.example/cards')
    const task = await f.db.query.inventoryEvents.findFirst({ where: eq(f.schema.inventoryEvents.eventId, 'supplier:recovery') })
    assert.equal(task.leaseToken, 'parallel-worker')
    assert.equal((await f.db.select().from(f.schema.inventoryEvents).where(eq(f.schema.inventoryEvents.kind, 'supplier_recovery'))).length, 0)
})
