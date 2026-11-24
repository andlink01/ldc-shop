'use server'

import { getErrorMessage } from '@/lib/errors'

import { cancelPendingOrder as cancelInventoryOrder } from '@/lib/order-transitions'
import { fulfillPaidOrder } from '@/lib/fulfillment'
import { scheduleInventoryEvents } from '@/lib/inventory-events'
import { canAccessOrder } from '@/lib/order-access'
import { auth } from "@/lib/auth"
import { queryOrderStatus } from "@/lib/epay"
import { processOrderFulfillment } from "@/lib/order-processing"
import { revalidatePath } from "next/cache"
import { db } from "@/lib/db"
import { orders } from "@/lib/db/schema"
import { eq } from "drizzle-orm"
import { withOrderColumnFallback, recalcProductAggregates } from "@/lib/db/queries"
import { cookies } from "next/headers"
import { updateTag } from "next/cache"

export async function checkOrderStatus(orderId: string) {
    const session = await auth()
    if (!session?.user) return { success: false, error: 'Unauthorized' }

    // Check ownership
    const order = await withOrderColumnFallback(async () => {
        return await db.query.orders.findFirst({
            where: eq(orders.orderId, orderId),
            columns: { userId: true, username: true, status: true, amount: true, currentPaymentId: true, productId: true, cardKey: true }
        })
    })

    if (!order) return { success: false, error: 'Order not found' }
    const cookieStore = await cookies()
    const pending = cookieStore.get('ldc_pending_order')?.value
    if (!canAccessOrder(session.user, order, orderId, pending)) {
        return { success: false, error: 'Unauthorized' }
    }

    if (order.status === 'paid' || order.status === 'delivered') {
        if (order.status === 'paid' && !order.cardKey && order.productId !== 'payment_link') {
            await fulfillPaidOrder(orderId)
            scheduleInventoryEvents()
            const refreshed = await db.query.orders.findFirst({ where: eq(orders.orderId, orderId), columns: { status: true } })
            return { success: true, status: refreshed?.status || order.status }
        }
        return { success: true, status: order.status }
    }

    try {
        // Use the latest payment ID (retry ID) if available, otherwise fallback to orderId
        const tradeNoToCheck = order.currentPaymentId || orderId
        const result = await queryOrderStatus(tradeNoToCheck)

        if (result.success && result.status === 1) { // 1 = Paid
            // trade_no might be in result.data or result.trade_no?
            // queryOrderStatus returns { ..., data: fullResponse }

            const tradeNo = result.data?.trade_no || result.data?.transaction_id
            const money = result.data?.money
            const paidAmount = typeof money === 'number' || (typeof money === 'string' && money.trim()) ? Number(money) : NaN
            if (typeof tradeNo !== 'string' || !tradeNo.trim() || !Number.isFinite(paidAmount)) {
                return { success: false, error: 'order.paymentVerificationFailed' }
            }

            await processOrderFulfillment(orderId, paidAmount, tradeNo, tradeNoToCheck)

            revalidatePath(`/order/${orderId}`)
            return { success: true, status: 'paid' } // or 'delivered' implicitly via revalidate
        }

        return { success: false, status: 'pending' }

    } catch (e) {
        console.error("Check order status failed", e)
        return { success: false, error: getErrorMessage(e) }
    }
}

export async function cancelPendingOrder(orderId: string) {
    const session = await auth()
    if (!session?.user) return { success: false, error: 'common.error' }

    // Check ownership and status
    const order = await withOrderColumnFallback(async () => {
        return await db.query.orders.findFirst({
            where: eq(orders.orderId, orderId),
            columns: { userId: true, status: true, productId: true }
        })
    })

    if (!order) return { success: false, error: 'order.notFound' }
    if (order.userId !== session.user.id) return { success: false, error: 'common.error' }
    if (order.status !== 'pending') return { success: false, error: 'order.cannotCancel' }

    try {
        await cancelInventoryOrder(orderId)

        revalidatePath(`/order/${orderId}`)
        revalidatePath('/orders')
        if (order.productId) {
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
        
        return { success: true }
    } catch (e) {
        console.error("Cancel order failed", e)
        return { success: false, error: 'common.error' }
    }
}
