'use server'

import { checkAdmin } from '@/actions/admin'
import { db } from '@/lib/db'
import { inventoryApiKeys } from '@/lib/db/schema'
import { ensureDatabaseInitialized, setSetting } from '@/lib/db/queries'
import { createManagedInventoryKey, readManagedInventoryToken, resetManagedInventoryToken, deleteManagedInventoryKey, changeCardExpiry, type InventoryKeyInput } from '@/lib/inventory-management'
import { InventoryTokenError } from '@/lib/inventory-token'
import { invalidateInventory } from '@/lib/fulfillment'
import { scheduleInventoryEvents } from '@/lib/inventory-events'
import { retryPaidOrderDelivery } from '@/lib/retry-delivery'
import { readSupplierRecovery, updateSupplierRecovery } from '@/lib/supplier-recovery'
import { eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'

export async function createInventoryKey(input: InventoryKeyInput) {
    await checkAdmin()
    try {
        const result = await createManagedInventoryKey(input, 'admin')
        revalidatePath('/admin/inventory-api')
        return { success: true as const, ...result }
    } catch (error) {
        if (error instanceof InventoryTokenError) return { success: false as const, error: error.code }
        throw error
    }
}

export async function setInventoryKeyEnabled(id: string, enabled: boolean) {
    await checkAdmin()
    if (typeof id !== 'string' || !id || typeof enabled !== 'boolean') throw new Error('Invalid key')
    await ensureDatabaseInitialized()
    await db.update(inventoryApiKeys).set({ isEnabled: enabled }).where(eq(inventoryApiKeys.id, id))
    revalidatePath('/admin/inventory-api')
}

export async function viewInventoryKey(id: string) {
    await checkAdmin()
    if (typeof id !== 'string' || !id) return { success: false as const, error: 'inventory.keyNotFound' }
    try { return { success: true as const, ...await readManagedInventoryToken(id) } }
    catch (error) {
        if (error instanceof InventoryTokenError) return { success: false as const, error: error.code }
        throw error
    }
}

export async function resetInventoryKey(id: string) {
    await checkAdmin()
    if (typeof id !== 'string' || !id) return { success: false as const, error: 'inventory.keyNotFound' }
    try {
        const result = await resetManagedInventoryToken(id)
        revalidatePath('/admin/inventory-api')
        return { success: true as const, ...result }
    } catch (error) {
        if (error instanceof InventoryTokenError) return { success: false as const, error: error.code }
        throw error
    }
}

export async function deleteInventoryKey(id: string) {
    await checkAdmin()
    try {
        await deleteManagedInventoryKey(id)
        revalidatePath('/admin/inventory-api')
        return { success: true as const }
    } catch (error) {
        if (error instanceof InventoryTokenError) return { success: false as const, error: error.code }
        console.error('[inventory] key deletion failed')
        return { success: false as const, error: 'inventory.keyDeleteFailed' }
    }
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
    const result = await retryPaidOrderDelivery(orderId)
    scheduleInventoryEvents()
    invalidateInventory('')
    revalidatePath(`/admin/orders/${orderId}`)
    revalidatePath(`/order/${orderId}`)
    return result
}

export async function getSupplierRecoveryInfo(orderId: string) {
    await checkAdmin()
    try { return await readSupplierRecovery(orderId) }
    catch { return { success: false as const, error: 'inventory.recovery.readFailed' } }
}

export async function resumeSupplierOrder(orderId: string, expectedUrl: string, confirmed: boolean) {
    await checkAdmin()
    let updated: Awaited<ReturnType<typeof updateSupplierRecovery>>
    try { updated = await updateSupplierRecovery(orderId, expectedUrl, confirmed) }
    catch { return { success: false as const, error: 'inventory.recovery.saveFailed' } }
    if (!updated.success) return updated
    let result: Awaited<ReturnType<typeof retryPaidOrderDelivery>>
    try { result = await retryPaidOrderDelivery(orderId) }
    catch {
        invalidateInventory('')
        return { success: false as const, error: 'inventory.recovery.retryFailed' }
    }
    scheduleInventoryEvents()
    invalidateInventory('')
    revalidatePath(`/admin/orders/${orderId}`)
    revalidatePath(`/order/${orderId}`)
    return { success: true as const, ...result }
}
