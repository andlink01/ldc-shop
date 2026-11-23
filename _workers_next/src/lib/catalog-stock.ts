import { INFINITE_STOCK } from './constants'

type CatalogProduct = {
    id: string
    isShared?: boolean | null
    isOnDemand?: number
    groupOnDemand?: boolean
    allVariantIds?: string[]
    sharedVariantIds?: string[]
}

type CardStats = { unused: number; available: number; locked: number }

// Catalog availability includes procurement; inventory APIs continue to count real cards.
export function getCatalogStock(product: CatalogProduct, stats: ReadonlyMap<string, CardStats>): number {
    if (product.isOnDemand || product.groupOnDemand) return INFINITE_STOCK
    const grouped = (product.allVariantIds?.length || 0) > 1
    const ids = grouped ? product.allVariantIds! : [product.id]
    let total = 0
    for (const id of ids) {
        const stat = stats.get(id)
        if (!stat) continue
        const shared = grouped ? product.sharedVariantIds?.includes(id) : product.isShared
        if (shared && stat.unused > 0) return INFINITE_STOCK
        total += shared ? 0 : stat.available + stat.locked
    }
    return total
}
