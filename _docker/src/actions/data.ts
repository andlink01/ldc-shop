"use server"

import { getErrorMessage } from '@/lib/errors';

import { db, dbRun, dbBatchRaw } from "@/lib/db";
import { sql } from "drizzle-orm";
import { revalidatePath, updateTag } from "next/cache";
import { checkAdmin } from "@/actions/admin";
import { recalcProductAggregatesForMany, ensureDatabaseInitialized } from "@/lib/db/queries";
import { products } from "@/lib/db/schema";

const IMPORT_BATCH_SIZE = 50
const MAX_IMPORT_BYTES = 50 * 1024 * 1024

const ALLOWED_IMPORT_TABLES = new Set([
    'products',
    'cards',
    'inventory_imports',
    'inventory_api_keys',
    'inventory_api_requests',
    'orders',
    'order_deliveries',
    'inventory_events',
    'supplier_requests',
    'login_users',
    'daily_checkins_v2',
    'settings',
    'reviews',
    'review_replies',
    'categories',
    'refund_requests',
    'user_notifications',
    'admin_messages',
    'user_messages',
    'broadcast_messages',
    'broadcast_reads',
    'wishlist_items',
    'wishlist_votes',
])

const VALID_IMPORT_IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/

function isSafeSqlValuesExpression(valuesStr: string): boolean {
    let i = 0
    const len = valuesStr.length
    let expectingValue = true
    let hasValue = false

    const skipWs = () => {
        while (i < len && /\s/.test(valuesStr[i])) i++
    }

    while (i < len) {
        skipWs()
        if (i >= len) break

        if (expectingValue) {
            const ch = valuesStr[i]
            if (ch === "'") {
                i++
                let closed = false
                while (i < len) {
                    if (valuesStr[i] === "'") {
                        if (i + 1 < len && valuesStr[i + 1] === "'") {
                            i += 2
                            continue
                        }
                        i++
                        closed = true
                        break
                    }
                    i++
                }
                if (!closed) return false
                hasValue = true
                expectingValue = false
                continue
            }

            if (ch === '-' || (ch >= '0' && ch <= '9')) {
                const rest = valuesStr.slice(i)
                const numMatch = /^-?\d+(?:\.\d+)?(?=\s*(?:,|\|\||$))/.exec(rest)
                if (!numMatch) return false
                i += numMatch[0].length
                hasValue = true
                expectingValue = false
                continue
            }

            const rest = valuesStr.slice(i)
            const identMatch = /^([a-zA-Z_][a-zA-Z0-9_]*)/.exec(rest)
            if (!identMatch) return false
            const word = identMatch[1].toLowerCase()
            i += identMatch[1].length

            if (word === 'null' || word === 'true' || word === 'false') {
                hasValue = true
                expectingValue = false
                continue
            }

            if (word === 'char') {
                skipWs()
                const charArg = /^\(\s*\d{1,3}\s*\)/.exec(valuesStr.slice(i))
                if (!charArg) return false
                i += charArg[0].length
                hasValue = true
                expectingValue = false
                continue
            }

            return false
        } else {
            if (valuesStr[i] === ',') {
                i++
                expectingValue = true
                continue
            }
            if (valuesStr.slice(i, i + 2) === '||') {
                i += 2
                expectingValue = true
                continue
            }
            return false
        }
    }

    return hasValue && !expectingValue
}

async function executeStatement(statement: string) {
    if (!statement.trim()) return
    try {
        await dbRun(sql.raw(statement))
    } catch (e) {
        // Statements hold card keys and tokens: report the table only.
        const table = /INTO\s+(\w+)/i.exec(statement)?.[1] || 'unknown'
        throw new Error(`Failed to import a row into ${table}: ${e instanceof Error ? getErrorMessage(e) : String(e)}`)
    }
}

