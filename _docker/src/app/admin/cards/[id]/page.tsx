import { db } from '@/lib/db'
import { cards } from '@/lib/db/schema'
import { desc, sql } from 'drizzle-orm'
import { getProductForAdmin, ensureDatabaseInitialized } from '@/lib/db/queries'
import { notFound } from 'next/navigation'
import { CardsContent } from '@/components/admin/cards-content'
import { getProductCardApiConfig } from '@/lib/card-api'
import { checkAdmin } from '@/actions/admin'
import { RESERVATION_TTL_MS } from '@/lib/constants'

export default async function CardsPage({ params }: { params: Promise<{ id: string }> }) {
    await checkAdmin()
    await ensureDatabaseInitialized()
    const { id } = await params
    const product = await getProductForAdmin(id)
    if (!product) return notFound()
    const apiConfig = await getProductCardApiConfig(id)
    const now = Date.now()
    const unusedCards = await db.select({ id: cards.id, cardKey: cards.cardKey, expiresAt: cards.expiresAt,
        createdAt: cards.createdAt,
        locked: sql<number>`CASE WHEN ${cards.reservedAt} >= ${now - RESERVATION_TTL_MS} OR EXISTS
            (SELECT 1 FROM orders holding WHERE holding.order_id = ${cards.reservedOrderId} AND holding.status = 'paid') THEN 1 ELSE 0 END`,
    }).from(cards).where(sql`${cards.productId} = ${id} AND COALESCE(${cards.isUsed}, 0) = 0`).orderBy(desc(cards.createdAt))
    return <CardsContent snapshotAt={now} productId={id} productName={product.name} apiConfig={apiConfig} unusedCards={unusedCards.map(c => ({
        id: c.id, cardKey: c.cardKey, expiresAt: c.expiresAt?.getTime() || null,
        createdAt: c.createdAt?.getTime() || null, locked: Boolean(c.locked),
    }))} />
}
