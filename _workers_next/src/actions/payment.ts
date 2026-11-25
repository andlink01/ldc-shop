'use server'
import { getAppBaseUrl } from "@/lib/url"

import { auth } from "@/lib/auth"
import { db, dbBatchRaw } from "@/lib/db"
import { orders, loginUsers } from "@/lib/db/schema"
import { eq } from 'drizzle-orm'
import { generateOrderId, generateSign } from "@/lib/crypto"
import { cookies } from "next/headers"
import { PAYMENT_PRODUCT_ID, PAYMENT_PRODUCT_NAME } from "@/lib/payment"
import { withOrderColumnFallback } from "@/lib/db/queries"
import { getAdminUsernames } from "@/lib/admin-auth"
import { merchantConfigured, moneyCents, NEW_ORDER_ALLOWED_SQL, newOrderAllowedParams } from '@/lib/order-policy'

export async function createPaymentOrder(amountInput: number | string, payeeInput?: string | null) {
    const session = await auth()
    const user = session?.user

    if (!user?.id) return { success: false, error: 'common.loginRequired' }
    const userId = user.id

    const cents = moneyCents(amountInput)
    if (cents === null || cents <= 0) {
        return { success: false, error: 'payment.invalidAmount' }
    }
    if (!merchantConfigured()) return { success: false, error: 'payment.unavailable' }
    const buyer = await db.query.loginUsers.findFirst({ where: eq(loginUsers.userId, user.id), columns: { isBlocked: true } })
    if (buyer?.isBlocked) return { success: false, error: 'buy.userBlocked' }

    const adminUsers = getAdminUsernames()
    const fallbackPayee = adminUsers[0] || null
    const payeeCandidate = typeof payeeInput === 'string' ? payeeInput.trim().slice(0, 80) : ''
    const matchedAdmin = payeeCandidate
        ? adminUsers.find((name) => name.toLowerCase() === payeeCandidate.toLowerCase())
        : undefined
    const payeeRaw = matchedAdmin || fallbackPayee || ''
    const payee = payeeRaw ? payeeRaw.slice(0, 80) : null

    const orderId = generateOrderId()
    const amount = (cents / 100).toFixed(2)

    await withOrderColumnFallback(async () => {
        const now = Date.now()
        await dbBatchRaw([{
            sql: `INSERT INTO orders (order_id, product_id, product_name, amount, email, user_id, username, payee, status, current_payment_id, created_at)
                SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ? WHERE ${NEW_ORDER_ALLOWED_SQL}`,
            params: [orderId, PAYMENT_PRODUCT_ID, PAYMENT_PRODUCT_NAME, amount, user.email || null, userId, user.username || null,
                payee, orderId, now, ...newOrderAllowedParams(userId, now)],
        }])
    })
    const created = await db.query.orders.findFirst({ where: eq(orders.orderId, orderId), columns: { orderId: true } })
    if (!created) return { success: false, error: 'buy.tooManyPending' }

    const cookieStore = await cookies()
    cookieStore.set('ldc_pending_order', orderId, { secure: true, path: '/', sameSite: 'lax' })

    const baseUrl = getAppBaseUrl() || 'http://localhost:3000'
    const payParams: Record<string, string> = {
        pid: process.env.MERCHANT_ID!,
        type: 'epay',
        out_trade_no: orderId,
        notify_url: `${baseUrl}/api/notify`,
        return_url: `${baseUrl}/callback/${orderId}`,
        name: PAYMENT_PRODUCT_NAME,
        money: amount,
        sign_type: 'MD5'
    }

    payParams.sign = generateSign(payParams, process.env.MERCHANT_KEY!)

    return {
        success: true,
        url: process.env.PAY_URL || 'https://credit.linux.do/epay/pay/submit.php',
        params: payParams
    }
}
