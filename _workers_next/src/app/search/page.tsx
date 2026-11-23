import { searchActiveProducts, getCategories, getLiveCardStats } from "@/lib/db/queries"
import { SearchContent } from "@/components/search-content"
import { unstable_noStore } from "next/cache"
import { auth } from "@/lib/auth"
import { getCatalogStock } from "@/lib/catalog-stock"

function firstParam(value: string | string[] | undefined): string | undefined {
  if (!value) return undefined
  return Array.isArray(value) ? value[0] : value
}

function parseIntParam(value: unknown, fallback: number) {
  const num = typeof value === 'string' ? Number.parseInt(value, 10) : NaN
  return Number.isFinite(num) && num > 0 ? num : fallback
}

export default async function SearchPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  unstable_noStore()
  const searchParams = await props.searchParams
  const q = (firstParam(searchParams.q) || '').trim()
  const category = (firstParam(searchParams.category) || 'all').trim()
  const sort = (firstParam(searchParams.sort) || 'default').trim()
  const page = parseIntParam(firstParam(searchParams.page), 1)
  const pageSize = Math.min(parseIntParam(firstParam(searchParams.pageSize), 24), 60)

  const session = await auth()
  const isLoggedIn = !!session?.user
  const trustLevel = Number.isFinite(Number(session?.user?.trustLevel)) ? Number(session?.user?.trustLevel) : 0

  const [result, categories] = await Promise.all([
    searchActiveProducts({ q, category, sort, page, pageSize, isLoggedIn, trustLevel }),
    getCategories(),
  ])

  const allSearchIds = result.items.flatMap((p) => p.allVariantIds && (p.allVariantIds?.length || 0) > 1 ? p.allVariantIds : [p.id])
  const liveStats = await getLiveCardStats(allSearchIds).catch(() => new Map())

  return (
    <SearchContent
      q={q}
      category={category}
      sort={sort}
      page={result.page}
      pageSize={result.pageSize}
      total={result.total}
      products={result.items.map((p) => {
        const isGroup = p.allVariantIds && (p.allVariantIds?.length || 0) > 1
        return {
          id: p.id,
          name: p.name,
          description: p.description,
          price: p.price,
          compareAtPrice: p.compareAtPrice ?? null,
          image: p.image,
          category: p.category,
          isHot: isGroup ? (p.groupHot || false) : (p.isHot ?? false),
          stockCount: getCatalogStock(p, liveStats),
          onDemand: Boolean(p.isOnDemand || p.groupOnDemand),
          soldCount: isGroup ? (p.totalSold || 0) : (p.sold || 0)
        }
      })}
      categories={categories.map((c) => ({ name: c.name, icon: c.icon, sortOrder: c.sortOrder }))}
    />
  )
}
