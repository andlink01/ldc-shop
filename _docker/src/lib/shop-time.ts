// Day boundaries for check-in and sales statistics follow the shop timezone
// rather than the server clock (Workers always run in UTC).
const DEFAULT_UTC_OFFSET_MINUTES = 480 // Asia/Shanghai
const DAY_MS = 86_400_000

export function shopUtcOffsetMs() {
    const raw = (process.env.SHOP_UTC_OFFSET_MINUTES || '').trim()
    const minutes = raw ? Number(raw) : NaN
    return (Number.isInteger(minutes) && Math.abs(minutes) <= 840 ? minutes : DEFAULT_UTC_OFFSET_MINUTES) * 60_000
}

export function shopDayStartMs(nowMs: number = Date.now()) {
    const offset = shopUtcOffsetMs()
    return Math.floor((nowMs + offset) / DAY_MS) * DAY_MS - offset
}

export function shopMonthStartMs(nowMs: number = Date.now()) {
    const offset = shopUtcOffsetMs()
    const local = new Date(nowMs + offset)
    return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - offset
}
