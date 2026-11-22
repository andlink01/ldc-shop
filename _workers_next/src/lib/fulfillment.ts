import { db, dbRun, dbBatchRaw } from '@/lib/db'
import { cards, orders, products } from '@/lib/db/schema'
import { ensureDatabaseInitialized, recalcProductAggregates } from '@/lib/db/queries'
import { and, asc, eq, gt, isNull, or, sql } from 'drizzle-orm'
import { RESERVATION_TTL_MS } from '@/lib/constants'
import { PAYMENT_PRODUCT_ID } from '@/lib/payment'
import type { SqlStatement } from '@/lib/db/contracts'
import { revalidatePath, revalidateTag } from 'next/cache'

export function invalidateInventory(productId: string) {
    try {
        for (const path of ['/', '/search', '/admin/products', '/admin/orders', '/admin/fulfillment', `/buy/${productId}`, `/admin/cards/${productId}`]) revalidatePath(path)
        revalidateTag('home:products', { expire: 0 })
        revalidateTag('home:product-categories', { expire: 0 })
    } catch { /* A background task can run without a page cache context. */ }
}

export async function queuePaymentNotification(orderId: string) {
    await dbRun(sql`INSERT OR IGNORE INTO inventory_events (event_id, kind, order_id, product_id, created_at)
        SELECT ${`payment:${orderId}`}, 'payment', order_id, product_id, ${Date.now()}
        FROM orders WHERE order_id = ${orderId} AND status IN ('paid', 'delivered')`)
}

