export function getEpayApiUrl() {
    const endpoint = new URL(process.env.PAY_URL || 'https://credit.linux.do/epay/pay/submit.php')
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error('Invalid payment server URL')
    let pathname = endpoint.pathname.replace('/pay/submit.php', '/api.php').replace('/submit.php', '/api.php')
    if (!pathname.endsWith('api.php')) pathname = '/epay/api.php'
    return `${endpoint.origin}${pathname}`
}

export async function queryOrderStatus(orderId: string, tradeNo?: string) {
    const merchantId = process.env.MERCHANT_ID
    const merchantKey = process.env.MERCHANT_KEY
    if (!merchantId || !merchantKey) return { success: false as const, error: 'Missing merchant config' }

    const query = new URLSearchParams({
        act: 'order',
        pid: merchantId,
        key: merchantKey,
        ...(tradeNo ? { trade_no: tradeNo } : { out_trade_no: orderId })
    })

    try {
        const res = await fetch(`${getEpayApiUrl()}?${query.toString()}`, { cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(15_000) })
        if (!res.ok) return { success: false as const, error: `Payment query HTTP ${res.status}` }
        const data = await res.json()

        if (data && (data.code === 1 || data.code === '1')) {
            const status = typeof data.status === 'number' ? data.status : typeof data.status === 'string' && /^\d+$/.test(data.status) ? Number(data.status) : NaN
            const retryId = typeof data.out_trade_no === 'string' && data.out_trade_no.startsWith(`${orderId}_retry`)
                && /^\d+$/.test(data.out_trade_no.slice(`${orderId}_retry`.length))
            if (!Number.isSafeInteger(status)
                || (data.out_trade_no !== undefined && data.out_trade_no !== orderId && !(tradeNo && retryId))
                || (tradeNo && data.trade_no !== undefined && data.trade_no !== tradeNo)) return { success: false as const, error: 'Invalid payment query response' }
            return { success: true as const, status, msg: 'Query success', data }
        } else {
            return { success: false as const, error: 'Payment server rejected the query' }
        }

    } catch {
        return { success: false as const, error: 'Payment query failed; try again later' }
    }
}
