import { db, dbRun } from '@/lib/db'
import { inventoryEvents, orders, loginUsers, products } from '@/lib/db/schema'
import { ensureDatabaseInitialized, getSetting } from '@/lib/db/queries'
import { and, asc, eq, isNull, lte, or, sql } from 'drizzle-orm'
import { after } from 'next/server'
import { getNotificationSettings, notifyAdminPaymentSuccess, sendBarkMessage, sendTelegramMessage } from '@/lib/notifications'
import { getEmailSettings, sendOrderEmail } from '@/lib/email'
import { pullOneCardFromApi } from '@/lib/card-api'
import { procureOrderCards } from '@/lib/supplier-fulfillment'

export function scheduleInventoryEvents() {
    try { after(() => processInventoryEvents()) } catch { /* Cron processes durable events if no request context exists. */ }
}

export async function processInventoryEvents(limit = 10) {
    await ensureDatabaseInitialized()
    const now = Date.now()
    const due = await db.select({ eventId: inventoryEvents.eventId }).from(inventoryEvents).where(and(
        isNull(inventoryEvents.completedAt), lte(inventoryEvents.nextAttemptAt, new Date(now)),
        or(isNull(inventoryEvents.leaseUntil), lte(inventoryEvents.leaseUntil, new Date(now))),
    )).orderBy(asc(inventoryEvents.createdAt)).limit(Math.min(50, Math.max(1, limit)))
    let completed = 0
    for (const { eventId } of due) {
        const token = crypto.randomUUID()
        await dbRun(sql`UPDATE inventory_events SET lease_token = ${token}, lease_until = ${Date.now() + 300_000}, attempts = attempts + 1
            WHERE event_id = ${eventId} AND completed_at IS NULL AND next_attempt_at <= ${Date.now()}
            AND (lease_until IS NULL OR lease_until <= ${Date.now()})`)
        const event = await db.query.inventoryEvents.findFirst({ where: and(eq(inventoryEvents.eventId, eventId), eq(inventoryEvents.leaseToken, token)) })
        if (!event) continue
        let telegramDone = event.telegramSent, barkDone = event.barkSent, emailDone = event.emailSent, replenished = event.replenishAttempted
        let error: string | null = null, done = false
        const save = (values: Partial<typeof inventoryEvents.$inferInsert>) => db.update(inventoryEvents).set(values).where(and(eq(inventoryEvents.eventId, eventId), eq(inventoryEvents.leaseToken, token)))
        try {
            const settings = await getNotificationSettings()
            if (event.kind === 'payment') {
                const order = event.orderId ? await db.query.orders.findFirst({ where: eq(orders.orderId, event.orderId) }) : null
                if (!order || order.status === 'refunded') done = true
                else {
                    if (!telegramDone) {
                        telegramDone = !settings.telegramEnabled || (await notifyAdminPaymentSuccess(order, { telegram: true, bark: false })).telegram
                        if (telegramDone) await save({ telegramSent: true })
                    }
                    if (!barkDone) {
                        barkDone = !settings.barkEnabled || (await notifyAdminPaymentSuccess(order, { telegram: false, bark: true })).bark
                        if (barkDone) await save({ barkSent: true })
                    }
                    done = telegramDone && barkDone
                    if (!done) error = 'payment_notification_failed'
                }
            } else if (event.kind === 'payment_conflict') {
                const data = JSON.parse(event.data || '{}') as { orderId: string; tradeNo: string; amount: string }
                const title = settings.language === 'en' ? 'Additional payment requires review' : '检测到额外付款，请核对'
                const body = `${data.orderId}\n${settings.language === 'en' ? 'Transaction' : '交易号'}: ${data.tradeNo}\n${settings.language === 'en' ? 'Amount' : '金额'}: ${data.amount}`
                if (!telegramDone) {
                    const text = `${title}\n${body}`.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                    telegramDone = !settings.telegramEnabled || (await sendTelegramMessage(text)).success
                    if (telegramDone) await save({ telegramSent: true })
                }
                if (!barkDone) {
                    barkDone = !settings.barkEnabled || (await sendBarkMessage(title, body, { group: 'LDC Shop' })).success
                    if (barkDone) await save({ barkSent: true })
                }
                done = telegramDone && barkDone
                if (!done) error = 'payment_conflict_notification_failed'
            } else if (event.kind === 'delivery') {
                const order = event.orderId ? await db.query.orders.findFirst({ where: eq(orders.orderId, event.orderId) }) : null
                if (!order || order.status !== 'delivered' || !order.cardKey) done = true
                else {
                    if (!emailDone) {
                        const emailSettings = await getEmailSettings()
                        const explicit = (order.email || '').trim()
                        const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(explicit)
                        const user = !validEmail && order.userId ? await db.query.loginUsers.findFirst({ where: eq(loginUsers.userId, order.userId), columns: { email: true } }) : null
                        const recipient = (validEmail ? explicit : user?.email || '').trim()
                        emailDone = !emailSettings.enabled || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)
                        if (!emailDone) emailDone = (await sendOrderEmail({ to: recipient, orderId: order.orderId, productName: order.productName,
                            cardKeys: order.cardKey, idempotencyKey: eventId })).success
                        if (emailDone) await save({ emailSent: true })
                    }
                    if (!replenished) {
                        // Supplier GET endpoints cannot guarantee idempotency. Attempt at most once per delivery.
                        replenished = true
                        await save({ replenishAttempted: true })
                        const product = await db.query.products.findFirst({ where: eq(products.id, order.productId), columns: { isShared: true } })
                        if (product && !product.isShared && order.cardIds) {
                            try { await pullOneCardFromApi(order.productId) } catch { /* Manual supplier pull remains available. */ }
                        }
                    }
                    done = emailDone && replenished
                    if (!done) error = 'delivery_email_failed'
                }
            } else if (event.kind === 'supplier') {
                const result = event.orderId ? await procureOrderCards(event.orderId) : { done: true }
                done = result.done
                if (!done) error = result.error || 'supplier_request_failed'
            } else if (event.kind === 'expiry') {
                const data = JSON.parse(event.data || '{}') as { name?: string; count?: number; expiresAt?: number }
                const label = settings.language === 'en' ? 'Stock expiring soon' : '卡密即将过期'
                const name = String(data.name || event.productId || '')
                const body = `${name}\n${settings.language === 'en' ? 'Expiring cards' : '临期卡密'}: ${Number(data.count || 0)}\n${new Date(Number(data.expiresAt)).toISOString()}`
                if (!telegramDone) {
                    const safeText = `${label}\n${body}`.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                    telegramDone = !settings.telegramEnabled || (await sendTelegramMessage(safeText)).success
                    if (telegramDone) await save({ telegramSent: true })
                }
                if (!barkDone) {
                    barkDone = !settings.barkEnabled || (await sendBarkMessage(label, body, { group: 'LDC Shop' })).success
                    if (barkDone) await save({ barkSent: true })
                }
                done = telegramDone && barkDone
                if (!done) error = 'expiry_notification_failed'
            } else { done = true }
        } catch { error = 'inventory_event_failed' }
        await save({ completedAt: done ? new Date() : null, error, leaseToken: null, leaseUntil: null,
            nextAttemptAt: new Date(Date.now() + Math.min(1_800_000, 30_000 * 2 ** Math.min(event.attempts, 6))) })
        if (done) completed++
    }
    return { checked: due.length, completed }
}

