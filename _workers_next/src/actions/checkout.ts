'use server'

import { getErrorText } from '@/lib/errors'
import { getAppBaseUrl } from "@/lib/url"

import { auth } from "@/lib/auth"
import { db, dbRun } from "@/lib/db"
import { products, cards, orders, loginUsers } from "@/lib/db/schema"
import { cancelExpiredOrders, cleanupExpiredCardsIfNeeded, recalcProductAggregates } from "@/lib/db/queries"
import { generateOrderId, generateSign } from "@/lib/crypto"
import { eq, sql, and, or, isNull, lt, gt, inArray } from "drizzle-orm"
import { cookies } from "next/headers"
import { updateTag } from "next/cache"
import { getProductCardApiConfig } from '@/lib/card-api'
import { commitCheckoutOrder } from "@/lib/checkout-inventory"
import { INFINITE_STOCK, RESERVATION_TTL_MS, MAX_PENDING_ORDERS_PER_USER, MAX_UNPAID_ORDERS_PER_HOUR, UNPAID_ORDER_WINDOW_MS } from "@/lib/constants"
import { validatePurchaseAnswers } from '@/lib/purchase-questions'

const MAX_ORDER_QUANTITY = 10000
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function isMissingColumnError(error: unknown) {
    const errorString = getErrorText(error).toLowerCase()
    return errorString.includes('no such column') || errorString.includes('column not found') || errorString.includes('d1_column_notfound')
}

function getMaxPointDeduction(totalAmount: number, quantity: number, maxPointsDiscount: string | number | null | undefined) {
    const rawLimit = typeof maxPointsDiscount === 'string' ? maxPointsDiscount.trim() : maxPointsDiscount
    if (rawLimit === null || rawLimit === undefined || rawLimit === '') {
        return Math.ceil(totalAmount)
    }

    const unitLimit = Number(rawLimit)
    if (!Number.isFinite(unitLimit) || unitLimit < 0) {
        return Math.ceil(totalAmount)
    }

    const cappedAmount = Math.min(totalAmount, unitLimit * quantity)
    if (cappedAmount >= totalAmount) {
        return Math.ceil(totalAmount)
    }

    return Math.floor(Math.max(0, cappedAmount))
}

function isValidEmail(value: string | null | undefined) {
    if (!value) return false
    return EMAIL_REGEX.test(value.trim())
}