async function repairTimestamps() {
    const timestampColumns = [
        { table: 'products', cols: ['created_at'] },
        { table: 'cards', cols: ['created_at', 'reserved_at', 'expires_at', 'used_at'] },
        { table: 'supplier_requests', cols: ['lease_until', 'created_at'] },
        { table: 'inventory_api_keys', cols: ['expires_at', 'created_at', 'last_used_at'] },
        { table: 'inventory_api_requests', cols: ['created_at'] },
        { table: 'order_deliveries', cols: ['created_at'] },
        { table: 'inventory_events', cols: ['lease_until', 'next_attempt_at', 'completed_at', 'created_at'] },
        { table: 'orders', cols: ['created_at', 'paid_at', 'delivered_at'] },
        { table: 'login_users', cols: ['created_at', 'last_login_at', 'last_checkin_at'] },
        { table: 'daily_checkins_v2', cols: ['created_at'] },
        { table: 'settings', cols: ['updated_at'] },
        { table: 'reviews', cols: ['created_at'] },
        { table: 'review_replies', cols: ['created_at'] },
        { table: 'categories', cols: ['created_at', 'updated_at'] },
        { table: 'refund_requests', cols: ['created_at', 'updated_at', 'processed_at'] },
        { table: 'user_notifications', cols: ['created_at'] },
        { table: 'user_messages', cols: ['created_at'] },
        { table: 'admin_messages', cols: ['created_at'] },
        { table: 'broadcast_messages', cols: ['created_at'] },
        { table: 'broadcast_reads', cols: ['created_at'] },
        { table: 'wishlist_items', cols: ['created_at'] },
        { table: 'wishlist_votes', cols: ['created_at'] },
    ]

    for (const { table, cols } of timestampColumns) {
        for (const col of cols) {
            try {
                // SQLite: Convert TEXT timestamps (e.g. '2023-01-01...') to INTEGER (Unix MS)
                // Only targets rows where column is currently TEXT
                // strftime('%s') returns seconds, so * 1000 for ms
                await dbRun(sql.raw(`
                    UPDATE ${table} 
                    SET ${col} = CAST(strftime('%s', ${col}) AS INTEGER) * 1000 
                    WHERE typeof(${col}) = 'text' AND ${col} IS NOT NULL AND ${col} != ''
                `))
            } catch (e) {
                console.error(`Failed to repair timestamp for ${table}.${col}:`, e)
            }
        }
    }
}

export async function repairDataAction() {
    await checkAdmin()
    try {
        await repairTimestamps()
        return { success: true }
    } catch (e) {
        return { success: false, error: getErrorMessage(e) }
    }
}

