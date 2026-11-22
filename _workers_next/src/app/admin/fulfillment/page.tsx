import { checkAdmin } from '@/actions/admin'
import { db } from '@/lib/db'
import { orders } from '@/lib/db/schema'
import { ensureDatabaseInitialized } from '@/lib/db/queries'
import { asc, sql } from 'drizzle-orm'
import { PAYMENT_PRODUCT_ID } from '@/lib/payment'
import { PendingDeliveryContent } from '@/components/admin/pending-delivery-content'

export const dynamic = 'force-dynamic'

export default async function FulfillmentPage() {
    await checkAdmin()
    await ensureDatabaseInitialized()
    const rows = await db.select({ orderId: orders.orderId, productId: orders.productId, productName: orders.productName,
        supplierError: sql<string | null>`(SELECT error FROM supplier_requests WHERE order_id = ${orders.orderId} AND error IS NOT NULL ORDER BY item_index LIMIT 1)`,
        quantity: orders.quantity, username: orders.username, status: orders.status, cardKey: orders.cardKey,
    }).from(orders).where(sql`${orders.status} = 'paid' AND COALESCE(${orders.cardKey}, '') = '' AND ${orders.productId} != ${PAYMENT_PRODUCT_ID}`)
        .orderBy(asc(orders.paidAt), asc(orders.createdAt)).limit(200)
    return <PendingDeliveryContent orders={rows} />
}
