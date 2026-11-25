'use server'

import { auth } from "@/lib/auth"
import { canUserReview, getProductReviews, getProductRating, ensureDatabaseInitialized } from "@/lib/db/queries"
import { getEmailSettings } from "@/lib/email"
import { db } from '@/lib/db'
import { products, loginUsers } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { validatePurchaseAnswers } from '@/lib/purchase-questions'

export async function verifyPurchaseAnswers(productId: string, answers?: unknown) {
    const session = await auth()
    if (!session?.user?.id) return { success: false, error: 'common.loginRequired' }
    if (typeof productId !== 'string' || !productId.trim()) return { success: false, error: 'buy.productNotFound' }
    try {
        await ensureDatabaseInitialized()
        const product = await db.query.products.findFirst({ where: eq(products.id, productId),
            columns: { isActive: true, visibilityLevel: true, purchaseQuestions: true } })
        if (!product || product.isActive === false) return { success: false, error: 'buy.productNotFound' }
        const trustLevel = Math.max(0, Number.isFinite(Number(session.user.trustLevel)) ? Number(session.user.trustLevel) : 0)
        if (Number(product.visibilityLevel ?? -1) > trustLevel) return { success: false, error: 'buy.visibilityDenied' }
        const user = await db.query.loginUsers.findFirst({ where: eq(loginUsers.userId, session.user.id), columns: { isBlocked: true } })
        if (user?.isBlocked) return { success: false, error: 'buy.userBlocked' }
        const error = validatePurchaseAnswers(product.purchaseQuestions, answers)
        return error ? { success: false, error } : { success: true }
    } catch { return { success: false, error: 'buy.questionsUnavailable' } }
}

interface BuyMetaReview {
    id: number
    username: string
    userId: string | null
    rating: number
    comment: string | null
    createdAt: string | null
    replies: Array<{
        id: number
        username: string
        userId: string | null
        comment: string
        createdAt: string | null
    }>
}

interface BuyPageMeta {
    reviews: BuyMetaReview[]
    averageRating: number
    reviewCount: number
    canReview: boolean
    reviewOrderId?: string
    emailConfigured: boolean
}

const EMPTY_BUY_META: BuyPageMeta = {
    reviews: [],
    averageRating: 0,
    reviewCount: 0,
    canReview: false,
    reviewOrderId: undefined,
    emailConfigured: false,
}

function toIsoString(value: Date | string | null): string | null {
    if (!value) return null
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

export async function getBuyPageMeta(productId: string): Promise<BuyPageMeta> {
    const id = productId.trim()
    if (!id) return { ...EMPTY_BUY_META }

    const session = await auth()

    const [rawReviews, rating, emailSettings] = await Promise.all([
        getProductReviews(id).catch(() => []),
        getProductRating(id).catch(() => null),
        getEmailSettings().catch(() => ({ apiKey: null, fromEmail: null, enabled: false, fromName: null })),
    ])

    const reviews: BuyMetaReview[] = rawReviews.map((review) => ({
        id: Number(review.id),
        username: review.username || "",
        userId: review.userId || null,
        rating: Number(review.rating || 0),
        comment: review.comment || null,
        createdAt: toIsoString(review.createdAt),
        replies: Array.isArray(review.replies)
            ? review.replies.map((reply) => ({
                id: Number(reply.id),
                username: reply.username || "",
                userId: reply.userId || null,
                comment: reply.comment || "",
                createdAt: toIsoString(reply.createdAt),
            }))
            : [],
    }))

    let canReview = false
    let reviewOrderId: string | undefined = undefined

    if (session?.user?.id) {
        try {
            const eligibility = await canUserReview(session.user.id, id)
            canReview = eligibility.canReview
            reviewOrderId = eligibility.orderId
        } catch {
            canReview = false
            reviewOrderId = undefined
        }
    }

    // The list is capped; totals are aggregated over every review.
    const reviewCount = rating ? Number(rating.count) : reviews.length
    const averageRating = rating ? Number(rating.average) : reviewCount > 0
        ? reviews.reduce((sum, review) => sum + review.rating, 0) / reviewCount
        : 0

    return {
        reviews,
        averageRating,
        reviewCount,
        canReview,
        reviewOrderId,
        emailConfigured: !!(emailSettings?.enabled && emailSettings?.apiKey && emailSettings?.fromEmail),
    }
}
