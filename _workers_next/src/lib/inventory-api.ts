import { db, dbBatchRaw } from '@/lib/db'
import { inventoryImports, inventoryApiKeys, inventoryApiRequests, products } from '@/lib/db/schema'
import { ensureDatabaseInitialized, getLiveCardStats, onDemandProductCondition } from '@/lib/db/queries'
import { and, asc, eq, gt, like, inArray, sql } from 'drizzle-orm'
import { hashInventoryToken, recoverAfterRestock } from '@/lib/inventory-management'
import { revalidatePath, revalidateTag } from 'next/cache'
import type { SqlStatement } from '@/lib/db/contracts'
import { INFINITE_STOCK, RESERVATION_TTL_MS } from '@/lib/constants'

const MAX_BODY_BYTES = 256 * 1024
const MAX_CARDS = 500
const PRODUCT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,200}$/
type ProductContext = { params: Promise<{ productId: string }> }
type ImportPayload = { cards: string[]; expiresAt: number | null; expiresInSeconds: number | null }
type ApiAccess = { keyId: string | null; productIds: string[]; canRead: boolean; canWrite: boolean }

class ApiError extends Error {
    constructor(public status: number, public code: string, public keyId?: string) { super(code) }
}

function json(data: unknown, status = 200): Response {
    return Response.json(data, {
        status,
        headers: { 'Cache-Control': 'no-store', Vary: 'Authorization' },
    })
}

function errorResponse(error: unknown): Response {
    if (error instanceof ApiError) return json({ success: false, error: error.code }, error.status)
    // Database errors can include card values, so do not log their raw payloads.
    console.error('[inventory-api] operation failed')
    return json({ success: false, error: 'internal_error' }, 500)
}

async function digest(value: string): Promise<Uint8Array> {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
}

async function authenticate(request: Request): Promise<ApiAccess> {
    const configured = process.env.INVENTORY_API_KEY || ''
    const supplied = request.headers.get('authorization')?.match(/^Bearer ([^\s]{1,512})$/i)?.[1]
    if (supplied?.startsWith('ldc_inv_')) {
        await ensureDatabaseInitialized()
        const key = await db.query.inventoryApiKeys.findFirst({ where: eq(inventoryApiKeys.tokenHash, await hashInventoryToken(supplied)) })
        if (!key) throw new ApiError(401, 'unauthorized')
        if (!key.isEnabled || (key.expiresAt && key.expiresAt.getTime() <= Date.now())) throw new ApiError(401, 'key_disabled_or_expired', key.id)
        let ids: unknown
        try { ids = JSON.parse(key.productIds) } catch { throw new ApiError(403, 'invalid_key_scope', key.id) }
        if (!Array.isArray(ids) || ids.length > 50 || ids.some(id => typeof id !== 'string' || !PRODUCT_ID_PATTERN.test(id))) throw new ApiError(403, 'invalid_key_scope', key.id)
        await db.update(inventoryApiKeys).set({ lastUsedAt: new Date() }).where(eq(inventoryApiKeys.id, key.id))
        return { keyId: key.id, productIds: ids as string[], canRead: key.canRead, canWrite: key.canWrite }
    }
    if (!/^[^\s]{32,512}$/.test(configured)) throw new ApiError(503, 'api_not_configured')
    if (!supplied) throw new ApiError(401, 'unauthorized')
    const [expectedHash, suppliedHash] = await Promise.all([digest(configured), digest(supplied)])
    let difference = 0
    for (let i = 0; i < expectedHash.length; i++) difference |= expectedHash[i] ^ suppliedHash[i]
    if (difference !== 0) throw new ApiError(401, 'unauthorized')
    return { keyId: null, productIds: [], canRead: true, canWrite: true }
}

function authorize(access: ApiAccess, write: boolean, productId?: string) {
    if ((write && !access.canWrite) || (!write && !access.canRead)) throw new ApiError(403, 'permission_denied')
    if (productId && access.productIds.length && !access.productIds.includes(productId)) throw new ApiError(403, 'product_forbidden')
}

async function runApi(request: Request, action: string, context: ProductContext | undefined, operation: (access: ApiAccess) => Promise<Response>) {
    const started = Date.now()
    let access: ApiAccess | undefined, response: Response
    try { access = await authenticate(request); response = await operation(access) }
    catch (error) {
        if (error instanceof ApiError && error.keyId) access = { keyId: error.keyId, productIds: [], canRead: false, canWrite: false }
        response = errorResponse(error)
    }
    if (access) {
        try {
            await ensureDatabaseInitialized()
            const payload = await response.clone().json()
            const id = context ? (await context.params).productId : null
            const idempotency = request.headers.get('idempotency-key')
            await db.insert(inventoryApiRequests).values({ id: crypto.randomUUID(), keyId: access.keyId, action,
                productId: id && PRODUCT_ID_PATTERN.test(id) ? id : null, method: request.method, status: response.status,
                addedCount: payload.data?.replayed ? 0 : payload.data?.added || 0, replayed: Boolean(payload.data?.replayed),
                idempotencyKey: idempotency && /^[a-zA-Z0-9._:-]{1,128}$/.test(idempotency) ? idempotency : null,
                error: payload.error || null, durationMs: Date.now() - started, createdAt: new Date() })
        } catch { console.error('[inventory-api] request audit deferred') }
    }
    return response
}