export async function createOrder(productId: string, quantity: number = 1, email?: string, usePoints: boolean = false, answers?: string[]) {
    const session = await auth()
    const user = session?.user

    if (!user?.id) return { success: false, error: 'common.loginRequired' }

    const normalizedQuantity = Number(quantity)

    if (!Number.isFinite(normalizedQuantity) || !Number.isInteger(normalizedQuantity) || normalizedQuantity <= 0) {
        return { success: false, error: 'buy.invalidQuantity' }
    }

    quantity = normalizedQuantity

    // 1. Get Product
    const getCheckoutProduct = async () => {
        const query = () => db.query.products.findFirst({
            where: eq(products.id, productId),
            columns: {
                id: true,
                name: true,
                price: true,
                purchaseLimit: true,
                maxPointsDiscount: true,
                isShared: true,
                visibilityLevel: true,
                purchaseQuestions: true
            }
        })

        try {
            return await query()
        } catch (error: unknown) {
            if (!isMissingColumnError(error)) throw error
            try {
                await dbRun(sql.raw(`ALTER TABLE products ADD COLUMN max_points_discount TEXT`))
            } catch { /* column exists */ }
            return await query()
        }
    }
    const product = await getCheckoutProduct()
    if (!product) return { success: false, error: 'buy.productNotFound' }

    const trustLevel = Math.max(0, Number.isFinite(Number(user.trustLevel)) ? Number(user.trustLevel) : 0)
    if (Number(product.visibilityLevel ?? -1) > trustLevel) {
        return { success: false, error: 'buy.visibilityDenied' }
    }

    const answerError = validatePurchaseAnswers(product.purchaseQuestions, answers)
    if (answerError) return { success: false, error: answerError }

    const purchaseLimit = product.purchaseLimit && product.purchaseLimit > 0 ? product.purchaseLimit : null
    const maxQuantity = purchaseLimit ?? MAX_ORDER_QUANTITY

    if (quantity > maxQuantity) {
        return { success: false, error: purchaseLimit ? 'buy.limitExceeded' : 'buy.quantityTooLarge' }
    }

    // 2. Check Blocked Status
    if (user?.id) {
        const userRec = await db.query.loginUsers.findFirst({
            where: eq(loginUsers.userId, user.id),
            columns: { isBlocked: true }
        });
        if (userRec?.isBlocked) {
            return { success: false, error: 'buy.userBlocked' };
        }
    }

    // Unpaid orders reserve stock for five minutes. Bound how many one account
    // can hold or abandon so it cannot keep a product locked.
    const unpaid = await db.select({
        pending: sql<number>`COALESCE(SUM(CASE WHEN ${orders.status} = 'pending' THEN 1 ELSE 0 END), 0)`,
        recent: sql<number>`COUNT(*)`,
    }).from(orders).where(and(
        eq(orders.userId, user.id),
        inArray(orders.status, ['pending', 'cancelled']),
        gt(orders.createdAt, new Date(Date.now() - UNPAID_ORDER_WINDOW_MS)),
    ))
    if (Number(unpaid[0]?.pending || 0) >= MAX_PENDING_ORDERS_PER_USER || Number(unpaid[0]?.recent || 0) >= MAX_UNPAID_ORDERS_PER_HOUR) {
        return { success: false, error: 'buy.tooManyPending' }
    }

    // Points Calculation
    let pointsToUse = 0
    let finalAmount = Number(product.price) * quantity

    if (usePoints && user?.id) {
        const userRec = await db.query.loginUsers.findFirst({
            where: eq(loginUsers.userId, user.id),
            columns: { points: true }
        })
        const currentPoints = userRec?.points || 0

        if (currentPoints > 0) {
            // Logic: 1 Point = 1 Unit of currency
            pointsToUse = Math.min(currentPoints, getMaxPointDeduction(finalAmount, quantity, product.maxPointsDiscount))
            finalAmount = Math.max(0, finalAmount - pointsToUse)
        }
    }

    if (!Number.isFinite(finalAmount) || finalAmount < 0) return { success: false, error: 'buy.productNotFound' }
    const isZeroPrice = finalAmount <= 0
    if (typeof productId !== 'string' || productId.length > 200) return { success: false, error: 'buy.productNotFound' }
    const contactInfo = (typeof email === 'string' ? email : '').trim().slice(0, 254)
    const resolvedContactInfo = contactInfo || null
    const resolvedDeliveryEmail = isValidEmail(contactInfo) ? contactInfo : null

    const supplierConfig = await getProductCardApiConfig(productId)
    const onDemand = supplierConfig.enabled && supplierConfig.mode === 'on_demand' && Boolean(supplierConfig.url) && !product.isShared
    if (onDemand && quantity > 100) return { success: false, error: 'buy.quantityTooLarge' }
    // 2. Check Stock
    const getAvailableStock = async () => {
        if (onDemand) return INFINITE_STOCK
        // For shared products, we just need ANY unused card to exist. Reservation status doesn't matter since we don't reserve.
        if (product.isShared) {
            const result = await db.select({ count: sql<number>`count(*)` })
                .from(cards)
                .where(and(
                    eq(cards.productId, productId),
                    or(isNull(cards.isUsed), eq(cards.isUsed, false)),
                    or(isNull(cards.expiresAt), gt(cards.expiresAt, new Date(Date.now() + (isZeroPrice ? 0 : RESERVATION_TTL_MS))))
                ));
            // If we have at least 1 card, treat as infinite stock
            return (result[0]?.count || 0) > 0 ? INFINITE_STOCK : 0;
        }

        // SQLite count returns number directly usually
        const result = await db.select({ count: sql<number>`count(*)` })
            .from(cards)
            .where(and(
                eq(cards.productId, productId),
                or(isNull(cards.isUsed), eq(cards.isUsed, false)),
                or(isNull(cards.expiresAt), gt(cards.expiresAt, new Date(Date.now() + (isZeroPrice ? 0 : RESERVATION_TTL_MS)))),
                or(isNull(cards.reservedAt), lt(cards.reservedAt, new Date(Date.now() - RESERVATION_TTL_MS))),
                sql`NOT EXISTS (SELECT 1 FROM orders holding WHERE holding.order_id = ${cards.reservedOrderId} AND holding.status = 'paid')`
            ))
        return result[0]?.count || 0
    }

    const runStockCleanupFallback = async () => {
        await Promise.allSettled([
            cleanupExpiredCardsIfNeeded(0, productId),
            cancelExpiredOrders({ productId }),
        ])
    }

    let stock = await getAvailableStock()
    if (stock < quantity) {
        await runStockCleanupFallback()
        stock = await getAvailableStock()
    }

    if (stock < quantity) return { success: false, error: 'buy.outOfStock' }

    // 3. Check Purchase Limit
    if (product.purchaseLimit && product.purchaseLimit > 0) {
        const currentUserId = user?.id
        const currentUserEmail = resolvedDeliveryEmail || user?.email || null

        if (currentUserId || currentUserEmail) {
            const userConditions = []

            if (currentUserId) userConditions.push(eq(orders.userId, currentUserId))
            if (currentUserEmail) userConditions.push(eq(orders.email, currentUserEmail))

            if (userConditions.length > 0) {
                const countResult = await db.select({
                    totalQuantity: sql<number>`coalesce(sum(${orders.quantity}), count(*))`
                })
                    .from(orders)
                    .where(and(
                        eq(orders.productId, productId),
                        or(...userConditions),
                        or(eq(orders.status, 'paid'), eq(orders.status, 'delivered'))
                    ))

                const existingCount = countResult[0]?.totalQuantity || 0
                if (existingCount + quantity > product.purchaseLimit) {
                    return { success: false, error: 'buy.limitExceeded' }
                }
            }
        }
    }

    // 4. Create Order + Reserve Stock (1 minute) OR Deliver Immediately
    const orderId = generateOrderId()

    const committed = await commitCheckoutOrder({ orderId, productId, productName: product.name, price: product.price,
        shared: Boolean(product.isShared), quantity, amount: finalAmount, points: pointsToUse,
        userId: user.id, username: user.username || user.name || null, email: resolvedContactInfo,
        purchaseLimit, onDemand, trustLevel, purchaseQuestions: product.purchaseQuestions })
    if (!committed.success) return { success: false, error: 'buy.stockLocked' }
    try { await recalcProductAggregates(productId); updateTag('home:products') } catch { /* maintenance refreshes stock */ }

    if (isZeroPrice) {
        return {
            success: true,
            url: `${getAppBaseUrl()}/order/${orderId}`,
            isZeroPrice: true
        }
    }

    const cookieStore = await cookies()
    cookieStore.set('ldc_pending_order', orderId, { secure: true, path: '/', sameSite: 'lax' })

    const baseUrl = getAppBaseUrl() || 'http://localhost:3000';
    const payParams: Record<string, string> = {
        pid: process.env.MERCHANT_ID!,
        type: 'epay',
        out_trade_no: orderId,
        notify_url: `${baseUrl}/api/notify`,
        return_url: `${baseUrl}/callback/${orderId}`,
        name: product.name,
        money: Number(finalAmount).toFixed(2),
        sign_type: 'MD5'
    }

    payParams.sign = generateSign(payParams, process.env.MERCHANT_KEY!)

    return {
        success: true,
        url: process.env.PAY_URL || 'https://credit.linux.do/epay/pay/submit.php',
        params: payParams
    }
}

