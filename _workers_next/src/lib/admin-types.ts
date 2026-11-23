import type { orders, adminMessages, userMessages, refundRequests } from '@/lib/db/schema'

export type AdminOrder = typeof orders.$inferSelect & { productVariantLabel?: string | null; legacyProfileIdentifier?: string | null }
export type AdminOrderSummary = Pick<AdminOrder, 'orderId'> & { [K in keyof Omit<AdminOrder, 'orderId'>]?: AdminOrder[K] | null }
export type AdminOrderDetail = Pick<AdminOrder, 'orderId' | 'productId' | 'productName' | 'amount' | 'status' | 'cardKey' | 'username' | 'userId' | 'email' | 'tradeNo' | 'createdAt' | 'paidAt' | 'deliveredAt'> & { productVariantLabel?: string | null }
export type AdminMessage = typeof adminMessages.$inferSelect
export type UserMessage = typeof userMessages.$inferSelect
export type AdminRefundRequest = typeof refundRequests.$inferSelect & {
    orderStatus: string | null; tradeNo: string | null; amount: string | null; productName: string | null; cardKey: string | null
}