export async function fulfillPaidOrder(orderId: string): Promise<{ delivered: boolean; replayed: boolean; reason?: string }> {
    await ensureDatabaseInitialized()
    for (let attempt = 0; attempt < 3; attempt++) {
        const order = await db.query.orders.findFirst({ where: eq(orders.orderId, orderId) })
        if (!order) return { delivered: false, replayed: false, reason: 'order_not_found' }
        if (order.status === 'delivered') return { delivered: true, replayed: true }
        if (order.status !== 'paid' || order.cardKey) return { delivered: false, replayed: false, reason: 'not_waiting_for_stock' }
        const quantity = order.quantity || 1
        if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 10000) return { delivered: false, replayed: false, reason: 'invalid_quantity' }
        const product = await db.query.products.findFirst({ where: eq(products.id, order.productId), columns: { isShared: true } })
        if (!product) return { delivered: false, replayed: false, reason: 'product_not_found' }
        const now = Date.now(), cutoff = now - RESERVATION_TTL_MS
        const shared = Boolean(product.isShared)
        const selected = await db.select({ id: cards.id, cardKey: cards.cardKey }).from(cards).where(and(
            eq(cards.productId, order.productId), or(eq(cards.isUsed, false), isNull(cards.isUsed)),
            or(isNull(cards.expiresAt), gt(cards.expiresAt, new Date(now))),
            shared ? undefined : sql`(${cards.reservedOrderId} = ${orderId} OR
                ((${cards.reservedAt} IS NULL OR ${cards.reservedAt} < ${cutoff})
                AND NOT EXISTS (SELECT 1 FROM orders holding WHERE holding.order_id = ${cards.reservedOrderId} AND holding.status = 'paid')))`,
        )).orderBy(
            // Keep the buyer's reservation, then issue the earliest expiring stock first.
            sql`CASE WHEN ${cards.reservedOrderId} = ${orderId} THEN 0 ELSE 1 END`,
            sql`${cards.expiresAt} IS NULL`, asc(cards.expiresAt), asc(cards.id),
        ).limit(shared ? 1 : quantity)
        if (selected.length < (shared ? 1 : quantity)) {
            await dbRun(sql`INSERT OR IGNORE INTO inventory_events (event_id, kind, order_id, product_id, created_at)
                SELECT ${`supplier:${orderId}`}, 'supplier', order_id, product_id, ${Date.now()} FROM orders
                WHERE order_id = ${orderId} AND status = 'paid' AND COALESCE(card_key, '') = ''
                AND EXISTS (SELECT 1 FROM settings WHERE key = 'cards_api_mode_' || orders.product_id AND value = 'on_demand')
                AND EXISTS (SELECT 1 FROM settings WHERE key = 'cards_api_enabled_' || orders.product_id AND value = 'true')`)
            // Keep partial stock reserved for the oldest paid order, without issuing a partial delivery.
            if (!shared && selected.length) {
                const partialIds = selected.map((card) => card.id).join(',')
                await dbRun(sql`UPDATE cards SET reserved_order_id = ${orderId}, reserved_at = ${now}
                    WHERE product_id = ${order.productId} AND instr(',' || ${partialIds} || ',', ',' || id || ',') > 0
                    AND COALESCE(is_used, 0) = 0 AND (expires_at IS NULL OR expires_at > ${now})
                    AND (reserved_order_id = ${orderId} OR ((reserved_at IS NULL OR reserved_at < ${cutoff})
                        AND NOT EXISTS (SELECT 1 FROM orders holding WHERE holding.order_id = cards.reserved_order_id AND holding.status = 'paid')))
                    AND EXISTS (SELECT 1 FROM orders WHERE order_id = ${orderId} AND status = 'paid' AND COALESCE(card_key, '') = '')`)
                try { await recalcProductAggregates(order.productId) } catch { /* maintenance retries aggregates */ }
                invalidateInventory(order.productId)
            }
            return { delivered: false, replayed: false, reason: 'insufficient_stock' }
        }
        const ids = selected.map((card) => card.id).join(',')
        const keys = (shared ? Array(quantity).fill(selected[0].cardKey) : selected.map((card) => card.cardKey)).join('\n')
        const token = crypto.randomUUID()
        const deliveryNow = Date.now()
        const expected = shared ? 1 : quantity
        const statements: SqlStatement[] = [{
            // Recheck every selected card AND the order inside the transaction.
            // If another request claims stock first, this insert affects zero rows.
            sql: `INSERT INTO order_deliveries (order_id, attempt_id, card_ids, card_key, is_shared, created_at)
                SELECT order_id, ?, ?, ?, ?, ? FROM orders
                WHERE order_id = ? AND product_id = ? AND quantity = ? AND status = 'paid' AND COALESCE(card_key, '') = ''
                AND EXISTS (SELECT 1 FROM products WHERE id = ? AND COALESCE(is_shared, 0) = ?)
                AND (SELECT COUNT(*) FROM cards WHERE product_id = ? AND instr(',' || ? || ',', ',' || id || ',') > 0
                    AND COALESCE(is_used, 0) = 0 AND (expires_at IS NULL OR expires_at > ?)
                    AND (? = 1 OR reserved_order_id = ? OR ((reserved_at IS NULL OR reserved_at < ?)
                        AND NOT EXISTS (SELECT 1 FROM orders holding WHERE holding.order_id = cards.reserved_order_id AND holding.status = 'paid')))) = ?
                ON CONFLICT(order_id) DO NOTHING`,
            params: [token, ids, keys, Number(shared), now, orderId, order.productId, quantity,
                order.productId, Number(shared), order.productId, ids, deliveryNow, Number(shared), orderId, cutoff, expected],
        }, {
            sql: `UPDATE cards SET is_used = 1, used_at = ?, reserved_order_id = NULL, reserved_at = NULL
                WHERE product_id = ? AND instr(',' || ? || ',', ',' || id || ',') > 0
                AND EXISTS (SELECT 1 FROM order_deliveries WHERE order_id = ? AND attempt_id = ? AND is_shared = 0)`,
            params: [now, order.productId, ids, orderId, token],
        }, {
            sql: `UPDATE orders SET status = 'delivered', delivered_at = ?, card_key = ?, card_ids = ?, current_payment_id = NULL
                WHERE order_id = ? AND status = 'paid'
                AND EXISTS (SELECT 1 FROM order_deliveries WHERE order_id = ? AND attempt_id = ?)`,
            params: [now, keys, ids, orderId, orderId, token],
        }, {
            sql: `INSERT OR IGNORE INTO inventory_events (event_id, kind, order_id, product_id, created_at)
                SELECT ?, 'delivery', order_id, ?, ? FROM order_deliveries WHERE order_id = ? AND attempt_id = ?`,
            params: [`delivery:${orderId}`, order.productId, now, orderId, token],
        }, {
            sql: `INSERT INTO user_notifications (user_id, type, title_key, content_key, data, created_at)
                SELECT user_id, 'order_delivered', 'profile.notifications.orderDeliveredTitle', 'profile.notifications.orderDeliveredBody', ?, ?
                FROM orders WHERE order_id = ? AND status = 'delivered' AND user_id IS NOT NULL
                AND EXISTS (SELECT 1 FROM login_users WHERE login_users.user_id = orders.user_id)
                AND EXISTS (SELECT 1 FROM order_deliveries WHERE order_id = ? AND attempt_id = ?)`,
            params: [JSON.stringify({ params: { orderId, productName: order.productName }, href: `/order/${orderId}` }), now, orderId, orderId, token],
        }]
        await dbBatchRaw(statements)
        const saved = await db.query.orders.findFirst({ where: eq(orders.orderId, orderId), columns: { status: true } })
        if (saved?.status === 'delivered') {
            const receipt = await dbRun<{ attempt_id: string }>(sql`SELECT attempt_id FROM order_deliveries WHERE order_id = ${orderId}`)
            try { await recalcProductAggregates(order.productId) } catch { /* Stock is already committed; maintenance retries aggregates. */ }
            invalidateInventory(order.productId)
            return { delivered: true, replayed: receipt.results[0]?.attempt_id !== token }
        }
    }
    return { delivered: false, replayed: false, reason: 'stock_changed' }
}

export async function fulfillPendingOrders(productId?: string, limit = 10) {
    await ensureDatabaseInitialized()
    const waiting = await db.select({ orderId: orders.orderId }).from(orders).where(and(
        eq(orders.status, 'paid'), or(isNull(orders.cardKey), eq(orders.cardKey, '')),
        productId ? eq(orders.productId, productId) : undefined,
        // Payment links collect money without delivering stock.
        sql`${orders.productId} != ${PAYMENT_PRODUCT_ID}`,
    )).orderBy(asc(orders.paidAt), asc(orders.createdAt), asc(orders.orderId)).limit(Math.min(50, Math.max(1, limit)))
    let delivered = 0
    for (const { orderId } of waiting) {
        const result = await fulfillPaidOrder(orderId)
        if (result.delivered && !result.replayed) delivered++
    }
    return { checked: waiting.length, delivered }
}
