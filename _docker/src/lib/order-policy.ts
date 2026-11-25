import { getEpayApiUrl } from '@/lib/epay'
import { MAX_PENDING_ORDERS_PER_USER, MAX_UNPAID_ORDERS_PER_HOUR, UNPAID_ORDER_WINDOW_MS } from '@/lib/constants'

/** Prices and payments use whole cents. Do not round an invalid or partly parsed amount into a valid payment. */
export function moneyCents(input: unknown): number | null {
    const text = typeof input === 'string' ? input.trim() : typeof input === 'number' ? String(input) : ''
    if (!/^\d{1,13}(\.\d{1,2})?$/.test(text)) return null
    const [whole, fraction = ''] = text.split('.')
    const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
    return Number.isSafeInteger(cents) && cents >= 0 ? cents : null
}

export function merchantConfigured() {
    if (!process.env.MERCHANT_ID?.trim() || !process.env.MERCHANT_KEY?.trim()) return false
    try { getEpayApiUrl(); return true } catch { return false }
}

// Both kinds of checkout enforce the same limits inside their INSERT statement.
export const NEW_ORDER_ALLOWED_SQL = `EXISTS (SELECT 1 FROM login_users WHERE user_id = ? AND COALESCE(is_blocked, 0) = 0)
    AND (SELECT COUNT(*) FROM orders WHERE user_id = ? AND status = 'pending') < ?
    AND (SELECT COUNT(*) FROM orders WHERE user_id = ? AND status IN ('pending', 'cancelled') AND created_at > ?) < ?`

export function newOrderAllowedParams(userId: string, now: number) {
    return [userId, userId, MAX_PENDING_ORDERS_PER_USER, userId, now - UNPAID_ORDER_WINDOW_MS, MAX_UNPAID_ORDERS_PER_HOUR]
}
