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
    await dbBatchRaw([{
        sql: `UPDATE login_users SET points = points - COALESCE((SELECT points_used FROM orders WHERE order_id = ?), 0)
            WHERE user_id = (SELECT user_id FROM orders WHERE order_id = ? AND status = 'cancelled')
            AND EXISTS (SELECT 1 FROM inventory_events WHERE event_id = ?)`,
        params: [orderId, orderId, `points-returned:${orderId}`],
    }, {
        sql: "DELETE FROM inventory_events WHERE event_id = ? AND EXISTS (SELECT 1 FROM orders WHERE order_id = ? AND status = 'cancelled')",
        params: [`points-returned:${orderId}`, orderId],
    }, {
        sql: `UPDATE orders SET status = 'paid', paid_at = ?, trade_no = ?, current_payment_id = COALESCE(?, current_payment_id)
            WHERE order_id = ? AND status IN ('pending', 'cancelled')`,
        params: [now, tradeNo, isPaymentIdOf(orderId, paymentId) ? paymentId : null, orderId],
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
        // Two retry links can both be paid. Keep the winning payment and delivery, and record the extra charge.
        sql: `INSERT OR IGNORE INTO inventory_events (event_id, kind, order_id, product_id, data, created_at)
            SELECT ?, 'payment_conflict', order_id, product_id,
                json_object('orderId', order_id, 'tradeNo', ?, 'originalTradeNo', trade_no, 'amount', ?, 'paymentId', ?), ?
            FROM orders WHERE order_id = ? AND status IN ('paid', 'delivered', 'refunded') AND COALESCE(trade_no, '') != ?`,
        params: [`payment-conflict:${orderId}:${tradeNo}`, tradeNo, (paidCents / 100).toFixed(2), paymentId ?? null, now, orderId, tradeNo],
    }])
    const saved = await db.query.orders.findFirst({ where: eq(orders.orderId, orderId), columns: { status: true } })
    if (!saved) throw new Error('Order not found')
    if (!isPaymentOrder(order.productId)) {
        try { await fulfillPaidOrder(orderId) } catch { console.error('[payment] paid delivery deferred to maintenance') }
    }
    invalidateInventory(order.productId)
    scheduleInventoryEvents()
    return { success: true, status: order.status === 'delivered' ? 'already_processed' : 'processed' }
}
