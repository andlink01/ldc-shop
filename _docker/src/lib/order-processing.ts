import { db, dbBatchRaw } from '@/lib/db'
import { orders } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { isPaymentOrder } from '@/lib/payment'
import { ensureDatabaseInitialized } from '@/lib/db/queries'
import { fulfillPaidOrder, invalidateInventory } from '@/lib/fulfillment'
import { scheduleInventoryEvents } from '@/lib/inventory-events'
import { isPaymentIdOf } from '@/lib/epay'

/** `paymentId` is the merchant order number the payment was made under; status checks and refund verification need it later. */
export async function processOrderFulfillment(orderId: string, paidAmount: number, tradeNo: string, paymentId?: string) {
    await ensureDatabaseInitialized()
    const order = await db.query.orders.findFirst({ where: eq(orders.orderId, orderId) })
    if (!order) throw new Error('Order not found')
    const amount = Number(order.amount)
    if (!Number.isFinite(amount) || !Number.isFinite(paidAmount) || amount < 0 || paidAmount < 0
        || Math.round(amount * 100) !== Math.round(paidAmount * 100)) throw new Error('Payment amount mismatch')
    if (!tradeNo || tradeNo.length > 200) throw new Error('Invalid trade number')
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
        sql: `INSERT OR IGNORE INTO inventory_events (event_id, kind, order_id, product_id, created_at)
            SELECT ?, 'payment', order_id, product_id, ? FROM orders
            WHERE order_id = ? AND status IN ('paid', 'delivered') AND trade_no = ?`,
        params: [`payment:${orderId}`, now, orderId, tradeNo],
    }])
    if (!isPaymentOrder(order.productId)) {
        try { await fulfillPaidOrder(orderId) } catch { console.error('[payment] paid delivery deferred to maintenance') }
    }
    invalidateInventory(order.productId)
    scheduleInventoryEvents()
    return { success: true, status: order.status === 'delivered' ? 'already_processed' : 'processed' }
}
