export function getEpayApiUrl() {
    const endpoint = new URL(process.env.PAY_URL || 'https://credit.linux.do/epay/pay/submit.php')
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error('Invalid payment server URL')
    let pathname = endpoint.pathname.replace('/pay/submit.php', '/api.php').replace('/submit.php', '/api.php')
    if (!pathname.endsWith('api.php')) pathname = '/epay/api.php'
    return `${endpoint.origin}${pathname}`
}

/** A payment is submitted under the order number, or under `<order>_retry<timestamp>` when it is retried. */
export function isPaymentIdOf(orderId: string, value: unknown): value is string {
    if (value === orderId) return true
    const retryPrefix = `${orderId}_retry`
    return typeof value === 'string' && value.startsWith(retryPrefix) && /^\d+$/.test(value.slice(retryPrefix.length))
}

/**
 * The payment platform finds an order by merchant order number (`out_trade_no`) and rejects a query
 * without one. A retried payment has its own number, so a paid order is looked up under the number it
 * was paid with first, and a record is accepted only when its transaction number matches.
 */
export async function queryOrderStatus(orderId: string, tradeNo?: string, paymentId?: string | null) {
    const merchantId = process.env.MERCHANT_ID
    const merchantKey = process.env.MERCHANT_KEY
    if (!merchantId || !merchantKey) return { success: false as const, error: 'Missing merchant config' }

    const merchantOrderNos = tradeNo && paymentId !== orderId && isPaymentIdOf(orderId, paymentId) ? [paymentId, orderId] : [orderId]
    // Set when the platform has no record of this transaction under any number the shop knows.
    let unmatched: string | undefined

    try {
        for (const merchantOrderNo of merchantOrderNos) {
            const query = new URLSearchParams({
                act: 'order',
                pid: merchantId,
                key: merchantKey,
                out_trade_no: merchantOrderNo,
                ...(tradeNo ? { trade_no: tradeNo } : {})
            })
            const res = await fetch(`${getEpayApiUrl()}?${query.toString()}`, { cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(15_000) })
            if (res.status === 404) { unmatched = 'Payment query HTTP 404'; continue }
            if (!res.ok) return { success: false as const, error: `Payment query HTTP ${res.status}` }
            const data = await res.json()
            if (!data || (data.code !== 1 && data.code !== '1')) return { success: false as const, error: 'Payment server rejected the query' }

            const status = typeof data.status === 'number' ? data.status : typeof data.status === 'string' && /^\d+$/.test(data.status) ? Number(data.status) : NaN
            if (!Number.isSafeInteger(status)
                || (data.out_trade_no !== undefined && data.out_trade_no !== orderId && !(tradeNo && isPaymentIdOf(orderId, data.out_trade_no)))) {
                return { success: false as const, error: 'Invalid payment query response' }
            }
            // Another payment attempt of the same order: its state says nothing about the paid transaction.
            if (tradeNo && String(data.trade_no ?? '') !== tradeNo) { unmatched = 'Invalid payment query response'; continue }
            return { success: true as const, status, msg: 'Query success', data }
        }
        return { success: false as const, error: unmatched || 'Payment query failed; try again later', unmatched: true as const }
    } catch {
        return { success: false as const, error: 'Payment query failed; try again later' }
    }
}
