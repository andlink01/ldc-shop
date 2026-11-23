'use server'

import { getErrorMessage } from '@/lib/errors'

import { db, dbBatchRaw } from "@/lib/db"
import { orders } from "@/lib/db/schema"
import { and, eq } from "drizzle-orm"
import { revalidatePath, updateTag } from "next/cache"
import { checkAdmin } from "@/actions/admin"
import { recalcProductAggregates, recalcProductAggregatesForMany, ensureDatabaseInitialized, getSetting } from "@/lib/db/queries"
import { fulfillPaidOrder, queuePaymentNotification } from '@/lib/fulfillment'
import { scheduleInventoryEvents } from '@/lib/inventory-events'
import { cancelPendingOrder, deleteOrderInventory, refundOrderInventory } from '@/lib/order-transitions'

export async function markOrderPaid(orderId: string) {
  await checkAdmin()
  await ensureDatabaseInitialized()
  if (!orderId) throw new Error("Missing order id")

  const order = await db.query.orders.findFirst({ where: eq(orders.orderId, orderId), columns: { productId: true } })
  await db.update(orders).set({
    status: 'paid',
    paidAt: new Date(),
  }).where(and(eq(orders.orderId, orderId), eq(orders.status, 'pending')))
  await queuePaymentNotification(orderId)
  await fulfillPaidOrder(orderId)
  scheduleInventoryEvents()

  revalidatePath('/admin/orders')
  revalidatePath(`/admin/orders/${orderId}`)
  revalidatePath(`/order/${orderId}`)
  if (order?.productId) {
    try {
      await recalcProductAggregates(order.productId)
    } catch {
      // best effort
    }
  }
  try {
    updateTag('home:products')
  } catch {
    // best effort
  }
}

export async function markOrderDelivered(orderId: string) {
  await checkAdmin()
  await ensureDatabaseInitialized()
  const existing = await db.query.orders.findFirst({ where: eq(orders.orderId, orderId) })
  if (existing?.status === 'paid' && existing.cardKey) {
    // Legacy paid orders may already contain issued keys. Complete their status without taking stock again.
    const token = crypto.randomUUID(), now = Date.now()
    await dbBatchRaw([{
      sql: `INSERT OR IGNORE INTO order_deliveries (order_id, attempt_id, card_ids, card_key, created_at)
        SELECT order_id, ?, COALESCE(card_ids, ''), card_key, ? FROM orders WHERE order_id = ? AND status = 'paid' AND COALESCE(card_key, '') != ''`,
      params: [token, now, orderId],
    }, {
      sql: `UPDATE orders SET status = 'delivered', delivered_at = ? WHERE order_id = ? AND status = 'paid'
        AND EXISTS (SELECT 1 FROM order_deliveries WHERE order_id = ? AND attempt_id = ?)`, params: [now, orderId, orderId, token],
    }, {
      sql: `INSERT OR IGNORE INTO inventory_events (event_id, kind, order_id, product_id, created_at)
        SELECT ?, 'delivery', order_id, product_id, ? FROM orders WHERE order_id = ? AND status = 'delivered'`,
      params: [`delivery:${orderId}`, now, orderId],
    }, {
      sql: `INSERT INTO user_notifications (user_id, type, title_key, content_key, data, created_at)
        SELECT user_id, 'order_delivered', 'profile.notifications.orderDeliveredTitle', 'profile.notifications.orderDeliveredBody', ?, ?
        FROM orders WHERE order_id = ? AND status = 'delivered' AND EXISTS (SELECT 1 FROM login_users WHERE user_id = orders.user_id)
        AND EXISTS (SELECT 1 FROM order_deliveries WHERE order_id = ? AND attempt_id = ?)`,
      params: [JSON.stringify({ params: { orderId, productName: existing.productName }, href: `/order/${orderId}` }), now, orderId, orderId, token],
    }])
  }
  const result = await fulfillPaidOrder(orderId)
  scheduleInventoryEvents()
  if (!result.delivered) throw new Error('Stock unavailable or order not awaiting delivery')
  revalidatePath('/admin/orders')
  revalidatePath(`/order/${orderId}`)
}

