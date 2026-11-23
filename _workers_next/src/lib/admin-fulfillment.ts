import { and, asc, eq, or, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { orders, products } from '@/lib/db/schema'
import { normalizeTimestampMs, onDemandProductCondition } from '@/lib/db/queries'
import { PAYMENT_PRODUCT_ID } from '@/lib/payment'

export async function getPendingDeliveryOrders(params: Record<string, string | string[] | undefined> = {}) {
    const query = (typeof params.q === 'string' ? params.q : '').trim().slice(0, 200)
    const requestedPage = Number(typeof params.page === 'string' ? params.page : '1')
    const pageSize = 50
    const where = and(eq(orders.status, 'paid'), sql`COALESCE(${orders.cardKey}, '') = ''`,
        sql`${orders.productId} != ${PAYMENT_PRODUCT_ID}`,
        query ? or(
            sql`${orders.orderId} LIKE ${`%${query}%`}`,
            sql`${orders.productName} LIKE ${`%${query}%`}`,
            sql`COALESCE(${orders.username}, '') LIKE ${`%${query}%`}`,
            sql`COALESCE(${orders.email}, '') LIKE ${`%${query}%`}`,
        ) : undefined)
    const [count] = await db.select({ count: sql<number>`count(*)` }).from(orders).where(where)
    const total = Number(count?.count || 0)
    const page = Math.min(Math.max(1, Math.ceil(total / pageSize)),
        Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1)
    const now = Date.now()
    const rows = await db.select({
        orderId: orders.orderId, productId: orders.productId, productName: orders.productName,
        variantLabel: products.variantLabel, quantity: orders.quantity,
        onDemand: sql<number>`CASE WHEN ${onDemandProductCondition()} THEN 1 ELSE 0 END`,
        username: orders.username, userId: orders.userId, amount: orders.amount,
        tradeNo: orders.tradeNo,
        paidAt: orders.paidAt, createdAt: orders.createdAt, status: orders.status, cardKey: orders.cardKey,
        // Prefer active work, including task errors before an individual request exists.
        supplierError: sql<string | null>`CASE WHEN EXISTS (SELECT 1 FROM inventory_events
            WHERE order_id = ${orders.orderId} AND kind = 'supplier' AND completed_at IS NULL AND lease_until > ${now})
            OR EXISTS (SELECT 1 FROM supplier_requests WHERE order_id = ${orders.orderId} AND state = 'pending' AND lease_until > ${now})
            THEN 'supplier_request_in_progress'
            WHEN NOT EXISTS (SELECT 1 FROM settings WHERE key = 'cards_api_mode_' || ${orders.productId} AND value = 'on_demand')
            THEN NULL ELSE COALESCE(
                (SELECT error FROM inventory_events WHERE order_id = ${orders.orderId} AND kind = 'supplier'
                    AND completed_at IS NULL ORDER BY created_at DESC LIMIT 1),
                (SELECT error FROM supplier_requests WHERE order_id = ${orders.orderId} AND state = 'pending'
                    AND error IS NOT NULL ORDER BY item_index LIMIT 1)) END`,
    }).from(orders).leftJoin(products, eq(orders.productId, products.id)).where(where)
        .orderBy(asc(normalizeTimestampMs(orders.paidAt)), asc(normalizeTimestampMs(orders.createdAt)), asc(orders.orderId))
        .limit(pageSize).offset((page - 1) * pageSize)
    return { orders: rows, total, page, pageSize, query }
}

export type PendingDeliveryOrder = Awaited<ReturnType<typeof getPendingDeliveryOrders>>['orders'][number]
