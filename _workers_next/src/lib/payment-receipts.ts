import { createHash } from 'crypto'
import { db, dbRun } from '@/lib/db'
import { inventoryEvents } from '@/lib/db/schema'
import { ensureDatabaseInitialized } from '@/lib/db/queries'
import { getEpayApiUrl } from '@/lib/epay'
import { eq, sql } from 'drizzle-orm'

/** Signed gateway receipts survive order deletion; they are evidence, not a new payment or refund instruction. */
export async function savePaymentReceipt(input: { orderId: string; paymentId: string; tradeNo: string; amount: string }) {
    await ensureDatabaseInitialized()
    const data = JSON.stringify({ gateway: getEpayApiUrl(), merchantId: process.env.MERCHANT_ID, ...input })
    const eventId = 'payment-receipt:' + createHash('sha256').update(JSON.stringify([getEpayApiUrl(), process.env.MERCHANT_ID, input.orderId, input.tradeNo])).digest('hex')
    const now = Date.now()
    await dbRun(sql`INSERT OR IGNORE INTO inventory_events (event_id, kind, data, completed_at, created_at)
        VALUES (${eventId}, 'payment_receipt', ${data}, ${now}, ${now})`)
    const receipt = await db.query.inventoryEvents.findFirst({ where: eq(inventoryEvents.eventId, eventId), columns: { data: true } })
    if (receipt?.data !== data) throw new Error('Payment transaction receipt mismatch')
}
