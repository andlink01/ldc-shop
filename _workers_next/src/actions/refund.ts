'use server'

import { refundOrderInventory } from '@/lib/order-transitions';
import { db } from "@/lib/db";
import { orders } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { revalidatePath, updateTag } from "next/cache";
import { getSetting, recalcProductAggregates } from "@/lib/db/queries";
import { checkAdmin } from "@/actions/admin";
import { getEpayApiUrl, queryOrderStatus } from '@/lib/epay';
import { claimPaymentRefund, savePaymentRefundState, type RefundResult } from '@/lib/payment-refund';

export async function markOrderRefunded(orderId: string) {
    await checkAdmin()

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

function parseRefundResponse(text: string): 'accepted' | 'retryable' | 'unknown' {
    try {
        const json = JSON.parse(text)
        if (json?.code === 1 || json?.code === '1') return 'accepted'
        if (json?.code === 0 || json?.code === '0' || json?.code === -1 || json?.code === '-1') return 'retryable'
        if (json?.code === undefined && (json?.status === 'success' || json?.msg === 'success')) return 'accepted'
        if (json?.status === 'failed' || json?.status === 'error') return 'retryable'
    } catch {
        const plain = text.trim().toLowerCase()
        if (plain === 'success') return 'accepted'
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
    if (!Number.isFinite(Number(order.amount)) || Number(order.amount) <= 0) return { ok: false, processed: false, message: 'Invalid payment refund amount' }

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
            await markOrderRefunded(orderId)
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
        const result = await queryOrderStatus(order.orderId, order.tradeNo)
        if (result.success && result.status === 0) return completeLocalRefund()
        try { await savePaymentRefundState(order, token, 'unknown', 'refund_verification_required') } catch { return storageFailure() }
        return uncertain()
    }

    const body = new URLSearchParams({
        pid,
        key,
        trade_no: order.tradeNo,
        out_trade_no: order.orderId,
        money: Number(order.amount).toFixed(2),
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
