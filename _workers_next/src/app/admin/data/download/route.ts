import type { SQL } from 'drizzle-orm'
import { getErrorMessage } from '@/lib/errors'
import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { db } from "@/lib/db"
import {
  orders,
  reviews,
  reviewReplies,
  settings,
  products,
  cards,
  loginUsers,
  categories,
  refundRequests,
  dailyCheckins,
  userNotifications,
  userMessages,
  adminMessages,
  broadcastMessages,
  broadcastReads,
  wishlistItems,
  wishlistVotes,
  inventoryImports, inventoryApiKeys, inventoryApiRequests, orderDeliveries, inventoryEvents, supplierRequests,
} from "@/lib/db/schema"
import { and, desc, eq, or, sql } from "drizzle-orm"
import { getProducts, normalizeTimestampMs, ensureDatabaseInitialized } from "@/lib/db/queries"
import { isAdminUsername } from '@/lib/admin-auth'

function requireAdminUsername(username?: string | null) {
  if (!isAdminUsername(username)) {
    throw new Error("Unauthorized")
  }
}

// Card keys are exported byte for byte: they come from the administrator, and a changed key is a wrong key.
const CSV_VERBATIM_COLUMNS = new Set(["cardKey"])

/**
 * Spreadsheet programs run a cell that starts with = + - or @ as a formula. Names, e-mail addresses,
 * reviews and refund reasons are typed by buyers, so such text is exported with a leading apostrophe.
 */
function csvEscape(value: unknown, verbatim = false): string {
  if (value === null || value === undefined) return ""
  let str = String(value)
  if (!verbatim && typeof value === "string" && /^[=+\-@\t\r]/.test(str) && !/^[+-]?\d+(\.\d+)?$/.test(str)) str = `'${str}`
  if (/[",\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`
  return str
}

function toCsv(headers: string[], rows: Array<Record<string, unknown>>): string {
  const lines: string[] = []
  lines.push(headers.map((h) => csvEscape(h)).join(","))
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(row[h], CSV_VERBATIM_COLUMNS.has(h))).join(","))
  }
  return lines.join("\n") + "\n"
}

function csvResponse(csv: string, filename: string) {
  return new NextResponse(`\uFEFF${csv}`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  })
}