export async function importData(formData: FormData) {
    await checkAdmin()

    const file = formData.get('file') as File
    if (!file) {
        return { success: false, error: 'No file provided' }
    }
    if (typeof file.size === 'number' && file.size > MAX_IMPORT_BYTES) {
        return { success: false, error: 'File too large (max 50MB)' }
    }

    try {
        await ensureDatabaseInitialized()
        const text = await file.text()
        if (text.length > MAX_IMPORT_BYTES) {
            return { success: false, error: 'File too large (max 50MB)' }
        }
        const lines = text.split('\n')

        // Comprehensive Column Mapping (CamelCase -> snake_case) for Vercel exports
        // This covers known differences between Vercel export (which uses property names) and D1 schema
        const columnMap: Record<string, string> = {
            userId: 'user_id',
            productId: 'product_id',
            orderId: 'order_id',
            reviewId: 'review_id',
            itemId: 'item_id',
            messageId: 'message_id',
            idempotencyKey: 'idempotency_key',
            payloadHash: 'payload_hash',
            importedCount: 'imported_count',
            // Products
            compareAtPrice: 'compare_at_price',
            maxPointsDiscount: 'max_points_discount',
            isHot: 'is_hot',
            isActive: 'is_active',
            isShared: 'is_shared',
            sortOrder: 'sort_order',
            purchaseLimit: 'purchase_limit',
            purchaseWarning: 'purchase_warning',
            visibilityLevel: 'visibility_level',
            stockCount: 'stock_count',
            lockedCount: 'locked_count',
            soldCount: 'sold_count',
            reviewCount: 'review_count',
            variantGroupId: 'variant_group_id',
            variantLabel: 'variant_label',
            purchaseQuestions: 'purchase_questions',
            productImages: 'product_images',
            createdAt: 'created_at',
            // Cards
            cardKey: 'card_key',
            isUsed: 'is_used',
            reservedOrderId: 'reserved_order_id',
            reservedAt: 'reserved_at',
            expiresAt: 'expires_at',
            usedAt: 'used_at',
            // Orders
            productName: 'product_name',
            tradeNo: 'trade_no',
            paidAt: 'paid_at',
            deliveredAt: 'delivered_at',
            pointsUsed: 'points_used',
            currentPaymentId: 'current_payment_id',
            cardIds: 'card_ids',
            // Login Users
            lastLoginAt: 'last_login_at',
            lastCheckinAt: 'last_checkin_at',
            consecutiveDays: 'consecutive_days',
            isBlocked: 'is_blocked',
            desktopNotificationsEnabled: 'desktop_notifications_enabled',
            // Refund Requests
            adminUsername: 'admin_username',
            adminNote: 'admin_note',
            processedAt: 'processed_at',
            // Settings
            updatedAt: 'updated_at',
            // Notification / message tables
            titleKey: 'title_key',
            contentKey: 'content_key',
            isRead: 'is_read',
            // Broadcast / admin messages
            targetType: 'target_type',
            targetValue: 'target_value',
            tokenHash: 'token_hash',
            tokenPrefix: 'token_prefix',
            productIds: 'product_ids',
            canRead: 'can_read',
            canWrite: 'can_write',
            isEnabled: 'is_enabled',
            lastUsedAt: 'last_used_at',
            createdBy: 'created_by',
            keyId: 'key_id',
            addedCount: 'added_count',
            durationMs: 'duration_ms',
            attemptId: 'attempt_id',
            eventId: 'event_id',
            telegramSent: 'telegram_sent',
            barkSent: 'bark_sent',
            emailSent: 'email_sent',
            replenishAttempted: 'replenish_attempted',
            leaseToken: 'lease_token',
            leaseUntil: 'lease_until',
            nextAttemptAt: 'next_attempt_at',
            completedAt: 'completed_at',

            supplierRequestId: 'supplier_request_id',
            requestId: 'request_id',
            itemIndex: 'item_index',
            serverUrl: 'server_url',
            cardId: 'card_id',

        }

        let successCount = 0
        let errorCount = 0
        const statements: string[] = []

        for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed || trimmed.startsWith('--')) continue

            const match = /^(INSERT(?:\s+OR\s+IGNORE)?\s+INTO)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(([^)]+)\)\s*VALUES\s*\((.+)\)\s*;?$/i.exec(trimmed)
            if (!match) {
                errorCount++
                continue
            }

            const insertVerb = match[1].toUpperCase().replace(/\s+/g, ' ')
            const table = match[2].toLowerCase()
            const columnsStr = match[3]
            const valuesStr = match[4].trim()

            // Map legacy table names and allowlist targets
            const tableMap: Record<string, string> = {
                'daily_checkins': 'daily_checkins_v2'
            }
            const targetTable = tableMap[table] || table
            if (!ALLOWED_IMPORT_TABLES.has(targetTable)) {
                errorCount++
                continue
            }

            const rawColumns = columnsStr.split(',').map((c) => c.trim()).filter(Boolean)
            if (!rawColumns.length || rawColumns.some((c) => !VALID_IMPORT_IDENTIFIER_RE.test(c))) {
                errorCount++
                continue
            }

            const newColumns = rawColumns.map((c) => columnMap[c] || c)
            if (newColumns.some((c) => !VALID_IMPORT_IDENTIFIER_RE.test(c))) {
                errorCount++
                continue
            }

            if (!isSafeSqlValuesExpression(valuesStr)) {
                errorCount++
                continue
            }

            statements.push(`${insertVerb} ${targetTable} (${newColumns.join(', ')}) VALUES (${valuesStr});`)
        }

        // One database round trip per group keeps large backups within the
        // platform request limits. A group that fails is retried row by row so
        // one bad row (or a table this version lacks) does not drop the others.
        for (let offset = 0; offset < statements.length; offset += IMPORT_BATCH_SIZE) {
            const group = statements.slice(offset, offset + IMPORT_BATCH_SIZE)
            try {
                await dbBatchRaw(group.map((statement) => ({ sql: statement, params: [] })))
                successCount += group.length
            } catch {
                for (const statement of group) {
                    try {
                        await executeStatement(statement)
                        successCount++
                    } catch (e) {
                        const errorMsg = getErrorMessage(e) || String(e)
                        if (!errorMsg.includes('no such table') && !errorMsg.includes('does not exist')) console.error('[import]', errorMsg)
                        errorCount++
                    }
                }
            }
        }

        // Run repair regardless of insert success to fix any existing data issues
        await repairTimestamps()

        try {
            const productRows = await db.select({ id: products.id }).from(products);
            const productIds = productRows.map((r) => r.id).filter(Boolean);
            await recalcProductAggregatesForMany(productIds);
        } catch {
            // best effort
        }

        revalidatePath('/admin')
        updateTag('home:products')
        updateTag('home:ratings')
        updateTag('home:categories')
        updateTag('home:announcement')
        updateTag('home:product-categories')
        updateTag('home:visitors')
        return { success: true, count: successCount, errors: errorCount }
    } catch (e) {
        return { success: false, error: getErrorMessage(e) }
    }
}
