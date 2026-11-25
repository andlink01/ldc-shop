import { db, dbBatchRaw } from '@/lib/db'
import { orders } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { isPaymentOrder } from '@/lib/payment'
import { ensureDatabaseInitialized } from '@/lib/db/queries'
import { fulfillPaidOrder, invalidateInventory } from '@/lib/fulfillment'
import { scheduleInventoryEvents } from '@/lib/inventory-events'
import { isPaymentIdOf } from '@/lib/epay'
import { moneyCents } from '@/lib/order-policy'

/** `paymentId` is the merchant order number the payment was made under; status checks and refund verification need it later. */
export async function processOrderFulfillment(orderId: string, paidAmount: number, tradeNo: string, paymentId?: string) {
    await ensureDatabaseInitialized()
    const order = await db.query.orders.findFirst({ where: eq(orders.orderId, orderId) })
    if (!order) throw new Error('Order not found')
    const cents = moneyCents(order.amount), paidCents = moneyCents(paidAmount)
    if (cents === null || paidCents === null || cents !== paidCents) throw new Error('Payment amount mismatch')
    if (typeof tradeNo !== 'string' || !tradeNo.trim() || tradeNo.length > 200) throw new Error('Invalid trade number')
    const now = Date.now()
    const claimToken = crypto.randomUUID()
    const returnedEventId = `points-returned:${orderId}`
    const conflictEventId = `payment-conflict:${orderId}:${tradeNo}`
    const amountText = (paidCents / 100).toFixed(2)
    await dbBatchRaw([{
        sql: `UPDATE inventory_events SET lease_token = ?
            WHERE event_id = ?
            AND EXISTS (
                SELECT 1 FROM orders o
                LEFT JOIN login_users u ON u.user_id = o.user_id
                WHERE o.order_id = ? AND o.status = 'cancelled'
                AND (COALESCE(o.points_used, 0) <= 0 OR COALESCE(u.points, 0) >= o.points_used)
            )`,
        params: [claimToken, returnedEventId, orderId],
    }, {
        sql: `UPDATE login_users SET points = points - COALESCE((SELECT points_used FROM orders WHERE order_id = ?), 0)
            WHERE user_id = (SELECT user_id FROM orders WHERE order_id = ? AND status = 'cancelled')
            AND COALESCE((SELECT points_used FROM orders WHERE order_id = ?), 0) > 0
            AND EXISTS (SELECT 1 FROM inventory_events WHERE event_id = ? AND lease_token = ?)`,
        params: [orderId, orderId, orderId, returnedEventId, claimToken],
    }, {
        sql: `UPDATE orders SET status = 'paid', paid_at = ?, trade_no = ?, current_payment_id = COALESCE(?, current_payment_id)
            WHERE order_id = ?
            AND (
                status = 'pending'
                OR (
                    status = 'cancelled'
                    AND (
                        NOT EXISTS (SELECT 1 FROM inventory_events WHERE event_id = ?)
                        OR EXISTS (SELECT 1 FROM inventory_events WHERE event_id = ? AND lease_token = ?)
                    )
                )
            )`,
        params: [now, tradeNo, isPaymentIdOf(orderId, paymentId) ? paymentId : null, orderId, returnedEventId, returnedEventId, claimToken],
    }, {
        sql: `DELETE FROM inventory_events
            WHERE event_id = ? AND lease_token = ?
            AND EXISTS (SELECT 1 FROM orders WHERE order_id = ? AND status IN ('paid', 'delivered'))`,
        params: [returnedEventId, claimToken, orderId],
    }, {
        // A manual paid/delivered order can receive its first signed gateway transaction later.
        sql: `UPDATE orders SET trade_no = ?, current_payment_id = COALESCE(?, current_payment_id)
            WHERE order_id = ? AND status IN ('paid', 'delivered') AND COALESCE(trade_no, '') = ''`,
        params: [tradeNo, isPaymentIdOf(orderId, paymentId) ? paymentId : null, orderId],
    }, {
        sql: `INSERT OR IGNORE INTO inventory_events (event_id, kind, order_id, product_id, created_at)
            SELECT ?, 'payment', order_id, product_id, ? FROM orders
            WHERE order_id = ? AND status IN ('paid', 'delivered') AND trade_no = ?`,
        params: [`payment:${orderId}`, now, orderId, tradeNo],
    }, {
        // Two retry links can both be paid, or a cancelled order whose returned points were already spent can be paid late.
        sql: `INSERT OR IGNORE INTO inventory_events (event_id, kind, order_id, product_id, data, created_at)
            SELECT ?, 'payment_conflict', order_id, product_id,
                json_object('orderId', order_id, 'tradeNo', ?, 'originalTradeNo', trade_no, 'amount', ?, 'paymentId', ?), ?
            FROM orders WHERE order_id = ? AND (
                (status IN ('paid', 'delivered', 'refunded') AND COALESCE(trade_no, '') != ?)
                OR status = 'cancelled'
            )`,
        params: [conflictEventId, tradeNo, amountText, paymentId ?? null, now, orderId, tradeNo],
    }, {
        sql: `UPDATE products SET sold_count = COALESCE((SELECT SUM(quantity) FROM orders
            WHERE product_id = products.id AND status IN ('paid', 'delivered')), 0)
            WHERE id = (SELECT product_id FROM orders WHERE order_id = ?)`,
        params: [orderId],
    }])
    const saved = await db.query.orders.findFirst({ where: eq(orders.orderId, orderId), columns: { status: true } })
    if (!saved) throw new Error('Order not found')
    if (saved.status !== 'cancelled' && !isPaymentOrder(order.productId)) {
        try { await fulfillPaidOrder(orderId) } catch { console.error('[payment] paid delivery deferred to maintenance') }
    }
    invalidateInventory(order.productId)
    scheduleInventoryEvents()
    return {
        success: true,
        status: saved.status === 'cancelled'
            ? 'points_insufficient'
            : (order.status === 'delivered' ? 'already_processed' : 'processed'),
    }
}
