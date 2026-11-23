import { checkAdmin } from '@/actions/admin'
import { db } from '@/lib/db'
import { inventoryApiKeys, inventoryApiRequests, products } from '@/lib/db/schema'
import { ensureDatabaseInitialized, getSetting } from '@/lib/db/queries'
import { and, asc, desc, eq, gte, sql } from 'drizzle-orm'
import { InventoryApiContent } from '@/components/admin/inventory-api-content'

export const dynamic = 'force-dynamic'

export default async function InventoryApiPage({ searchParams }: { searchParams: Promise<{ page?: string; key?: string; status?: string }> }) {
    await checkAdmin()
    await ensureDatabaseInitialized()
    const params = await searchParams
    const page = Math.min(10000, Math.max(1, Number.parseInt(params.page || '1') || 1))
    const keys = await db.select({ id: inventoryApiKeys.id, name: inventoryApiKeys.name, prefix: inventoryApiKeys.tokenPrefix,
        recoverable: sql<number>`CASE WHEN ${inventoryApiKeys.tokenEncrypted} IS NOT NULL THEN 1 ELSE 0 END`,
        productIds: inventoryApiKeys.productIds, canRead: inventoryApiKeys.canRead, canWrite: inventoryApiKeys.canWrite,
        enabled: inventoryApiKeys.isEnabled, expiresAt: inventoryApiKeys.expiresAt, lastUsedAt: inventoryApiKeys.lastUsedAt,
    }).from(inventoryApiKeys).orderBy(desc(inventoryApiKeys.createdAt)).limit(200)
    const productList = await db.select({ id: products.id, name: products.name }).from(products).orderBy(asc(products.name)).limit(1000)
    const filter = and(params.key ? eq(inventoryApiRequests.keyId, params.key) : undefined,
        params.status === 'error' ? gte(inventoryApiRequests.status, 400) : params.status === 'success' ? sql`${inventoryApiRequests.status} < 400` : undefined)
    const logs = await db.select().from(inventoryApiRequests).where(filter).orderBy(desc(inventoryApiRequests.createdAt), desc(inventoryApiRequests.id)).limit(51).offset((page - 1) * 50)
    return <InventoryApiContent keysData={keys.map(k => ({ ...k, recoverable: Boolean(k.recoverable), expiresAt: k.expiresAt?.getTime() || null, lastUsedAt: k.lastUsedAt?.getTime() || null }))}
        products={productList} logs={logs.slice(0, 50).map(l => ({ ...l, createdAt: l.createdAt.getTime() }))}
        page={page} hasNext={logs.length > 50} keyFilter={params.key || ''} statusFilter={params.status || ''}
        alertMinutes={Number(await getSetting('expiry_alert_minutes') ?? 60)} />
}
