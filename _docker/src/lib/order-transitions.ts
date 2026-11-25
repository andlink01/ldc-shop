import { db, dbBatchRaw } from '@/lib/db'
import { orders } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { ensureDatabaseInitialized } from '@/lib/db/queries'

export async function cancelPendingOrder(orderId: string, createdBefore: number | null = null) {
    await ensureDatabaseInitialized()
    const token = crypto.randomUUID(), now = Date.now()
    await dbBatchRaw([{
        sql: `INSERT OR IGNORE INTO inventory_events (event_id, kind, order_id, lease_token, completed_at, created_at)
            SELECT ?, 'points_returned', order_id, ?, ?, ? FROM orders WHERE order_id = ? AND status = 'pending'
            AND (? IS NULL OR created_at < ?)`,
        params: [`points-returned:${orderId}`, token, now, now, orderId, createdBefore, createdBefore],
    }, {
        sql: `UPDATE login_users SET points = points + COALESCE((SELECT points_used FROM orders WHERE order_id = ?), 0)
            WHERE user_id = (SELECT user_id FROM orders WHERE order_id = ?) AND EXISTS
            (SELECT 1 FROM inventory_events WHERE event_id = ? AND lease_token = ?)`,
        params: [orderId, orderId, `points-returned:${orderId}`, token],
    }, {
        sql: "UPDATE orders SET status = 'cancelled' WHERE order_id = ? AND status = 'pending' AND (? IS NULL OR created_at < ?)",
        params: [orderId, createdBefore, createdBefore],
    }, {
        sql: `UPDATE cards SET reserved_order_id = NULL, reserved_at = NULL WHERE reserved_order_id = ? AND COALESCE(is_used, 0) = 0
            AND EXISTS (SELECT 1 FROM orders WHERE order_id = ? AND status = 'cancelled')`, params: [orderId, orderId],
    }])
    const current = await db.query.orders.findFirst({ where: eq(orders.orderId, orderId), columns: { status: true } })
    return current?.status === 'cancelled'
}

export async function refundOrderInventory(orderId: string, reclaim: boolean, requireNoActiveRefund = false) {
    await ensureDatabaseInitialized()
    const token = crypto.randomUUID(), now = Date.now(), eventId = `refund:${orderId}`
    await dbBatchRaw([{
        sql: `INSERT OR IGNORE INTO inventory_events (event_id, kind, order_id, lease_token, completed_at, created_at)
            SELECT ?, 'refund', order_id, ?, ?, ? FROM orders WHERE order_id = ? AND status IN ('paid', 'delivered')
            AND (? = 0 OR NOT EXISTS (SELECT 1 FROM inventory_events WHERE order_id = orders.order_id AND kind = 'refund_request' AND lease_until > ?))`,
        params: [eventId, token, now, now, orderId, Number(requireNoActiveRefund), now],
    }, {
        sql: `UPDATE login_users SET points = points + COALESCE((SELECT points_used FROM orders WHERE order_id = ?), 0)
            WHERE user_id = (SELECT user_id FROM orders WHERE order_id = ?) AND EXISTS
            (SELECT 1 FROM inventory_events WHERE event_id = ? AND lease_token = ?)`,
        params: [orderId, orderId, eventId, token],
    }, {
        sql: `UPDATE orders SET status = 'refunded' WHERE order_id = ? AND EXISTS
            (SELECT 1 FROM inventory_events WHERE event_id = ? AND lease_token = ?)`, params: [orderId, eventId, token],
    }, {
        // Read the final delivered card IDs inside the transaction, including a concurrent fulfillment that won first.
        sql: `UPDATE cards SET is_used = 0, used_at = NULL, reserved_order_id = NULL, reserved_at = NULL
            WHERE EXISTS (SELECT 1 FROM orders refunded JOIN products p ON p.id = refunded.product_id
                WHERE refunded.order_id = ? AND refunded.status = 'refunded' AND COALESCE(p.is_shared, 0) = 0
                AND refunded.product_id = cards.product_id AND
                ((? = 1 AND COALESCE(cards.is_used, 0) = 1 AND cards.used_at = refunded.delivered_at
                    AND instr(',' || COALESCE(refunded.card_ids, '') || ',', ',' || cards.id || ',') > 0)
                 OR (COALESCE(cards.is_used, 0) = 0 AND cards.reserved_order_id = refunded.order_id)))
            AND EXISTS (SELECT 1 FROM inventory_events WHERE event_id = ? AND lease_token = ?)`,
        params: [orderId, Number(reclaim), eventId, token],
    }, {
        sql: `UPDATE refund_requests SET status = 'processed', processed_at = ?, updated_at = ? WHERE order_id = ?
            AND EXISTS (SELECT 1 FROM orders WHERE order_id = ? AND status = 'refunded')`, params: [now, now, orderId, orderId],
    }])
    if (requireNoActiveRefund) {
        const order = await db.query.orders.findFirst({ where: eq(orders.orderId, orderId), columns: { status: true } })
        if (order?.status !== 'refunded') throw new Error('Payment refund is still in progress; wait before recording an external refund')
    }
}

