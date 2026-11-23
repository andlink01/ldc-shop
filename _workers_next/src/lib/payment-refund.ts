import { db, dbRun } from '@/lib/db'
import { inventoryEvents, orders } from '@/lib/db/schema'
import { ensureDatabaseInitialized } from '@/lib/db/queries'
import { and, eq, sql } from 'drizzle-orm'

type RefundOrder = Pick<typeof orders.$inferSelect, 'orderId' | 'tradeNo' | 'amount'>
type RefundState = 'ready' | 'submitted' | 'accepted' | 'unknown' | 'retryable' | 'verified_retry'
type RefundData = { state: RefundState; tradeNo: string | null; amount: string }
type RefundClaim = { claimed: false; inProgress: boolean; needsReview?: boolean } | { claimed: true; token: string; state: RefundState }
export type RefundResult = { ok: boolean; processed: boolean; message: string; messageKey?: string; inProgress?: boolean; needsVerification?: boolean; needsReview?: boolean }

const eventId = (orderId: string) => `refund-request:${orderId}`
const serialize = (order: RefundOrder, state: RefundState) => JSON.stringify({ state, tradeNo: order.tradeNo, amount: order.amount })

function parseData(raw: string | null, order: RefundOrder): RefundData | null {
    try {
        const value = JSON.parse(raw || '') as RefundData
        if (value && value.tradeNo === order.tradeNo && value.amount === order.amount
            && ['ready', 'submitted', 'accepted', 'unknown', 'retryable', 'verified_retry'].includes(value.state)) return value
    } catch { /* An unrecognized attempt must be verified, never automatically reset. */ }
    return null
}

export async function claimPaymentRefund(order: RefundOrder, confirmVerifiedRetry = false): Promise<RefundClaim> {
    await ensureDatabaseInitialized()
    const now = Date.now()
    // Completed-at keeps this request ledger out of automatic notification processing.
    await dbRun(sql`INSERT OR IGNORE INTO inventory_events (event_id, kind, order_id, product_id, data, completed_at, created_at)
        SELECT ${eventId(order.orderId)}, 'refund_request', order_id, product_id, ${serialize(order, 'ready')}, ${now}, ${now}
        FROM orders WHERE order_id = ${order.orderId} AND status IN ('paid', 'delivered')
        AND trade_no = ${order.tradeNo} AND amount = ${order.amount}`)
    const record = await db.query.inventoryEvents.findFirst({ where: eq(inventoryEvents.eventId, eventId(order.orderId)) })
    if (!record) return { claimed: false as const, inProgress: false }
    const data = parseData(record.data, order)
    if (!data) return { claimed: false as const, inProgress: false }
    if (record.leaseUntil && record.leaseUntil.getTime() > now) return { claimed: false as const, inProgress: true }
    if (data.state === 'verified_retry' && confirmVerifiedRetry !== true) return { claimed: false, inProgress: false, needsReview: true }
    const token = crypto.randomUUID()
    const nextState = ['ready', 'retryable', 'verified_retry'].includes(data.state) ? 'submitted' : data.state
    await dbRun(sql`UPDATE inventory_events SET lease_token = ${token}, lease_until = ${now + 60_000},
        data = ${serialize(order, nextState)}, attempts = attempts + 1
        WHERE event_id = ${eventId(order.orderId)} AND data = ${record.data}
        AND (lease_until IS NULL OR lease_until <= ${now})
        AND EXISTS (SELECT 1 FROM orders WHERE order_id = ${order.orderId} AND status IN ('paid', 'delivered')
            AND trade_no = ${order.tradeNo} AND amount = ${order.amount})`)
    const claimed = await db.query.inventoryEvents.findFirst({
        where: and(eq(inventoryEvents.eventId, eventId(order.orderId)), eq(inventoryEvents.leaseToken, token)),
        columns: { eventId: true },
    })
    return claimed ? { claimed: true as const, token, state: data.state } : { claimed: false as const, inProgress: true }
}

export async function savePaymentRefundState(order: RefundOrder, token: string, state: RefundState, error: string | null = null, release = true) {
    const updated = await dbRun<{ event_id: string }>(sql`UPDATE inventory_events SET data = ${serialize(order, state)}, error = ${error},
        lease_token = CASE WHEN ${Number(release)} = 1 THEN NULL ELSE lease_token END,
        lease_until = CASE WHEN ${Number(release)} = 1 THEN NULL ELSE lease_until END
        WHERE event_id = ${eventId(order.orderId)} AND lease_token = ${token} RETURNING event_id`)
    return updated.results.length === 1
}

// Called only after an administrator explicitly checks the payment platform.
export async function allowVerifiedRefundRetry(order: RefundOrder) {
    const record = await db.query.inventoryEvents.findFirst({ where: eq(inventoryEvents.eventId, eventId(order.orderId)) })
    if (!record) return { canRetry: true, needsReview: false }
    const data = parseData(record.data, order), now = Date.now()
    if (!data || data.state === 'accepted' || (record.leaseUntil && record.leaseUntil.getTime() > now)) return { canRetry: false, needsReview: false }
    if (data.state === 'ready' || data.state === 'retryable') return { canRetry: true, needsReview: false }
    if (data.state === 'verified_retry') return { canRetry: true, needsReview: true }
    const updated = await dbRun<{ event_id: string }>(sql`UPDATE inventory_events SET data = ${serialize(order, 'verified_retry')},
        lease_token = NULL, lease_until = NULL, error = NULL
        WHERE event_id = ${eventId(order.orderId)} AND data = ${record.data}
        AND (lease_until IS NULL OR lease_until <= ${now})
        AND EXISTS (SELECT 1 FROM orders WHERE order_id = ${order.orderId} AND status IN ('paid', 'delivered')
            AND trade_no = ${order.tradeNo} AND amount = ${order.amount}) RETURNING event_id`)
    return { canRetry: updated.results.length === 1, needsReview: updated.results.length === 1 }
}