export async function cancelOrder(orderId: string) {
  await checkAdmin()
  if (!orderId) throw new Error("Missing order id")

  const order = await db.query.orders.findFirst({ where: eq(orders.orderId, orderId), columns: { productId: true } })
  await cancelPendingOrder(orderId)

  revalidatePath('/admin/orders')
  revalidatePath(`/admin/orders/${orderId}`)
  revalidatePath(`/order/${orderId}`)
  if (order?.productId) {
    try {
      await recalcProductAggregates(order.productId)
    } catch {
      // best effort
    }
  }
  try {
    updateTag('home:products')
  } catch {
    // best effort
  }
}

export async function updateOrderEmail(orderId: string, email: string | null) {
  await checkAdmin()
  if (!orderId) throw new Error("Missing order id")
  const next = (email || '').trim()
  await db.update(orders).set({ email: next || null }).where(eq(orders.orderId, orderId))
  revalidatePath('/admin/orders')
  revalidatePath(`/admin/orders/${orderId}`)
}

async function deleteOneOrder(orderId: string) {
  await deleteOrderInventory(orderId)
}

export async function deleteOrder(orderId: string) {
  await checkAdmin()
  if (!orderId) throw new Error("Missing order id")

  const order = await db.query.orders.findFirst({ where: eq(orders.orderId, orderId), columns: { productId: true } })
  await deleteOneOrder(orderId)

  revalidatePath('/admin/orders')
  revalidatePath(`/admin/orders/${orderId}`)
  if (order?.productId) {
    try {
      await recalcProductAggregates(order.productId)
    } catch {
      // best effort
    }
  }
  try {
    updateTag('home:products')
  } catch {
    // best effort
  }
}

export async function deleteOrders(orderIds: string[]) {
  await checkAdmin()
  const ids = (orderIds || []).map((s) => String(s).trim()).filter(Boolean)
  if (!ids.length) return

  const touchedProducts: string[] = []

  for (const id of ids) {
    const order = await db.query.orders.findFirst({ where: eq(orders.orderId, id), columns: { productId: true } })
    if (order?.productId) touchedProducts.push(order.productId)
    await deleteOneOrder(id)
  }

  revalidatePath('/admin/orders')
  try {
    await recalcProductAggregatesForMany(touchedProducts)
  } catch {
    // best effort
  }
  try {
    updateTag('home:products')
  } catch {
    // best effort
  }
}

import { queryOrderStatus } from "@/lib/epay"

export async function verifyOrderRefundStatus(orderId: string) {
  await checkAdmin()
  if (!orderId) throw new Error("Missing order id")

  try {
    const result = await queryOrderStatus(orderId)

    if (result.success) {
      // status 0 = Refunded
      if (result.status === 0) {
        const order = await db.query.orders.findFirst({ where: eq(orders.orderId, orderId), columns: { productId: true } })
        await refundOrderInventory(orderId, (await getSetting('refund_reclaim_cards')) !== 'false')
        revalidatePath('/admin/orders')
        if (order?.productId) {
          try {
            await recalcProductAggregates(order.productId)
          } catch {
            // best effort
          }
        }
        try {
          updateTag('home:products')
        } catch {
          // best effort
        }
        return { success: true, status: result.status, msg: 'Refunded (Verified)' }
      } else if (result.status === 1) {
        return { success: true, status: result.status, msg: 'Paid (Not Refunded)' }
      } else {
        return { success: true, status: result.status, msg: `Status: ${result.status}` }
      }
    } else {
      return { success: false, error: result.error }
    }

  } catch (e) {
    console.error('Verify refund error', e)
    return { success: false, error: getErrorMessage(e) }
  }
}