export async function deleteOrderInventory(orderId: string) {
    await ensureDatabaseInitialized()
    const token = crypto.randomUUID(), eventId = `delete:${orderId}:${token}`, now = Date.now()
    const allowed = `EXISTS (SELECT 1 FROM inventory_events WHERE event_id = ? AND lease_token = ?)`
    await dbBatchRaw([{
        // Take the deletion permission in the same transaction as every destructive change.
        sql: `INSERT INTO inventory_events (event_id, kind, order_id, lease_token, completed_at, created_at)
            SELECT ?, 'order_delete', order_id, ?, ?, ? FROM orders WHERE order_id = ?
            AND (status != 'paid' OR product_id = 'payment_link')
            AND NOT EXISTS (SELECT 1 FROM inventory_events r WHERE r.order_id = orders.order_id AND r.kind = 'refund_request'
                AND (r.lease_until > ? OR (orders.status != 'refunded' AND
                    CASE WHEN json_valid(r.data) = 1 THEN COALESCE(json_extract(r.data, '$.state'), '') ELSE 'unknown' END NOT IN ('ready', 'retryable'))))
            AND NOT EXISTS (SELECT 1 FROM supplier_requests s WHERE s.order_id = orders.order_id AND s.state = 'pending')
            AND NOT EXISTS (SELECT 1 FROM refund_requests r WHERE r.order_id = orders.order_id AND COALESCE(r.status, 'pending') IN ('pending', 'approved'))
            AND NOT EXISTS (SELECT 1 FROM inventory_events p WHERE p.order_id = orders.order_id AND p.kind = 'payment_conflict')`,
        params: [eventId, token, now, now, orderId, now],
    }, {
        // Only pending orders still hold a point deduction. Completed, cancelled and refunded orders must not credit it again.
        sql: `UPDATE login_users SET points = points + COALESCE((SELECT points_used FROM orders WHERE order_id = ? AND status = 'pending'), 0)
            WHERE user_id = (SELECT user_id FROM orders WHERE order_id = ? AND status = 'pending') AND ${allowed}`,
        params: [orderId, orderId, eventId, token],
    }, {
        sql: `UPDATE cards SET reserved_order_id = NULL, reserved_at = NULL WHERE reserved_order_id = ? AND COALESCE(is_used, 0) = 0 AND ${allowed}`,
        params: [orderId, eventId, token],
    }, { sql: `DELETE FROM refund_requests WHERE order_id = ? AND ${allowed}`, params: [orderId, eventId, token] },
    { sql: `DELETE FROM orders WHERE order_id = ? AND ${allowed}`, params: [orderId, eventId, token] }])
    const remaining = await db.query.orders.findFirst({ where: eq(orders.orderId, orderId), columns: { orderId: true } })
    if (remaining) throw new Error('Cannot delete an order awaiting delivery or payment/supplier verification')
}