export async function enqueueExpiryAlerts() {
    await ensureDatabaseInitialized()
    const settings = await getNotificationSettings()
    if (!settings.telegramEnabled && !settings.barkEnabled) return { queued: 0 }
    const configured = Number(await getSetting('expiry_alert_minutes') ?? '60')
    const minutes = Number.isInteger(configured) && configured >= 0 && configured <= 10_080 ? configured : 60
    if (!minutes) return { queued: 0 }
    const now = Date.now()
    const rows = await dbRun<{ product_id: string; name: string; count: number; expires_at: number }>(sql`
        SELECT c.product_id, p.name, COUNT(*) AS count, MIN(c.expires_at) AS expires_at FROM cards c JOIN products p ON p.id = c.product_id
        WHERE COALESCE(c.is_used, 0) = 0 AND c.expires_at > ${now} AND c.expires_at <= ${now + minutes * 60_000}
        GROUP BY c.product_id ORDER BY MIN(c.expires_at) LIMIT 50`)
    let queued = 0
    for (const row of rows.results) {
        const inserted = await db.insert(inventoryEvents).values({ eventId: `expiry:${row.product_id}:${Math.floor(now / 3_600_000)}`,
            kind: 'expiry', productId: row.product_id, createdAt: new Date(now),
            data: JSON.stringify({ name: row.name, count: row.count, expiresAt: row.expires_at }),
        }).onConflictDoNothing().returning({ id: inventoryEvents.eventId })
        queued += inserted.length
    }
    return { queued }
}