async function readPayload(request: Request): Promise<ImportPayload> {
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) {
        throw new ApiError(415, 'json_required')
    }
    if (Number(request.headers.get('content-length')) > MAX_BODY_BYTES) throw new ApiError(413, 'body_too_large')
    if (!request.body) throw new ApiError(400, 'invalid_json')
    const reader = request.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
        while (true) {
            const { value, done } = await reader.read()
            if (done) break
            size += value.byteLength
            if (size > MAX_BODY_BYTES) {
                await reader.cancel()
                throw new ApiError(413, 'body_too_large')
            }
            chunks.push(value)
        }
    } finally {
        reader.releaseLock()
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    let body: unknown
    try {
        body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    } catch { throw new ApiError(400, 'invalid_json') }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'invalid_body')
    const input = body as Record<string, unknown>
    if (!Array.isArray(input.cards) || input.cards.length < 1 || input.cards.length > MAX_CARDS) {
        throw new ApiError(400, 'cards_must_contain_1_to_500_items')
    }
    const cards = input.cards.map((value: unknown) => {
        if (typeof value !== 'string' || !value.trim() || value.trim().length > 4096 || value.includes('\0')) {
            throw new ApiError(400, 'invalid_card')
        }
        return value.trim()
    })
    let expiresAt: number | null = null
    if (input.expiresAt !== undefined && input.expiresAt !== null) {
        if (typeof input.expiresAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(input.expiresAt)) {
            throw new ApiError(400, 'invalid_expiry')
        }
        expiresAt = Date.parse(input.expiresAt)
        const calendarDate = input.expiresAt.slice(0, 10)
        const midnight = Date.parse(`${calendarDate}T00:00:00Z`)
        if (!Number.isFinite(expiresAt) || !Number.isFinite(midnight)
            || new Date(midnight).toISOString().slice(0, 10) !== calendarDate) throw new ApiError(400, 'invalid_expiry')
    }
    let expiresInSeconds: number | null = null
    if (input.expiresInSeconds !== undefined && input.expiresInSeconds !== null) {
        if (expiresAt !== null || typeof input.expiresInSeconds !== 'number' || !Number.isInteger(input.expiresInSeconds)
            || input.expiresInSeconds < 1 || input.expiresInSeconds > 31_536_000) {
            throw new ApiError(400, 'invalid_expiry')
        }
        expiresInSeconds = input.expiresInSeconds
    }
    return { cards, expiresAt, expiresInSeconds }
}

async function findProduct(context: ProductContext, access: ApiAccess, write = false) {
    const { productId } = await context.params
    if (!PRODUCT_ID_PATTERN.test(productId)) throw new ApiError(400, 'invalid_product_id')
    authorize(access, write, productId)
    await ensureDatabaseInitialized()
    const product = await db.query.products.findFirst({
        where: eq(products.id, productId),
        columns: { id: true, name: true, price: true, isActive: true, isShared: true, variantGroupId: true, variantLabel: true },
    })
    if (!product) throw new ApiError(404, 'product_not_found')
    const mode = await db.select({ enabled: sql<number>`CASE WHEN ${onDemandProductCondition()} THEN 1 ELSE 0 END` }).from(products).where(eq(products.id, productId)).limit(1)
    return { ...product, fulfillmentMode: mode[0]?.enabled ? 'on_demand' : 'stock' }
}

export async function listInventoryProducts(request: Request): Promise<Response> {
    return runApi(request, 'list_products', undefined, async access => {
        authorize(access, false)
        const url = new URL(request.url)
        const limit = Number(url.searchParams.get('limit') || 50)
        const cursor = url.searchParams.get('cursor') || ''
        const search = (url.searchParams.get('q') || '').trim()
        if (!Number.isInteger(limit) || limit < 1 || limit > 200 || search.length > 100 || (cursor && !PRODUCT_ID_PATTERN.test(cursor))) {
            throw new ApiError(400, 'invalid_pagination')
        }
        await ensureDatabaseInitialized()
        const rows = await db.select({
            id: products.id, name: products.name, price: products.price,
            isActive: products.isActive, isShared: products.isShared,
            variantGroupId: products.variantGroupId, variantLabel: products.variantLabel,
            onDemand: sql<number>`CASE WHEN ${onDemandProductCondition()} THEN 1 ELSE 0 END`,
        }).from(products).where(and(
            access.productIds.length ? inArray(products.id, access.productIds) : undefined,
            cursor ? gt(products.id, cursor) : undefined,
            search ? like(products.name, `%${search}%`) : undefined,
        )).orderBy(asc(products.id)).limit(limit + 1)
        const items = rows.slice(0, limit)
        const stats = await getLiveCardStats(items.map((product) => product.id))
        return json({ success: true, data: {
            products: items.map(({ onDemand, ...product }) => ({ ...product, fulfillmentMode: onDemand ? 'on_demand' : 'stock', stock: stats.get(product.id) || { unused: 0, available: 0, locked: 0 } })),
            nextCursor: rows.length > limit ? items[items.length - 1].id : null,
        } })
    })
}

