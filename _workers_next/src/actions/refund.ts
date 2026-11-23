'use server'

import { refundOrderInventory } from '@/lib/order-transitions';
import { db } from "@/lib/db";
import { orders } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { revalidatePath, updateTag } from "next/cache";
import { getSetting, recalcProductAggregates } from "@/lib/db/queries";
import { checkAdmin } from "@/actions/admin";
import { getEpayApiUrl } from '@/lib/epay';

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
    if (!pid || !key) return { ok: false, processed: false, message: 'Missing merchant config' }

    const order = await db.query.orders.findFirst({ where: eq(orders.orderId, orderId) })
    if (!order) return { ok: false, processed: false, message: 'Order not found' }
    if (order.status === 'refunded') return { ok: true, processed: true, message: 'Already refunded' }
    if (!order.tradeNo || !['paid', 'delivered'].includes(order.status || '')) return { ok: false, processed: false, message: 'Order is not eligible for a payment refund' }

    const body = new URLSearchParams({
        pid,
        key,
        trade_no: order.tradeNo,
        out_trade_no: order.orderId,
        money: Number(order.amount).toFixed(2),
    })

    let text: string
    try {
        const resp = await fetch(`${getEpayApiUrl()}?act=refund`, {
            method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body, redirect: 'manual', signal: AbortSignal.timeout(15_000), cache: 'no-store',
        })
        if (!resp.ok) return { ok: false, processed: false, message: `Refund HTTP ${resp.status}` }
        text = await resp.text()
    } catch { return { ok: false, processed: false, message: 'Refund request failed; verify the payment platform before retrying' } }

    let success = false
    try {
        const json = JSON.parse(text)
        success = json?.code !== undefined ? (json.code === 1 || json.code === '1') : json?.status === 'success' || json?.msg === 'success'
    } catch {
        success = text.trim().toLowerCase() === 'success'
    }

    if (success) {
        await markOrderRefunded(orderId)
        return { ok: true, processed: true, message: 'Refund processed' }
    }

    return { ok: true, processed: false, message: 'Payment server did not confirm the refund' }
}