function escapeString(val: string): string {
  return "'" + val.replace(/'/g, "''") + "'"
}

function formatSqlValue(val: unknown): string {
  if (val === null || val === undefined) return "NULL"
  if (typeof val === "boolean") return val ? "1" : "0"
  if (val instanceof Date) {
    // Check if valid date
    if (isNaN(val.getTime())) return "NULL"
    return "'" + val.toISOString().replace("T", " ").replace("Z", "") + "'"
  }
  if (typeof val === "number") return String(val)
  if (typeof val === "string") return val.split(/([\r\n])/).map(part => part === '\n' ? 'char(10)' : part === '\r' ? 'char(13)' : escapeString(part)).join(' || ')
  return escapeString(JSON.stringify(val))
}

function rowToInsertOrIgnore(table: string, row: Record<string, unknown>): string {
  const keys = Object.keys(row)
  const columns = keys.join(", ")
  const values = keys.map((k) => formatSqlValue(row[k])).join(", ")
  return `INSERT OR IGNORE INTO ${table} (${columns}) VALUES (${values});`
}

export async function GET(req: Request) {
  const response = await exportData(req)
  response.headers.set("Cache-Control", "no-store")
  return response
}

async function exportData(req: Request) {
  const session = await auth()
  if (!isAdminUsername(session?.user?.username)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  requireAdminUsername(session?.user?.username ?? null)

  const { searchParams } = new URL(req.url)
  const type = (searchParams.get("type") || "").toLowerCase()
  const format = (searchParams.get("format") || "").toLowerCase()
  const includeSecrets = searchParams.get("includeSecrets") === "1"
  const q = (searchParams.get("q") || "").trim()
  const status = (searchParams.get("status") || "all").trim()
  const fulfillment = (searchParams.get("fulfillment") || "all").trim()

  try {
    if (type === "orders") {
      const whereParts: Array<SQL | undefined> = []
      if (status !== 'all') whereParts.push(eq(orders.status, status))
      if (fulfillment === 'needsDelivery') whereParts.push(and(eq(orders.status, 'paid'), sql`${orders.cardKey} IS NULL`))
      if (q) {
        const like = `%${q}%`
        whereParts.push(or(
          sql`${orders.orderId} LIKE ${like}`,
          sql`${orders.productName} LIKE ${like}`,
          sql`COALESCE(${orders.username}, '') LIKE ${like}`,
          sql`COALESCE(${orders.email}, '') LIKE ${like}`,
          sql`COALESCE(${orders.tradeNo}, '') LIKE ${like}`
        ))
      }
      const whereExpr = whereParts.length ? and(...whereParts) : undefined

      const orderRows = await db.query.orders.findMany({
        where: whereExpr,
        orderBy: [desc(normalizeTimestampMs(orders.createdAt))],
      })
      const mapped = orderRows.map((o) => ({
        orderId: o.orderId,
        username: o.username,
        email: includeSecrets ? o.email : null,
        productId: o.productId,
        productName: o.productName,
        amount: o.amount,
        status: o.status,
        tradeNo: includeSecrets ? o.tradeNo : null,
        cardKey: includeSecrets ? o.cardKey : null,
        cardIds: includeSecrets ? o.cardIds : null,
        createdAt: o.createdAt,
        paidAt: o.paidAt,
        deliveredAt: o.deliveredAt,
        userId: o.userId,
      }))

      if (format === "json") {
        return NextResponse.json(mapped, {
          headers: {
            "Content-Disposition": `attachment; filename="orders.json"`,
          },
        })
      }

      if (format === "csv") {
        const headers = [
          "orderId",
          "username",
          "email",
          "productId",
          "productName",
          "amount",
          "status",
          "tradeNo",
          "cardKey",
          "cardIds",
          "createdAt",
          "paidAt",
          "deliveredAt",
          "userId",
        ]
        const csv = toCsv(headers, mapped)
        return csvResponse(csv, `orders${includeSecrets ? "-with-secrets" : ""}.csv`)
      }
    }

    if (type === "products") {
      const rows = await getProducts()
      const mapped = rows.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        price: p.price,
        maxPointsDiscount: p.maxPointsDiscount,
        category: p.category,
        image: p.image,
        isActive: p.isActive ?? true,
        sortOrder: p.sortOrder ?? 0,
        purchaseLimit: p.purchaseLimit,
        visibilityLevel: p.visibilityLevel ?? -1,
        stock: p.stock,
        sold: p.sold,
      }))

      if (format === "json") {
        return NextResponse.json(mapped, {
          headers: {
            "Content-Disposition": `attachment; filename="products.json"`,
          },
        })
      }

      if (format === "csv") {
        const headers = [
          "id",
          "name",
          "description",
          "price",
          "maxPointsDiscount",
          "category",
          "image",
          "isActive",
          "sortOrder",
          "purchaseLimit",
          "visibilityLevel",
          "stock",
          "sold",
        ]
        const csv = toCsv(headers, mapped)
        return csvResponse(csv, "products.csv")
      }
    }

    if (type === "reviews") {
      const rows = await db.query.reviews.findMany({
        orderBy: [desc(reviews.createdAt)],
      })
      const mapped = rows.map((r) => ({
        id: r.id,
        productId: r.productId,
        orderId: r.orderId,
        userId: r.userId,
        username: r.username,
        rating: r.rating,
        comment: r.comment,
        createdAt: r.createdAt,
      }))

      if (format === "json") {
        return NextResponse.json(mapped, {
          headers: {
            "Content-Disposition": `attachment; filename="reviews.json"`,
          },
        })
      }

      if (format === "csv") {
        const headers = [
          "id",
          "productId",
          "orderId",
          "userId",
          "username",
          "rating",
          "comment",
          "createdAt",
        ]
        const csv = toCsv(headers, mapped)
        return csvResponse(csv, "reviews.csv")
      }
    }

    if (type === "settings") {
      const rows = await db.query.settings.findMany({
        orderBy: [desc(settings.updatedAt)],
      })
      const mapped = rows.map((s) => ({
        key: s.key,
        value: s.value,
        updatedAt: s.updatedAt,
      }))
      return NextResponse.json(mapped, {
        headers: {
          "Content-Disposition": `attachment; filename="settings.json"`,
        },
      })
    }

    if (type === "full") {
      await ensureDatabaseInitialized()
      const full: Record<string, Record<string, unknown>[]> = {}
      const tables = [
        ["categories", db.select().from(categories)],
        ["products", db.select().from(products)],
        ["cards", db.select().from(cards)],
        ["inventory_imports", db.select().from(inventoryImports)],
        ["orders", db.select().from(orders)],
        ["inventory_api_keys", db.select().from(inventoryApiKeys)],
        ["inventory_api_requests", db.select().from(inventoryApiRequests)],
        ["order_deliveries", db.select().from(orderDeliveries)],
        ["inventory_events", db.select().from(inventoryEvents)],
        ["supplier_requests", db.select().from(supplierRequests)],
        ["reviews", db.select().from(reviews)],
        ["review_replies", db.select().from(reviewReplies)],
        ["settings", db.select().from(settings)],
        ["login_users", db.select().from(loginUsers)],
        ["user_notifications", db.select().from(userNotifications)],
        ["user_messages", db.select().from(userMessages)],
        ["admin_messages", db.select().from(adminMessages)],
        ["broadcast_messages", db.select().from(broadcastMessages)],
        ["broadcast_reads", db.select().from(broadcastReads)],
        ["wishlist_items", db.select().from(wishlistItems)],
        ["wishlist_votes", db.select().from(wishlistVotes)],
        ["refund_requests", db.select().from(refundRequests)],
        ["daily_checkins_v2", db.select().from(dailyCheckins)],
      ] as const
      // D1 batch reads all tables in one transaction, including stock and its delivery receipts.
      const [firstQuery, ...otherQueries] = tables.map(([, query]) => query)
      const snapshot = await db.batch([firstQuery, ...otherQueries])
      for (const [index, [tableName]] of tables.entries()) {
        full[tableName] = snapshot[index] as Record<string, unknown>[]
      }

      if (format === "json") {
        return NextResponse.json(full, {
          headers: {
            "Content-Disposition": `attachment; filename="full-dump.json"`,
          },
        })
      }

      if (format === "sql") {
        const parts: string[] = []
        parts.push(`-- Database Migration Dump (Vercel Postgres -> Cloudflare D1)`)
        parts.push(`-- Generated at ${new Date().toISOString()}`)
        parts.push(``)
        parts.push(`-- Note: Transaction statements removed for D1 compatibility`)
        parts.push(``)

        // Map camelCase keys to snake_case for SQL export
        const columnMapping: Record<string, string> = {
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
          // Reviews
          // orderId, productId, userId already covered
          // Settings
          updatedAt: 'updated_at',
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
          // Notification / message tables
          titleKey: 'title_key',
          contentKey: 'content_key',
          isRead: 'is_read',
          // Broadcast / admin messages
          targetType: 'target_type',
          targetValue: 'target_value',
            tokenHash: 'token_hash',
            tokenEncrypted: 'token_encrypted',
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

        for (const [tableName, rows] of Object.entries(full)) {
          if (!rows.length) continue
          for (const row of rows) {
            // Convert keys to snake_case
            const sqlRow: Record<string, unknown> = {}
            for (const [key, val] of Object.entries(row)) {
              const sqlKey = columnMapping[key] || key
              sqlRow[sqlKey] = val
            }
            parts.push(rowToInsertOrIgnore(tableName, sqlRow))
          }
          parts.push(``)
        }

        parts.push(`-- End of Dump`)
        parts.push(``)

        const sqlText = parts.join("\n")
        return new NextResponse(sqlText, {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Content-Disposition": `attachment; filename="migration_data.sql"`,
          },
        })
      }
    }

    return NextResponse.json({ error: "Bad Request" }, { status: 400 })
  } catch (e) {
    const message = getErrorMessage(e) || "Export failed"
    return NextResponse.json({ error: message }, { status: message === "Unauthorized" ? 401 : 500 })
  }
}
