import { getErrorText } from '@/lib/errors'
import { recoverAfterRestock } from '@/lib/inventory-management'
import { db, dbBatchRaw } from "@/lib/db"
import { cards, settings, products } from "@/lib/db/schema"
import { ensureDatabaseInitialized } from "@/lib/db/queries"
import { inArray, eq } from "drizzle-orm"
import { CardApiConfigError, validateCardApiConfig } from './card-api-validation'

export interface ProductCardApiConfig {
    enabled: boolean
    url: string
    token: string
    mode: 'stock' | 'on_demand'
}

function keyOf(productId: string, field: "enabled" | "url" | "token" | "mode") {
    return `cards_api_${field}_${productId}`
}

function resolveApiUrl(rawUrl: string): string {
    const trimmed = rawUrl.trim()
    if (!trimmed) return ""
    return new URL(trimmed).toString()
}

function extractCardKey(payload: unknown): string {
    if (!payload) return ""
    if (typeof payload === "string") return payload.trim()

    if (Array.isArray(payload)) {
        for (const item of payload) {
            const value = extractCardKey(item)
            if (value) return value
        }
        return ""
    }

    if (typeof payload === "object") {
        const record = payload as Record<string, unknown>
        const directKeys = ["cardKey", "card", "key", "code"]
        for (const k of directKeys) {
            const v = record[k]
            if (typeof v === "string" && v.trim()) return v.trim()
        }

        const nestedKeys = ["data", "result", "item"]
        for (const k of nestedKeys) {
            const value = extractCardKey(record[k])
            if (value) return value
        }
    }

    return ""
}

function isUniqueConstraintError(error: unknown) {
    const text = getErrorText(error).toLowerCase()
    return text.includes('unique constraint') || text.includes('constraint_unique')
}

async function getSettingsUncached(keys: string[]): Promise<Record<string, string>> {
    try {
        const rows = await db.select({ key: settings.key, value: settings.value })
            .from(settings)
            .where(inArray(settings.key, keys))

        const map: Record<string, string> = {}
        for (const row of rows) {
            map[row.key] = row.value || ""
        }
        return map
    } catch (error) {
        const text = getErrorText(error).toLowerCase()
        if (text.includes("no such table") && text.includes("settings")) {
            return {}
        }
        throw error
    }
}

export async function getProductCardApiConfig(productId: string): Promise<ProductCardApiConfig> {
    const enabledKey = keyOf(productId, "enabled")
    const urlKey = keyOf(productId, "url")
    const tokenKey = keyOf(productId, "token")
    const values = await getSettingsUncached([enabledKey, urlKey, tokenKey, keyOf(productId, 'mode')])

    return {
        enabled: values[enabledKey] === "true",
        url: (values[urlKey] || "").trim(),
        token: (values[tokenKey] || "").trim(),
        mode: values[keyOf(productId, 'mode')] === 'on_demand' ? 'on_demand' : 'stock',
    }
}

export async function saveProductCardApiConfig(productId: string, config: Omit<ProductCardApiConfig, 'mode'> & { mode?: 'stock' | 'on_demand' }) {
    await ensureDatabaseInitialized()
    const url = config.url.trim()
    const token = config.token.trim()
    const enabled = !!config.enabled

    const mode = config.mode ?? 'stock'
    const error = validateCardApiConfig({ enabled, url, token, mode })
    if (error) throw new CardApiConfigError(error)
    const product = await db.query.products.findFirst({ where: eq(products.id, productId), columns: { isShared: true } })
    if (!product) throw new CardApiConfigError('admin.cards.apiProductMissing')
    if (mode === 'on_demand' && product.isShared) throw new CardApiConfigError('admin.cards.apiSharedUnsupported')
    await dbBatchRaw(([
        ['enabled', enabled ? 'true' : 'false'], ['url', url], ['token', token], ['mode', mode],
    ] as const).map(([field, value]) => ({
        sql: 'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
        params: [keyOf(productId, field), value, Date.now()],
    })))
    await recoverAfterRestock(productId)
}

export async function pullOneCardFromApi(productId: string): Promise<{
    ok: boolean
    skipped?: boolean
    error?: string
    cardKey?: string
}> {
    const config = await getProductCardApiConfig(productId)
    if (config.mode === 'on_demand') return { ok: false, skipped: true, error: 'on_demand_uses_paid_orders' }
    if (!config.enabled) {
        return { ok: false, skipped: true, error: "api_disabled" }
    }
    if (!config.url) {
        return { ok: false, error: "api_url_missing" }
    }

    let requestUrl = ""
    try {
        requestUrl = resolveApiUrl(config.url)
    } catch {
        return { ok: false, error: "api_url_invalid" }
    }

    const headers: Record<string, string> = {
        Accept: "application/json, text/plain;q=0.9, */*;q=0.8",
    }
    if (config.token) {
        headers.Authorization = `Bearer ${config.token}`
    }

    let response: Response
    try {
        response = await fetch(requestUrl, {
            method: "GET",
            headers,
            cache: "no-store", signal: AbortSignal.timeout(15000), redirect: "manual",
        })
    } catch (error) {
        const name = error !== null && typeof error === 'object' && 'name' in error ? error.name : ''
        return { ok: false, error: name === 'TimeoutError' || name === 'AbortError' ? 'api_timeout' : 'api_network_error' }
    }

    if (!response.ok) {
        return { ok: false, error: `api_request_failed_${response.status}` }
    }

    const contentType = (response.headers.get("content-type") || "").toLowerCase()

    let payload: unknown
    try {
        payload = contentType.includes("application/json") ? await response.json() : await response.text()
    } catch { return { ok: false, error: 'api_invalid_response' } }

    const cardKey = extractCardKey(payload)
    if (!cardKey) {
        return { ok: false, error: "api_card_missing" }
    }

    try {
        await db.insert(cards).values({
            productId,
            cardKey,
        })
    } catch (error) {
        if (isUniqueConstraintError(error)) {
            return { ok: false, error: "api_card_duplicate" }
        }
        return { ok: false, error: "api_insert_failed" }
    }

    await recoverAfterRestock(productId)
    return { ok: true, cardKey }
}
