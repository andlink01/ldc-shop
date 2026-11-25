import { requireAdminPage } from "@/lib/admin-guard"
import { notFound } from "next/navigation"
import { db } from "@/lib/db"
import { orders, inventoryEvents } from "@/lib/db/schema"
import { and, desc, eq } from "drizzle-orm"
import { AdminOrderDetailContent } from "@/components/admin/order-detail-content"
import { getProductVariantLabels } from "@/lib/db/queries"
import { unstable_noStore } from "next/cache"

export default async function AdminOrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdminPage()
  unstable_noStore()
  const { id } = await params
  const order = await db.query.orders.findFirst({ where: eq(orders.orderId, id) })
  if (!order) return notFound()

  const labels = order.productId ? await getProductVariantLabels([order.productId]) : {}
  const productVariantLabel = order.productId ? labels[order.productId] ?? null : null
  const conflicts = await db.select({ data: inventoryEvents.data }).from(inventoryEvents)
    .where(and(eq(inventoryEvents.orderId, id), eq(inventoryEvents.kind, 'payment_conflict')))
    .orderBy(desc(inventoryEvents.createdAt)).limit(100)
  const paymentConflicts = conflicts.flatMap(({ data }) => {
    try {
      const value = JSON.parse(data || '') as { tradeNo?: unknown; amount?: unknown }
      return typeof value.tradeNo === 'string' && typeof value.amount === 'string' ? [{ tradeNo: value.tradeNo, amount: value.amount }] : []
    } catch { return [] }
  })

  return (
    <AdminOrderDetailContent
      paymentConflicts={paymentConflicts}
      order={{
        orderId: order.orderId,
        username: order.username,
        userId: order.userId,
        email: order.email,
        productId: order.productId,
        productName: order.productName,
        productVariantLabel,
        amount: order.amount,
        status: order.status,
        tradeNo: order.tradeNo,
        cardKey: order.cardKey,
        createdAt: order.createdAt,
        paidAt: order.paidAt,
        deliveredAt: order.deliveredAt,
      }}
    />
  )
}
