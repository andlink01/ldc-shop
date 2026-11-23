import { and, eq } from 'drizzle-orm'
import { db, dbBatchRaw } from '@/lib/db'
import { inventoryEvents, orders, products, supplierRequests } from '@/lib/db/schema'
import { ensureDatabaseInitialized } from '@/lib/db/queries'
import { getProductCardApiConfig } from '@/lib/card-api'
import { validateCardApiConfig } from '@/lib/card-api-validation'

const fail = (code: string) => ({ success: false as const, error: `inventory.recovery.${code}` })

async function recoveryContext(orderId: string) {
    if (typeof orderId !== 'string' || !orderId || orderId.length > 200) return fail('stateChanged')
    await ensureDatabaseInitialized()
    const order = await db.query.orders.findFirst({ where: eq(orders.orderId, orderId) })
    if (!order || order.status !== 'paid' || order.cardKey) return fail('stateChanged')
    const product = await db.query.products.findFirst({ where: eq(products.id, order.productId), columns: { isShared: true } })
    const config = await getProductCardApiConfig(order.productId)
    if (!product || product.isShared || config.mode !== 'on_demand' || !config.enabled || !config.url
        || validateCardApiConfig(config)) return fail('configRequired')
    const pending = await db.select({ requestId: supplierRequests.requestId, serverUrl: supplierRequests.serverUrl,
        leaseUntil: supplierRequests.leaseUntil }).from(supplierRequests)
        .where(and(eq(supplierRequests.orderId, orderId), eq(supplierRequests.state, 'pending')))
    const currentUrl = new URL(config.url).toString()
    if (!pending.length || pending.every(request => request.serverUrl === currentUrl)) return fail('noChange')
    const task = await db.query.inventoryEvents.findFirst({ where: eq(inventoryEvents.eventId, `supplier:${orderId}`),
        columns: { leaseUntil: true } })
    if (Number(task?.leaseUntil) > Date.now() || pending.some(request => Number(request.leaseUntil) > Date.now())) return fail('busy')
    return { success: true as const, order, config, pending, currentUrl }
}

export async function readSupplierRecovery(orderId: string) {
    const context = await recoveryContext(orderId)
    if (!context.success) return context
    return { success: true as const, info: { orderId, currentUrl: context.currentUrl,
        previousUrls: [...new Set(context.pending.map(request => request.serverUrl))],
        requestIds: context.pending.map(request => request.requestId) } }
}

export type SupplierRecoveryInfo = Extract<Awaited<ReturnType<typeof readSupplierRecovery>>, { success: true }>['info']

export async function updateSupplierRecovery(orderId: string, expectedUrl: string, confirmed: boolean) {
    if (confirmed !== true) return fail('confirmationRequired')
    const context = await recoveryContext(orderId)
    if (!context.success) return context
    if (expectedUrl !== context.currentUrl) return fail('stateChanged')
    const now = Date.now(), eventId = `supplier-recovery:${crypto.randomUUID()}`
    const snapshot = JSON.stringify(context.pending.map(({ requestId, serverUrl }) => ({ requestId, serverUrl })))
    // The audit row is a transaction marker. If the order, configuration, requests
    // or leases change, no marker is inserted and none of the subsequent writes run.
    await dbBatchRaw([{
        sql: `INSERT INTO inventory_events (event_id, kind, order_id, product_id, data, completed_at, created_at)
            SELECT ?, 'supplier_recovery', o.order_id, o.product_id, ?, ?, ? FROM orders o
            WHERE o.order_id = ? AND o.status = 'paid' AND COALESCE(o.card_key, '') = ''
            AND EXISTS (SELECT 1 FROM products p WHERE p.id = o.product_id AND COALESCE(p.is_shared, 0) = 0)
            AND EXISTS (SELECT 1 FROM settings WHERE key = 'cards_api_mode_' || o.product_id AND value = 'on_demand')
            AND EXISTS (SELECT 1 FROM settings WHERE key = 'cards_api_enabled_' || o.product_id AND value = 'true')
            AND EXISTS (SELECT 1 FROM settings WHERE key = 'cards_api_url_' || o.product_id AND trim(value) = ?)
            AND NOT EXISTS (SELECT 1 FROM inventory_events WHERE order_id = o.order_id AND kind = 'supplier' AND lease_until > ?)
            AND NOT EXISTS (SELECT 1 FROM supplier_requests WHERE order_id = o.order_id AND state = 'pending' AND lease_until > ?)
            AND (SELECT count(*) FROM supplier_requests WHERE order_id = o.order_id AND state = 'pending') = ?
            AND NOT EXISTS (SELECT 1 FROM supplier_requests r WHERE r.order_id = o.order_id AND r.state = 'pending'
                AND NOT EXISTS (SELECT 1 FROM json_each(?) snapshot
                    WHERE json_extract(snapshot.value, '$.requestId') = r.request_id AND json_extract(snapshot.value, '$.serverUrl') = r.server_url))`,
        params: [eventId, JSON.stringify({ previousRequests: JSON.parse(snapshot), currentUrl: context.currentUrl, confirmed: true }),
            now, now, orderId, context.config.url, now, now, context.pending.length, snapshot],
    }, {
        sql: `UPDATE supplier_requests SET server_url = ?, error = NULL, lease_token = NULL, lease_until = NULL
            WHERE order_id = ? AND state = 'pending' AND EXISTS (SELECT 1 FROM inventory_events WHERE event_id = ?)`,
        params: [context.currentUrl, orderId, eventId],
    }, {
        sql: `INSERT OR IGNORE INTO inventory_events (event_id, kind, order_id, product_id, created_at)
            SELECT ?, 'supplier', order_id, product_id, ? FROM orders
            WHERE order_id = ? AND EXISTS (SELECT 1 FROM inventory_events WHERE event_id = ?)`,
        params: [`supplier:${orderId}`, now, orderId, eventId],
    }, {
        sql: `UPDATE inventory_events SET error = NULL, completed_at = NULL, next_attempt_at = 0, lease_token = NULL, lease_until = NULL
            WHERE event_id = ? AND EXISTS (SELECT 1 FROM inventory_events WHERE event_id = ?)`,
        params: [`supplier:${orderId}`, eventId],
    }])
    const audit = await db.query.inventoryEvents.findFirst({ where: eq(inventoryEvents.eventId, eventId), columns: { eventId: true } })
    return audit ? { success: true as const } : fail('stateChanged')
}
