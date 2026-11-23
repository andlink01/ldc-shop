import { and, eq, sql } from 'drizzle-orm'
import { db, dbRun } from '@/lib/db'
import { inventoryEvents, orders } from '@/lib/db/schema'
import { getProductCardApiConfig } from '@/lib/card-api'
import { fulfillPaidOrder } from '@/lib/fulfillment'
import { procureOrderCards } from '@/lib/supplier-fulfillment'

export async function retryPaidOrderDelivery(orderId: string) {
    let result = await fulfillPaidOrder(orderId)
    if (result.delivered) return { ...result, supplierError: null }
    const order = await db.query.orders.findFirst({ where: eq(orders.orderId, orderId), columns: { productId: true, status: true, cardKey: true } })
    if (!order || order.status !== 'paid' || order.cardKey) return { ...result, supplierError: null }
    const config = await getProductCardApiConfig(order.productId)
    if (config.mode !== 'on_demand') return { ...result, supplierError: null }

    // Manual and background retries share the same task lease and result.
    // Otherwise the list can prefer an old task error over a newer manual request.
    const eventId = `supplier:${orderId}`, token = crypto.randomUUID(), now = Date.now()
    await dbRun(sql`INSERT OR IGNORE INTO inventory_events (event_id, kind, order_id, product_id, created_at)
        SELECT ${eventId}, 'supplier', order_id, product_id, ${now} FROM orders
        WHERE order_id = ${orderId} AND status = 'paid' AND COALESCE(card_key, '') = ''`)
    await dbRun(sql`UPDATE inventory_events SET lease_token = ${token}, lease_until = ${now + 300_000}
        WHERE event_id = ${eventId} AND completed_at IS NULL AND (lease_until IS NULL OR lease_until <= ${now})
        AND EXISTS (SELECT 1 FROM orders WHERE order_id = ${orderId} AND status = 'paid' AND COALESCE(card_key, '') = '')`)
    const claimed = await db.query.inventoryEvents.findFirst({ where: and(eq(inventoryEvents.eventId, eventId), eq(inventoryEvents.leaseToken, token)), columns: { eventId: true } })
    if (!claimed) {
        result = await fulfillPaidOrder(orderId)
        return { ...result, supplierError: result.delivered ? null : 'supplier_request_in_progress' }
    }
    let supplierError: string | null = 'supplier_request_failed'
    try {
        const procurement = await procureOrderCards(orderId, 1)
        result = await fulfillPaidOrder(orderId)
        supplierError = result.delivered ? null : procurement.error || 'supplier_waiting_for_cards'
    } finally {
        await db.update(inventoryEvents).set({ error: supplierError, completedAt: result.delivered ? new Date() : null,
            leaseToken: null, leaseUntil: null }).where(and(eq(inventoryEvents.eventId, eventId), eq(inventoryEvents.leaseToken, token)))
    }
    return { ...result, supplierError }
}