export async function getRetryPaymentParams(orderId: string) {
    const session = await auth()
    const user = session?.user

    if (!user?.id) return { success: false, error: 'common.loginRequired' }

    const order = await db.query.orders.findFirst({
        where: and(eq(orders.orderId, orderId), eq(orders.userId, user.id))
    })

    if (!order) return { success: false, error: 'buy.productNotFound' }
    if (order.status !== 'pending') return { success: false, error: 'order.status.paid' }

    const baseUrl = getAppBaseUrl() || 'http://localhost:3000';

    const uniqueTradeNo = `${order.orderId}_retry${Date.now()}`;

    await db.update(orders)
        .set({ currentPaymentId: uniqueTradeNo })
        .where(eq(orders.orderId, orderId))

    const payParams: Record<string, string> = {
        pid: process.env.MERCHANT_ID!,
        type: 'epay',
        out_trade_no: uniqueTradeNo,
        notify_url: `${baseUrl}/api/notify`,
        return_url: `${baseUrl}/callback/${order.orderId}`,
        name: order.productName,
        money: Number(order.amount).toFixed(2),
        sign_type: 'MD5'
    }

    payParams.sign = generateSign(payParams, process.env.MERCHANT_KEY!)

    return {
        success: true,
        url: process.env.PAY_URL || 'https://credit.linux.do/epay/pay/submit.php',
        params: payParams
    }
}
