'use server'

import { refundOrderInventory } from '@/lib/order-transitions';
import { db } from "@/lib/db";
import { orders } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { revalidatePath, updateTag } from "next/cache";
import { getSetting, recalcProductAggregates } from "@/lib/db/queries";
import { checkAdmin } from "@/actions/admin";
import { getEpayApiUrl, isPaymentIdOf, queryOrderStatus } from '@/lib/epay';
import { claimPaymentRefund, savePaymentRefundState, type RefundResult } from '@/lib/payment-refund';
import { moneyCents } from '@/lib/order-policy';

// This action only records a refund completed outside the shop; it never moves money.
export async function markOrderRefunded(orderId: string, confirmPlatformRefund = false) {
    await checkAdmin()

    const order = await db.query.orders.findFirst({ where: eq(orders.orderId, orderId) })
    if (!order) throw new Error("Order not found")
    if (order.status === 'refunded') return { success: true }
    if (!['paid', 'delivered'].includes(order.status || '')) throw new Error('Order is not refundable')
    const cents = moneyCents(order.amount)
    if (cents === null) throw new Error('Invalid payment refund amount')
    if (cents > 0 && confirmPlatformRefund !== true) throw new Error('Confirm the refund on the payment platform first')

    return finalizeOrderRefund(order, true)
}

async function finalizeOrderRefund(order: typeof orders.$inferSelect, requireNoActiveRefund = false) {
    const orderId = order.orderId

    const reclaimCards = (await getSetting('refund_reclaim_cards')) !== 'false'
    await refundOrderInventory(orderId, reclaimCards, requireNoActiveRefund)

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

function parseRefundResponse(text: string): 'accepted' | 'retryable' | 'unknown' {
    try {
        const json = JSON.parse(text)
        if (json?.code === 1 || json?.code === '1') return 'accepted'
        if (json?.code === 0 || json?.code === '0' || json?.code === -1 || json?.code === '-1') return 'retryable'
    } catch {
        const plain = text.trim().toLowerCase()
        if (['fail', 'failed', 'failure', 'unsuccessful'].includes(plain)) return 'retryable'
    }
    return 'unknown'
}

export async function proxyRefund(orderId: string, confirmVerifiedRetry = false): Promise<RefundResult> {
    await checkAdmin()

    const pid = process.env.MERCHANT_ID
    const key = process.env.MERCHANT_KEY
    if (!pid || !key) return { ok: false, processed: false, message: 'Missing merchant config' }

    const order = await db.query.orders.findFirst({ where: eq(orders.orderId, orderId) })
    if (!order) return { ok: false, processed: false, message: 'Order not found' }
    if (order.status === 'refunded') return { ok: true, processed: true, message: 'Already refunded' }
    if (!order.tradeNo || !['paid', 'delivered'].includes(order.status || '')) return { ok: false, processed: false, message: 'Order is not eligible for a payment refund' }
    const cents = moneyCents(order.amount)
    if (cents === null || cents <= 0) return { ok: false, processed: false, message: 'Invalid payment refund amount' }

    const uncertain = (): RefundResult => ({ ok: false, processed: false, needsVerification: true,
        message: 'Refund result is uncertain; check the payment platform before retrying', messageKey: 'admin.orders.refundNeedsVerification' })
    const storageFailure = (): RefundResult => ({ ok: false, processed: false, needsVerification: true,
        message: 'Refund state could not be saved; check the payment platform', messageKey: 'admin.orders.refundStorageFailed' })
    let apiUrl: string
    try { apiUrl = getEpayApiUrl() } catch { return { ok: false, processed: false, message: 'Invalid payment server URL' } }
    let attempt: Awaited<ReturnType<typeof claimPaymentRefund>>
    try { attempt = await claimPaymentRefund(order, confirmVerifiedRetry === true) } catch { return storageFailure() }
    if (!attempt.claimed) {
        const current = await db.query.orders.findFirst({ where: eq(orders.orderId, orderId), columns: { status: true } })
        if (current?.status === 'refunded') return { ok: true, processed: true, message: 'Already refunded' }
        if (attempt.needsReview) return { ok: false, processed: false, needsReview: true,
            message: 'Confirm the previous refund did not complete before retrying', messageKey: 'admin.orders.refundRetryConfirm' }
        if (!attempt.inProgress) return uncertain()
        return { ok: true, processed: false, inProgress: true, message: 'Refund is already in progress', messageKey: 'admin.orders.refundInProgress' }
    }
    const { token } = attempt

    const completeLocalRefund = async (): Promise<RefundResult> => {
        try {
            if (!await savePaymentRefundState(order, token, 'accepted', null, false)) return storageFailure()
            await finalizeOrderRefund(order)
            try { await savePaymentRefundState(order, token, 'accepted') } catch { /* The refunded order prevents another submission. */ }
            return { ok: true, processed: true, message: 'Refund processed' }
        } catch {
            // Accepted stays durable even if the inventory/points transaction rolls back.
            try { await savePaymentRefundState(order, token, 'accepted', 'refund_local_save_failed') } catch { /* Later verification recovers a lost response. */ }
            return storageFailure()
        }
    }
    if (attempt.state === 'accepted') return completeLocalRefund()
    if (attempt.state === 'submitted' || attempt.state === 'unknown') {
        await queryOrderStatus(order.orderId, order.tradeNo, order.currentPaymentId)
        // EPay status 0 also covers unpaid, failed and processing orders. It is not refund evidence.
        try { await savePaymentRefundState(order, token, 'unknown', 'refund_verification_required') } catch { return storageFailure() }
        return uncertain()
    }

    const body = new URLSearchParams({
        pid,
        key,
        trade_no: order.tradeNo,
        out_trade_no: isPaymentIdOf(order.orderId, order.currentPaymentId) ? order.currentPaymentId : order.orderId,
        money: (cents / 100).toFixed(2),
    })

    let state: 'accepted' | 'retryable' | 'unknown' = 'unknown'
    try {
        const resp = await fetch(`${apiUrl}?act=refund`, {
            method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body, redirect: 'manual', signal: AbortSignal.timeout(15_000), cache: 'no-store',
        })
        if (resp.ok) state = parseRefundResponse(await resp.text())
    } catch { /* A lost response cannot prove the payment platform did not process the request. */ }
    if (state === 'accepted') return completeLocalRefund()
    try {
        if (!await savePaymentRefundState(order, token, state, state === 'retryable' ? 'refund_rejected' : 'refund_result_unknown')) return storageFailure()
    } catch { return storageFailure() }
    return state === 'retryable'
        ? { ok: true, processed: false, message: 'Payment server rejected the refund; correct the cause before retrying', messageKey: 'admin.orders.refundRejected' }
        : uncertain()
}
