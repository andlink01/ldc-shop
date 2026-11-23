'use server'

import { refundOrderInventory } from '@/lib/order-transitions';
import { db } from "@/lib/db";
import { orders } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { revalidatePath, updateTag } from "next/cache";
import { getSetting, recalcProductAggregates } from "@/lib/db/queries";
import { checkAdmin } from "@/actions/admin";

export async function markOrderRefunded(orderId: string) {
    await checkAdmin()

    // No transaction - D1 doesn't support SQL transactions in HTTP api easily
    const order = await db.query.orders.findFirst({ where: eq(orders.orderId, orderId) })
    if (!order) throw new Error("Order not found")

    const reclaimCards = (await getSetting('refund_reclaim_cards')) !== 'false'
    await refundOrderInventory(orderId, reclaimCards)

    revalidatePath('/admin/orders')
    revalidatePath('/admin/refunds')
    revalidatePath(`/order/${orderId}`)

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
}

export async function proxyRefund(orderId: string) {
    await checkAdmin()

    const pid = process.env.MERCHANT_ID
    const key = process.env.MERCHANT_KEY
    if (!pid || !key) throw new Error("Missing merchant config")

    const order = await db.query.orders.findFirst({ where: eq(orders.orderId, orderId) })
    if (!order) throw new Error("Order not found")
    if (!order.tradeNo) throw new Error("Missing trade_no")

    const body = new URLSearchParams({
        pid,
        key,
        trade_no: order.tradeNo,
        out_trade_no: order.orderId,
        money: Number(order.amount).toFixed(2),
    })

    const resp = await fetch('https://credit.linux.do/epay/api.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body
    })

    const text = await resp.text()

    let success = false
    try {
        const json = JSON.parse(text)
        success = json?.code === 1 || json?.status === 'success' || json?.msg === 'success'
    } catch {
        success = /success/i.test(text)
    }

    if (!resp.ok) {
        throw new Error(`Refund proxy failed (${resp.status})`)
    }

    if (success) {
        await markOrderRefunded(orderId)
        return { ok: true, processed: true, message: text.slice(0, 500) }
    }

    return { ok: true, processed: false, message: text.slice(0, 500) }
}
