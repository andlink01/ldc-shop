import { db, dbRun, dbBatchRaw } from '@/lib/db'
import { orders, supplierRequests } from '@/lib/db/schema'
import { getProductCardApiConfig } from '@/lib/card-api'
import { ensureDatabaseInitialized, recalcProductAggregates } from '@/lib/db/queries'
import { fulfillPaidOrder, invalidateInventory } from '@/lib/fulfillment'
import { safeOutboundHttpUrl } from '@/lib/safe-url'
import { and, eq, sql } from 'drizzle-orm'

export async function procureOrderCards(orderId: string, maxRequests = 3) {
    await ensureDatabaseInitialized()
    const order = await db.query.orders.findFirst({ where: eq(orders.orderId, orderId) })
    if (!order || order.status !== 'paid' || order.cardKey) return { done: true }
    if ((await fulfillPaidOrder(orderId)).delivered) return { done: true }
    const config = await getProductCardApiConfig(order.productId)
    if (!config.enabled || config.mode !== 'on_demand' || !config.url) return { done: false, error: 'supplier_disabled' }
    const serverUrl = safeOutboundHttpUrl(config.url, { disallowSearch: true })
    if (!serverUrl) return { done: false, error: 'supplier_url_invalid' }
    let requests = 0
    for (let index = 0; index < order.quantity && requests < Math.min(5, Math.max(1, maxRequests)); index++) {
        const current = await db.query.orders.findFirst({ where: eq(orders.orderId, orderId), columns: { status: true } })
        if (current?.status !== 'paid') return { done: true }
        const received = await db.query.supplierRequests.findFirst({ where: and(eq(supplierRequests.orderId, orderId), eq(supplierRequests.itemIndex, index)) })
        if (received?.state === 'received') continue
        if (!received) await dbRun(sql`INSERT OR IGNORE INTO supplier_requests (request_id, order_id, item_index, server_url, created_at)
            SELECT ${crypto.randomUUID()}, order_id, ${index}, ${serverUrl}, ${Date.now()} FROM orders
            WHERE order_id = ${orderId} AND status = 'paid' AND COALESCE(card_key, '') = ''`)
        const pending = await db.query.supplierRequests.findFirst({ where: and(eq(supplierRequests.orderId, orderId), eq(supplierRequests.itemIndex, index)) })
        if (!pending) return { done: true }
        if (pending.serverUrl !== serverUrl) return { done: false, error: 'supplier_endpoint_changed' }
        const token = crypto.randomUUID(), now = Date.now()
        await dbRun(sql`UPDATE supplier_requests SET lease_token = ${token}, lease_until = ${now + 60_000}, attempts = attempts + 1
            WHERE request_id = ${pending.requestId} AND state = 'pending' AND (lease_until IS NULL OR lease_until <= ${now})
            AND EXISTS (SELECT 1 FROM orders WHERE order_id = ${orderId} AND status = 'paid')`)
        const claimed = await db.query.supplierRequests.findFirst({ where: and(eq(supplierRequests.requestId, pending.requestId), eq(supplierRequests.leaseToken, token)) })
        if (!claimed) return { done: false, error: 'supplier_request_in_progress' }
        requests++
        let failure = 'supplier_request_failed'
        try {
            const response = await fetch(serverUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json',
                'Idempotency-Key': pending.requestId, ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}) },
                body: JSON.stringify({ requestId: pending.requestId, orderId, productId: order.productId, quantity: 1, itemIndex: index }),
                signal: AbortSignal.timeout(20_000), cache: 'no-store', redirect: 'manual' })
            if (response.status === 202) failure = 'supplier_processing'
            else if (!response.ok) failure = `supplier_http_${response.status}`
            else {
                // Bound the supplier response before parsing or storing any card values.
                const reader = response.body?.getReader()
                if (!reader) throw new Error('Missing response')
                const chunks: Uint8Array[] = []
                let size = 0
                try {
                    while (true) {
                        const part = await reader.read()
                        if (part.done) break
                        size += part.value.byteLength
                        if (size > 32_768) { await reader.cancel(); throw new Error('Large response') }
                        chunks.push(part.value)
                    }
                } finally { reader.releaseLock() }
                const bytes = new Uint8Array(size)
                let offset = 0
                for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
                const payload = JSON.parse(new TextDecoder().decode(bytes)) as { success?: boolean; requestId?: string; data?: { cardKey?: string; expiresAt?: string | null } }
                const key = payload.data?.cardKey
                const expiryInput = payload.data?.expiresAt
                const validExpiry = expiryInput === undefined || expiryInput === null || (typeof expiryInput === 'string'
                    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(expiryInput))
                const expires = typeof expiryInput === 'string' ? Date.parse(expiryInput) : null
                if (payload.success !== true || payload.requestId !== pending.requestId || typeof key !== 'string' || !key.trim() || key.length > 4096
                    || key.includes('\0') || !validExpiry || (expires !== null && (!Number.isFinite(expires) || expires < Date.now() + 60_000))) {
                    failure = 'supplier_invalid_response'
                } else {
                    const committedAt = Date.now()
                    await dbBatchRaw([{
                        sql: `INSERT INTO cards (product_id, card_key, expires_at, created_at, supplier_request_id, reserved_order_id, reserved_at)
                            SELECT ?, ?, ?, ?, ?, CASE WHEN o.status = 'paid' THEN o.order_id ELSE NULL END,
                                CASE WHEN o.status = 'paid' THEN ? ELSE NULL END
                            FROM orders o JOIN products p ON p.id = o.product_id WHERE o.order_id = ?
                            AND NOT EXISTS (SELECT 1 FROM cards WHERE product_id = ? AND card_key = ?)
                            AND EXISTS (SELECT 1 FROM supplier_requests WHERE request_id = ? AND lease_token = ? AND state = 'pending')`,
                        params: [order.productId, key.trim(), expires, committedAt, pending.requestId, committedAt, orderId, order.productId, key.trim(), pending.requestId, token],
                    }, {
                        sql: `UPDATE supplier_requests SET state = 'received', card_id =
                            (SELECT id FROM cards WHERE supplier_request_id = ?),
                            lease_token = NULL, lease_until = NULL, error = NULL WHERE request_id = ? AND lease_token = ?
                            AND EXISTS (SELECT 1 FROM cards WHERE supplier_request_id = ?)`,
                        params: [pending.requestId, pending.requestId, token, pending.requestId],
                    }])
                    const saved = await db.query.supplierRequests.findFirst({ where: eq(supplierRequests.requestId, pending.requestId) })
                    if (saved?.state === 'received') {
                        if ((await fulfillPaidOrder(orderId)).delivered) return { done: true }
                        continue
                    }
                    failure = 'supplier_duplicate_card'
                }
            }
        } catch { /* No raw supplier errors: they can contain credentials or card values. */ }
        await db.update(supplierRequests).set({ error: failure, leaseToken: null, leaseUntil: null })
            .where(and(eq(supplierRequests.requestId, pending.requestId), eq(supplierRequests.leaseToken, token)))
        return { done: false, error: failure }
    }
    await recalcProductAggregates(order.productId)
    invalidateInventory(order.productId)
    return { done: (await fulfillPaidOrder(orderId)).delivered, error: 'supplier_waiting_for_cards' }
}
