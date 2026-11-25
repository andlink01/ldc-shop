'use server'

import { getErrorMessage } from '@/lib/errors'

import { auth } from "@/lib/auth"
import { db } from "@/lib/db"
import { loginUsers } from "@/lib/db/schema"
import { ensureLoginUsersSchema, getSetting } from "@/lib/db/queries"
import { and, eq, isNull, lt, or, sql } from "drizzle-orm"
import { revalidatePath } from "next/cache"
import { shopDayStartMs } from "@/lib/shop-time"

export async function checkIn() {
    const session = await auth()
    if (!session?.user?.id) {
        return { success: false, error: "Not logged in" }
    }

    // 0. Check if feature is enabled
    const enabledStr = await getSetting('checkin_enabled')
    if (enabledStr === 'false') {
        return { success: false, error: "Check-in is currently disabled" }
    }

    const userId = session.user.id

    try {
        await ensureLoginUsersSchema()
        const nowMs = Date.now()
        const todayStartUtcMs = shopDayStartMs(nowMs)
        const yesterdayStartUtcMs = todayStartUtcMs - 86400000

        // 2. Get Reward Amount
        const rewardStr = await getSetting('checkin_reward')
        const parsedReward = Number.parseInt(rewardStr ?? '', 10)
        const reward = Number.isSafeInteger(parsedReward) && parsedReward >= 0 && parsedReward <= 1_000_000 ? parsedReward : 10

        // 3. Perform Check-in & Award Points (atomic guard in DB)
        const updated = await db.update(loginUsers)
            .set({
                points: sql`${loginUsers.points} + ${reward}`,
                lastCheckinAt: new Date(nowMs),
                consecutiveDays: sql`CASE 
                    WHEN ${loginUsers.lastCheckinAt} IS NOT NULL 
                        AND ${loginUsers.lastCheckinAt} >= ${yesterdayStartUtcMs}
                        AND ${loginUsers.lastCheckinAt} < ${todayStartUtcMs}
                    THEN COALESCE(${loginUsers.consecutiveDays}, 0) + 1
                    ELSE 1
                END`
            })
            .where(and(
                eq(loginUsers.userId, userId),
                sql`COALESCE(${loginUsers.isBlocked}, 0) = 0`,
                or(
                    isNull(loginUsers.lastCheckinAt),
                    lt(loginUsers.lastCheckinAt, new Date(todayStartUtcMs))
                )
            ))
            .returning({ consecutiveDays: loginUsers.consecutiveDays });

        if (!updated.length) {
            return { success: false, error: "Already checked in today" }
        }

        revalidatePath('/')
        return { success: true, points: reward, consecutiveDays: updated[0]?.consecutiveDays ?? 1 }
    } catch (error) {
        console.error("Check-in error:", error)
        return { success: false, error: `Check-in failed: ${getErrorMessage(error) || 'Unknown error'}` }
    }
}

export async function getUserPoints() {
    const session = await auth()
    if (!session?.user?.id) return 0

    const user = await db.query.loginUsers.findFirst({
        where: eq(loginUsers.userId, session.user.id),
        columns: { points: true }
    })

    return user?.points || 0
}

export async function getCheckinStatus() {
    const session = await auth()
    if (!session?.user?.id) return { checkedIn: false }

    const enabledStr = await getSetting('checkin_enabled')
    if (enabledStr === 'false') {
        return { checkedIn: false, disabled: true }
    }

    try {
        await ensureLoginUsersSchema()
        const user = await db.query.loginUsers.findFirst({
            where: eq(loginUsers.userId, session.user.id),
            columns: { lastCheckinAt: true }
        })

        if (!user || !user.lastCheckinAt) {
            return { checkedIn: false }
        }

        return { checkedIn: new Date(user.lastCheckinAt).getTime() >= shopDayStartMs() }
    } catch (error) {
        console.error('[CheckinStatus] Error:', getErrorMessage(error))
        return { checkedIn: false }
    }
}
