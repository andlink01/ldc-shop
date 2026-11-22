'use server'

import { checkAdmin } from '@/actions/admin'
import { db } from '@/lib/db'
import { inventoryApiKeys } from '@/lib/db/schema'
import { ensureDatabaseInitialized, setSetting } from '@/lib/db/queries'
import { createManagedInventoryKey, changeCardExpiry, type InventoryKeyInput } from '@/lib/inventory-management'
import { fulfillPaidOrder, invalidateInventory } from '@/lib/fulfillment'
import { scheduleInventoryEvents } from '@/lib/inventory-events'
import { procureOrderCards } from '@/lib/supplier-fulfillment'
import { eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'

export async function createInventoryKey(input: InventoryKeyInput) {
    await checkAdmin()
    const result = await createManagedInventoryKey(input, 'admin')
    revalidatePath('/admin/inventory-api')
    return result
}

export async function setInventoryKeyEnabled(id: string, enabled: boolean) {
    await checkAdmin()
    if (typeof id !== 'string' || !id || typeof enabled !== 'boolean') throw new Error('Invalid key')
    await ensureDatabaseInitialized()
    await db.update(inventoryApiKeys).set({ isEnabled: enabled }).where(eq(inventoryApiKeys.id, id))
    revalidatePath('/admin/inventory-api')
}

export async function updateCardsExpiry(productId: string, ids: number[], expiresAt: string | null) {
    await checkAdmin()
    return changeCardExpiry(productId, ids, expiresAt)
}

export async function saveExpiryAlertMinutes(minutes: number) {
    await checkAdmin()
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 10_080) throw new Error('Invalid alert interval')
    await setSetting('expiry_alert_minutes', String(minutes))
    revalidatePath('/admin/inventory-api')
}

export async function retryOrderDelivery(orderId: string) {
    await checkAdmin()
    let result = await fulfillPaidOrder(orderId)
    if (!result.delivered) {
        await procureOrderCards(orderId, 1)
        result = await fulfillPaidOrder(orderId)
    }
    scheduleInventoryEvents()
    invalidateInventory('')
    revalidatePath(`/admin/orders/${orderId}`)
    revalidatePath(`/order/${orderId}`)
    return result
}
