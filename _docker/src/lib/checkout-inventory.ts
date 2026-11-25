import { db, dbBatchRaw } from '@/lib/db'
import { orders } from '@/lib/db/schema'
import { ensureDatabaseInitialized } from '@/lib/db/queries'
import { eq } from 'drizzle-orm'
import { RESERVATION_TTL_MS } from '@/lib/constants'
import { NEW_ORDER_ALLOWED_SQL, newOrderAllowedParams } from '@/lib/order-policy'
import { fulfillPaidOrder, invalidateInventory } from '@/lib/fulfillment'
import { scheduleInventoryEvents } from '@/lib/inventory-events'

type CheckoutInput = { orderId: string; productId: string; productName: string; price: string; shared: boolean;
    quantity: number; amount: number; points: number; userId: string; username: string | null; email: string | null; purchaseLimit: number | null; onDemand: boolean;
    trustLevel?: number; purchaseQuestions?: string | null }

export async function commitCheckoutOrder(input: CheckoutInput) {
    await ensureDatabaseInitialized()
    const now = Date.now(), cutoff = now - RESERVATION_TTL_MS, paid = input.amount <= 0
    const trustLevel = Math.max(0, typeof input.trustLevel === 'number' && Number.isFinite(input.trustLevel) ? input.trustLevel : 0)
    // Cards used for an external payment must survive the five minute payment window.
    const expiresAfter = paid ? now : now + RESERVATION_TTL_MS
    const eligible = `COALESCE(is_used, 0) = 0 AND (expires_at IS NULL OR expires_at > ?)
        AND (? = 1 OR ((reserved_at IS NULL OR reserved_at < ?)
            AND NOT EXISTS (SELECT 1 FROM orders holding WHERE holding.order_id = cards.reserved_order_id AND holding.status = 'paid')))`
    await dbBatchRaw([{
        sql: `INSERT INTO orders (order_id, product_id, product_name, amount, email, user_id, username, status,
                points_used, quantity, current_payment_id, trade_no, paid_at, created_at)
            SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            WHERE EXISTS (SELECT 1 FROM products WHERE id = ? AND COALESCE(is_active, 1) = 1
                AND price = ? AND COALESCE(is_shared, 0) = ? AND COALESCE(visibility_level, -1) <= ?
                AND COALESCE(purchase_questions, '') = ?)
            AND EXISTS (SELECT 1 FROM login_users WHERE user_id = ? AND COALESCE(is_blocked, 0) = 0 AND points >= ?)
            AND (? = 1 AND EXISTS (SELECT 1 FROM settings WHERE key = 'cards_api_mode_' || ? AND value = 'on_demand')
                AND EXISTS (SELECT 1 FROM settings WHERE key = 'cards_api_enabled_' || ? AND value = 'true')
                OR ? = 0 AND (SELECT COUNT(*) FROM cards WHERE product_id = ? AND ${eligible}) >= ?)
            AND (? IS NULL OR (SELECT COALESCE(SUM(quantity), 0) FROM orders WHERE user_id = ? AND product_id = ?
                AND status IN ('pending', 'paid', 'delivered')) + ? <= ?)
            AND ${NEW_ORDER_ALLOWED_SQL}`,
        params: [input.orderId, input.productId, input.productName, input.amount.toFixed(2), input.email, input.userId, input.username,
            paid ? 'paid' : 'pending', input.points, input.quantity, paid ? null : input.orderId, paid ? 'POINTS_REDEMPTION' : null, paid ? now : null, now,
            input.productId, input.price, Number(input.shared), trustLevel, input.purchaseQuestions || '', input.userId, input.points, Number(input.onDemand), input.productId, input.productId, Number(input.onDemand), input.productId,
            expiresAfter, Number(input.shared), cutoff, input.shared ? 1 : input.quantity,
            input.purchaseLimit, input.userId, input.productId, input.quantity, input.purchaseLimit,
            ...newOrderAllowedParams(input.userId, now)],
    }, {
        sql: 'UPDATE login_users SET points = points - ? WHERE user_id = ? AND EXISTS (SELECT 1 FROM orders WHERE order_id = ?)',
        params: [input.points, input.userId, input.orderId],
    }, {
        sql: `UPDATE cards SET reserved_order_id = ?, reserved_at = ? WHERE id IN
            (SELECT id FROM cards WHERE product_id = ? AND ${eligible}
             ORDER BY expires_at IS NULL, expires_at, id LIMIT ?)
            AND ? = 0 AND EXISTS (SELECT 1 FROM orders WHERE order_id = ?)`,
        params: [input.orderId, now, input.productId, expiresAfter, Number(input.shared), cutoff, input.quantity, Number(input.shared), input.orderId],
    }, {
        sql: `UPDATE orders SET card_ids = (SELECT group_concat(id, ',') FROM cards WHERE reserved_order_id = ?)
            WHERE order_id = ?`, params: [input.orderId, input.orderId],
    }, {
        sql: `INSERT OR IGNORE INTO inventory_events (event_id, kind, order_id, product_id, created_at)
            SELECT ?, 'payment', order_id, product_id, ? FROM orders WHERE order_id = ? AND status = 'paid'`,
        params: [`payment:${input.orderId}`, now, input.orderId],
    }])
    const order = await db.query.orders.findFirst({ where: eq(orders.orderId, input.orderId), columns: { status: true } })
    if (!order) return { success: false as const }
    if (paid) {
        // The paid order remains durable if delivery needs a later maintenance retry.
        try { await fulfillPaidOrder(input.orderId) } catch { console.error('[checkout] paid delivery deferred') }
        scheduleInventoryEvents()
    }
    invalidateInventory(input.productId)
    return { success: true as const }
}
