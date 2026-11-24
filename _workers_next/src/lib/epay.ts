export function getEpayApiUrl() {
    const endpoint = new URL(process.env.PAY_URL || 'https://credit.linux.do/epay/pay/submit.php')
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error('Invalid payment server URL')
    let pathname = endpoint.pathname.replace('/pay/submit.php', '/api.php').replace('/submit.php', '/api.php')
    if (!pathname.endsWith('api.php')) pathname = '/epay/api.php'
    return `${endpoint.origin}${pathname}`
}

/**
 * The payment platform finds an order by merchant order number (`out_trade_no`) and rejects a query
 * without one. A retried payment has its own number, so a paid order is looked up under the number of
 * its latest payment attempt first, and a record is accepted only when its transaction number matches.
 */
export async function queryOrderStatus(orderId: string, tradeNo?: string, paymentId?: string | null) {
    const merchantId = process.env.MERCHANT_ID
    const merchantKey = process.env.MERCHANT_KEY
    if (!merchantId || !merchantKey) return { success: false as const, error: 'Missing merchant config' }

    const retryPrefix = `${orderId}_retry`
    const isRetryId = (value: unknown): value is string => typeof value === 'string'
        && value.startsWith(retryPrefix) && /^\d+$/.test(value.slice(retryPrefix.length))
    const merchantOrderNos = tradeNo && isRetryId(paymentId) ? [paymentId, orderId] : [orderId]
    let error = 'Payment query failed; try again later'

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
            if (res.status === 404) { error = 'Payment query HTTP 404'; continue }
            if (!res.ok) return { success: false as const, error: `Payment query HTTP ${res.status}` }
            const data = await res.json()
            if (!data || (data.code !== 1 && data.code !== '1')) return { success: false as const, error: 'Payment server rejected the query' }

            const status = typeof data.status === 'number' ? data.status : typeof data.status === 'string' && /^\d+$/.test(data.status) ? Number(data.status) : NaN
            if (!Number.isSafeInteger(status)
                || (data.out_trade_no !== undefined && data.out_trade_no !== orderId && !(tradeNo && isRetryId(data.out_trade_no)))) {
                return { success: false as const, error: 'Invalid payment query response' }
            }
            // Another payment attempt of the same order: its state says nothing about the paid transaction.
            if (tradeNo && String(data.trade_no ?? '') !== tradeNo) { error = 'Invalid payment query response'; continue }
            return { success: true as const, status, msg: 'Query success', data }
        }
        return { success: false as const, error }
    } catch {
        return { success: false as const, error: 'Payment query failed; try again later' }
    }
}
