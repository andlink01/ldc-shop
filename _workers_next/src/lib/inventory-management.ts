import { db, dbRun } from '@/lib/db'
import { inventoryApiKeys, products } from '@/lib/db/schema'
import { ensureDatabaseInitialized, recalcProductAggregates } from '@/lib/db/queries'
import { eq, inArray, sql } from 'drizzle-orm'
import { fulfillPendingOrders, invalidateInventory } from '@/lib/fulfillment'
import { scheduleInventoryEvents } from '@/lib/inventory-events'
import { RESERVATION_TTL_MS } from '@/lib/constants'
import { encryptInventoryToken, decryptInventoryToken, InventoryTokenError } from '@/lib/inventory-token'

export async function hashInventoryToken(token: string) {
    const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

export type InventoryKeyInput = { name: string; productIds: string[]; canRead: boolean; canWrite: boolean; expiresAt: string | null }

function generateInventoryToken() {
    return `ldc_inv_${Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('')}`
}

export async function createManagedInventoryKey(input: InventoryKeyInput, createdBy: string) {
    await ensureDatabaseInitialized()
    if (!input || typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 80
        || !Array.isArray(input.productIds) || input.productIds.length > 50
        || input.productIds.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(id))
        || typeof input.canRead !== 'boolean' || typeof input.canWrite !== 'boolean' || (!input.canRead && !input.canWrite)) throw new InventoryTokenError('inventory.keyInvalidSettings')
    const ids = Array.from(new Set(input.productIds))
    if (ids.length) {
        const found = await db.select({ id: products.id }).from(products).where(inArray(products.id, ids))
        if (found.length !== ids.length) throw new InventoryTokenError('inventory.keyProductMissing')
    }
    const expiry = input.expiresAt === null ? null : Date.parse(input.expiresAt)
    if (expiry !== null && (!Number.isFinite(expiry) || expiry <= Date.now())) throw new InventoryTokenError('inventory.keyExpiryInvalid')
    const id = crypto.randomUUID(), token = generateInventoryToken()
    const encrypted = await encryptInventoryToken(token, id)
    await db.insert(inventoryApiKeys).values({ id, name: input.name.trim(), tokenHash: await hashInventoryToken(token), tokenEncrypted: encrypted,
        tokenPrefix: token.slice(0, 16), productIds: JSON.stringify(ids), canRead: input.canRead, canWrite: input.canWrite,
        expiresAt: expiry === null ? null : new Date(expiry), createdAt: new Date(), createdBy })
    return { token }
}

export async function readManagedInventoryToken(id: string) {
    await ensureDatabaseInitialized()
    const key = await db.query.inventoryApiKeys.findFirst({ where: eq(inventoryApiKeys.id, id) })
    if (!key) throw new InventoryTokenError('inventory.keyNotFound')
    if (!key.tokenEncrypted) throw new InventoryTokenError('inventory.keyLegacyUnavailable')
    const token = await decryptInventoryToken(key.tokenEncrypted, id)
    if (await hashInventoryToken(token) !== key.tokenHash) throw new InventoryTokenError('inventory.keyDecryptFailed')
    return { token }
}

export async function resetManagedInventoryToken(id: string) {
    await ensureDatabaseInitialized()
    const token = generateInventoryToken()
    const encrypted = await encryptInventoryToken(token, id)
    const updated = await db.update(inventoryApiKeys).set({ tokenHash: await hashInventoryToken(token), tokenEncrypted: encrypted,
        tokenPrefix: token.slice(0, 16), lastUsedAt: null }).where(eq(inventoryApiKeys.id, id)).returning({ id: inventoryApiKeys.id })
    if (!updated.length) throw new InventoryTokenError('inventory.keyNotFound')
    return { token }
}

export async function deleteManagedInventoryKey(id: string) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(id)) throw new InventoryTokenError('inventory.keyNotFound')
    await ensureDatabaseInitialized()
    // The foreign key clears request.key_id while keeping audit records. Import receipts are independent of the key row.
    const removed = await db.delete(inventoryApiKeys).where(eq(inventoryApiKeys.id, id)).returning({ id: inventoryApiKeys.id })
    if (!removed.length) throw new InventoryTokenError('inventory.keyNotFound')
}

export async function recoverAfterRestock(productId: string) {
    // A committed import must remain a success even if background recovery fails.
    try { await fulfillPendingOrders(productId) } catch { console.error('[inventory] recovery deferred to maintenance') }
    try { await recalcProductAggregates(productId) } catch { console.error('[inventory] aggregate refresh deferred') }
    invalidateInventory(productId)
    scheduleInventoryEvents()
}

export async function changeCardExpiry(productId: string, cardIds: number[], expiresAt: string | null) {
    await ensureDatabaseInitialized()
    if (typeof productId !== 'string' || !productId || !Array.isArray(cardIds) || !cardIds.length || cardIds.length > 500
        || cardIds.some(id => !Number.isSafeInteger(id) || id < 1)) throw new Error('Invalid card selection')
    const ids = Array.from(new Set(cardIds)), list = ids.join(',')
    const expiry = expiresAt === null ? null : Date.parse(expiresAt)
    if (expiry !== null && (!Number.isFinite(expiry) || expiry <= Date.now())) throw new Error('Invalid expiry')
    const cutoff = Date.now() - RESERVATION_TTL_MS
    // The count guard makes the entire selection succeed or leave every row unchanged.
    const changed = await dbRun<{ id: number }>(sql`UPDATE cards SET expires_at = ${expiry}
        WHERE product_id = ${productId} AND instr(',' || ${list} || ',', ',' || id || ',') > 0
        AND (SELECT COUNT(*) FROM cards selected WHERE selected.product_id = ${productId}
            AND instr(',' || ${list} || ',', ',' || selected.id || ',') > 0 AND COALESCE(selected.is_used, 0) = 0
            AND (selected.reserved_at IS NULL OR selected.reserved_at < ${cutoff})
            AND NOT EXISTS (SELECT 1 FROM orders holding WHERE holding.order_id = selected.reserved_order_id AND holding.status = 'paid')) = ${ids.length}
        RETURNING id`)
    if (changed.results.length !== ids.length) throw new Error('Selection contains used, locked or missing cards')
    await recoverAfterRestock(productId)
    return { changed: changed.results.length }
}

export async function deleteUnconsumedCards(cardIds: number[]) {
    await ensureDatabaseInitialized()
    if (!Array.isArray(cardIds) || !cardIds.length || cardIds.length > 500 || cardIds.some(id => !Number.isSafeInteger(id) || id < 1)) throw new Error('Invalid card selection')
    const ids = Array.from(new Set(cardIds)), list = ids.join(','), cutoff = Date.now() - RESERVATION_TTL_MS
    const removed = await dbRun<{ product_id: string }>(sql`DELETE FROM cards WHERE instr(',' || ${list} || ',', ',' || id || ',') > 0
        AND (SELECT COUNT(*) FROM cards selected WHERE instr(',' || ${list} || ',', ',' || selected.id || ',') > 0
            AND COALESCE(selected.is_used, 0) = 0 AND (selected.reserved_at IS NULL OR selected.reserved_at < ${cutoff})
            AND NOT EXISTS (SELECT 1 FROM orders holding WHERE holding.order_id = selected.reserved_order_id AND holding.status = 'paid')) = ${ids.length}
        RETURNING product_id`)
    if (removed.results.length !== ids.length) throw new Error('Selection contains used, locked or missing cards')
    for (const id of new Set(removed.results.map(row => row.product_id))) {
        await recalcProductAggregates(id)
        invalidateInventory(id)
    }
}
