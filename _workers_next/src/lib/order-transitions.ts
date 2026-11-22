import { dbBatchRaw } from '@/lib/db'
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
}

export async function refundOrderInventory(orderId: string, reclaim: boolean) {
    await ensureDatabaseInitialized()
    const token = crypto.randomUUID(), now = Date.now(), eventId = `refund:${orderId}`
    await dbBatchRaw([{
        sql: `INSERT OR IGNORE INTO inventory_events (event_id, kind, order_id, lease_token, completed_at, created_at)
            SELECT ?, 'refund', order_id, ?, ?, ? FROM orders WHERE order_id = ? AND status IN ('paid', 'delivered')`,
        params: [eventId, token, now, now, orderId],
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
}