export async function getInventoryStock(request: Request, context: ProductContext): Promise<Response> {
    return runApi(request, 'get_stock', context, async access => {
        const product = await findProduct(context, access)
        const stats = await getLiveCardStats([product.id])
        return json({ success: true, data: { ...product, stock: stats.get(product.id) || { unused: 0, available: 0, locked: 0 } } })
    })
}

function invalidateStock(productId: string) {
    try {
        for (const pathname of ['/', '/search', '/admin/products', '/admin/settings', `/buy/${productId}`, `/admin/cards/${productId}`]) {
            revalidatePath(pathname)
        }
        revalidateTag('home:products', { expire: 0 })
        revalidateTag('home:product-categories', { expire: 0 })
    } catch {
        console.error('[inventory-api] stock cache invalidation failed')
    }
}

export async function addInventoryCards(request: Request, context: ProductContext): Promise<Response> {
    return runApi(request, 'add_cards', context, async access => {
        const product = await findProduct(context, access, true)
        const payload = await readPayload(request)
        const idempotencyKey = request.headers.get('idempotency-key') ?? crypto.randomUUID()
        if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(idempotencyKey)) throw new ApiError(400, 'invalid_idempotency_key')
        const receiptKey = access.keyId ? `${access.keyId}:${idempotencyKey}` : idempotencyKey
        const hash = await digest(JSON.stringify({ productId: product.id, ...payload }))
        const payloadHash = Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('')
        const receipt = () => db.query.inventoryImports.findFirst({ where: eq(inventoryImports.idempotencyKey, receiptKey) })
        const reply = async (saved: { payloadHash: string; importedCount: number }, replayed: boolean) => {
            if (saved.payloadHash !== payloadHash) throw new ApiError(409, 'idempotency_conflict')
            invalidateStock(product.id)
            await recoverAfterRestock(product.id)
            return json({ success: true, data: {
                productId: product.id, productName: product.name,
                added: saved.importedCount, idempotencyKey, replayed,
            } }, replayed ? 200 : 201)
        }
        const existing = await receipt()
        if (existing) return reply(existing, true)

        const now = Date.now()
        const expiresAt = payload.expiresInSeconds === null ? payload.expiresAt : now + payload.expiresInSeconds * 1000
        if (expiresAt !== null && expiresAt <= now) throw new ApiError(400, 'invalid_expiry')
        const statements: SqlStatement[] = [{
            sql: 'INSERT INTO inventory_imports (idempotency_key, product_id, payload_hash, imported_count, created_at) VALUES (?, ?, ?, ?, ?)',
            params: [receiptKey, product.id, payloadHash, payload.cards.length, now],
        }]
        // Twenty rows use eighty parameters, within D1's per-statement binding limit.
        for (let offset = 0; offset < payload.cards.length; offset += 20) {
            const batch = payload.cards.slice(offset, offset + 20)
            statements.push({
                sql: `INSERT INTO cards (product_id, card_key, expires_at, created_at) VALUES ${batch.map(() => '(?, ?, ?, ?)').join(', ')}`,
                params: batch.flatMap((card) => [product.id, card, expiresAt, now]),
            })
        }
        // Receipt, cards, and the aggregate stock change are one transaction.
        statements.push({
            sql: `UPDATE products SET
                stock_count = CASE WHEN COALESCE(is_shared, 0) = 1 THEN
                    CASE WHEN EXISTS (SELECT 1 FROM cards WHERE product_id = products.id
                        AND COALESCE(is_used, 0) = 0 AND (expires_at IS NULL OR expires_at > ?)) THEN ? ELSE 0 END
                    ELSE (SELECT COUNT(*) FROM cards WHERE product_id = products.id AND COALESCE(is_used, 0) = 0
                        AND (expires_at IS NULL OR expires_at > ?) AND (reserved_at IS NULL OR reserved_at < ?)) END,
                locked_count = (SELECT COUNT(*) FROM cards WHERE product_id = products.id AND COALESCE(is_used, 0) = 0
                    AND (expires_at IS NULL OR expires_at > ?) AND reserved_at IS NOT NULL AND reserved_at >= ?)
                WHERE id = ?`,
            params: [now, INFINITE_STOCK, now, now - RESERVATION_TTL_MS, now, now - RESERVATION_TTL_MS, product.id],
        })
        try {
            await dbBatchRaw(statements)
        } catch {
            // A concurrent retry may have won the unique receipt insert.
            const concurrent = await receipt()
            if (concurrent) return reply(concurrent, true)
            throw new ApiError(500, 'import_failed')
        }
        return reply({ payloadHash, importedCount: payload.cards.length }, false)
    })
}
