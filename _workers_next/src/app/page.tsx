import { getActiveProductCategories, getCategories, getActiveProducts, getVisitorCount, getUserPendingOrders, getLiveCardStats } from "@/lib/db/queries";
import { getActiveAnnouncement } from "@/actions/settings";
import { getStorefrontSession, getStorefrontSettings } from "@/lib/storefront";
import { HomeContent } from "@/components/home-content";
import { getCatalogStock } from "@/lib/catalog-stock";

const PAGE_SIZE = 24;

function stripMarkdown(input: string): string {
  return input
    .replace(/!\[.*?\]\(.*?\)/g, '')
    .replace(/\[(.*?)\]\(.*?\)/g, '$1')
    .replace(/[`*_>#+-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export default async function Home({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  const resolved = searchParams ? await searchParams : {}
  const q = (typeof resolved.q === 'string' ? resolved.q : '').trim();
  const categoryParam = (typeof resolved.category === 'string' ? resolved.category : '').trim();
  const category = categoryParam && categoryParam !== 'all' ? categoryParam : '';
  const sort = (typeof resolved.sort === 'string' ? resolved.sort : 'default').trim();
  const page = Math.max(1, Number.parseInt(typeof resolved.page === 'string' ? resolved.page : '1', 10) || 1);

  const session = await getStorefrontSession()
  const isLoggedIn = !!session?.user
  const trustLevel = Number.isFinite(Number(session?.user?.trustLevel)) ? Number(session?.user?.trustLevel) : 0

  // Run all independent queries in parallel for better performance
  const productsPromise = getActiveProducts({ isLoggedIn, trustLevel }).catch(() => []);
  const [products, liveStats, announcement, visitorCount, categoryConfig, productCategories, storefront, pendingOrders] = await Promise.all([
    productsPromise,
    productsPromise.then(products => getLiveCardStats(products.flatMap(p =>
      p.allVariantIds && p.allVariantIds.length > 1 ? p.allVariantIds : [p.id]
    )).catch(() => new Map())),
    getActiveAnnouncement().catch(() => null),
    getVisitorCount().catch(() => 0),
    getCategories().catch(() => []),
    getActiveProductCategories({ isLoggedIn, trustLevel }).catch(() => []),
    getStorefrontSettings().catch(() => null),
    session?.user?.id ? getUserPendingOrders(session.user.id).catch(() => []) : Promise.resolve([]),
  ]);


  const total = products.length;

  const productsWithRatings = products.map((p) => {
    const isGroup = p.allVariantIds && (p.allVariantIds?.length || 0) > 1;

    return {
      id: p.id,
      name: p.name,
      price: p.price,
      compareAtPrice: p.compareAtPrice,
      image: p.image,
      category: p.category,
      variantCount: p.variantCount,
      priceMin: p.priceMin,
      priceMax: p.priceMax,
      stockCount: getCatalogStock(p, liveStats),
      onDemand: Boolean(p.isOnDemand || p.groupOnDemand),
      soldCount: isGroup ? (p.totalSold || 0) : (p.sold || 0),
      isHot: isGroup ? (p.groupHot || false) : p.isHot,
      descriptionPlain: stripMarkdown(p.description || ''),
      rating: isGroup ? Number(p.avgRating || 0) : Number(p.rating || 0),
      reviewCount: isGroup ? Number(p.totalReviewCount || 0) : Number(p.reviewCount || 0)
    };
  });

  const categoryNames = categoryConfig
    .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0))
    .map((c) => c.name);
  const extraCategories = productCategories.filter((c) => !categoryNames.includes(c)).sort();
  const categories = [...categoryNames, ...extraCategories];

  return <HomeContent
    products={productsWithRatings}
    announcement={announcement}
    visitorCount={visitorCount}
    categories={categories}
    categoryConfig={categoryConfig}
    pendingOrders={pendingOrders}
    wishlistEnabled={storefront?.wishlist_enabled === 'true'}
    isLoggedIn={isLoggedIn}
    checkinEnabled={storefront?.checkin_enabled !== 'false'}
    filters={{ q, category: category || null, sort }}
    pagination={{ page, pageSize: PAGE_SIZE, total }}
  />;
}
