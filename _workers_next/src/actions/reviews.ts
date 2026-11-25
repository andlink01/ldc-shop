'use server'

import { auth } from '@/lib/auth'
import { createReview, createReviewReply } from '@/lib/db/queries'
import { db, dbRun } from '@/lib/db'
import { loginUsers, orders, reviews, reviewReplies } from '@/lib/db/schema'
import { and, eq, gt, sql } from 'drizzle-orm'
import { revalidatePath, updateTag } from 'next/cache'
import { oncePerIsolate } from '@/lib/once'
import { MAX_REVIEW_COMMENT_LENGTH, MAX_REVIEW_REPLIES_PER_WINDOW, USER_CONTENT_WINDOW_MS } from '@/lib/constants'
import { isOrderOwner } from '@/lib/order-access'

const ensureReviewsTable = oncePerIsolate(async () => {
    await dbRun(sql`
        CREATE TABLE IF NOT EXISTS reviews (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            product_id TEXT NOT NULL,
            order_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            username TEXT NOT NULL,
            rating INTEGER NOT NULL,
            comment TEXT,
            created_at INTEGER DEFAULT (unixepoch() * 1000)
        )
    `)
})

const ensureReviewRepliesTable = oncePerIsolate(async () => {
    await dbRun(sql`
        CREATE TABLE IF NOT EXISTS review_replies (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            review_id INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
            user_id TEXT NOT NULL,
            username TEXT NOT NULL,
            comment TEXT NOT NULL,
            created_at INTEGER DEFAULT (unixepoch() * 1000)
        )
    `)
})

async function isBlockedUser(userId: string) {
    const user = await db.query.loginUsers.findFirst({ where: eq(loginUsers.userId, userId), columns: { isBlocked: true } })
    return Boolean(user?.isBlocked)
}

export async function submitReview(
    productId: string,
    orderId: string,
    rating: number,
    comment: string
): Promise<{ success: boolean; error?: string }> {
    try {
        const session = await auth()
        if (!session?.user?.id) {
            return { success: false, error: 'review.authRequired' }
        }

        // Server Action arguments are untrusted: require a whole star rating.
        if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
            return { success: false, error: 'review.invalidRating' }
        }
        if (typeof productId !== 'string' || typeof orderId !== 'string') {
            return { success: false, error: 'review.invalidOrder' }
        }
        const cleanComment = typeof comment === 'string' ? comment.trim() : ''
        if (cleanComment.length > MAX_REVIEW_COMMENT_LENGTH) {
            return { success: false, error: 'review.commentTooLong' }
        }
        if (await isBlockedUser(session.user.id)) {
            return { success: false, error: 'review.blocked' }
        }

        const order = await db.query.orders.findFirst({
            where: eq(orders.orderId, orderId),
            columns: {
                userId: true,
                username: true,
                status: true,
                productId: true
            }
        })

        if (!order) {
            return { success: false, error: 'review.orderNotFound' }
        }

        if (order.productId !== productId) {
            return { success: false, error: 'review.invalidOrder' }
        }

        if (!isOrderOwner(session.user, order)) {
            return { success: false, error: 'review.notOwner' }
        }

        if (order.status !== 'delivered') {
            return { success: false, error: 'review.orderNotDelivered' }
        }

        await ensureReviewsTable()

        // The insert itself refuses an order that already has a review.
        const created = await createReview({
            productId,
            orderId,
            userId: session.user.id,
            username: session.user.username || session.user.name || 'Anonymous',
            rating,
            comment: cleanComment || undefined
        })
        if (!created.length) {
            return { success: false, error: 'review.alreadyReviewed' }
        }

        revalidatePath(`/buy/${productId}`)
        revalidatePath(`/order/${orderId}`)
        revalidatePath(`/`)
        updateTag('home:ratings')
        updateTag('home:products')

        return { success: true }
    } catch (error) {
        console.error('Failed to submit review:', error)
        return { success: false, error: 'review.submitError' }
    }
}

export async function submitReviewReply(
    reviewId: number,
    productId: string,
    comment: string
): Promise<{ success: boolean; error?: string }> {
    try {
        const session = await auth()
        if (!session?.user?.id) {
            return { success: false, error: 'review.authRequired' }
        }
        if (await isBlockedUser(session.user.id)) {
            return { success: false, error: 'review.blocked' }
        }

        const normalizedComment = typeof comment === 'string' ? comment.trim() : ''
        if (!normalizedComment) {
            return { success: false, error: 'review.replyEmpty' }
        }
        if (normalizedComment.length > 1000) {
            return { success: false, error: 'review.replyTooLong' }
        }

        if (!Number.isSafeInteger(reviewId)) {
            return { success: false, error: 'review.replyInvalidReview' }
        }
        await ensureReviewRepliesTable()
        const recent = await db.select({ count: sql<number>`count(*)` }).from(reviewReplies)
            .where(and(eq(reviewReplies.userId, session.user.id), gt(reviewReplies.createdAt, new Date(Date.now() - USER_CONTENT_WINDOW_MS))))
        if (Number(recent[0]?.count || 0) >= MAX_REVIEW_REPLIES_PER_WINDOW) {
            return { success: false, error: 'review.replyRateLimited' }
        }

        const review = await db.query.reviews.findFirst({
            where: eq(reviews.id, reviewId),
            columns: {
                id: true,
                productId: true,
            }
        })

        if (!review || review.productId !== productId) {
            return { success: false, error: 'review.replyInvalidReview' }
        }

        await createReviewReply({
            reviewId,
            userId: session.user.id,
            username: session.user.username || session.user.name || 'Anonymous',
            comment: normalizedComment,
        })

        revalidatePath(`/buy/${productId}`)
        revalidatePath(`/`)
        updateTag('home:ratings')
        updateTag('home:products')

        return { success: true }
    } catch (error) {
        console.error('Failed to submit review reply:', error)
        return { success: false, error: 'review.replySubmitError' }
    }
}
