import { NextResponse } from "next/server";
import { cancelExpiredOrders, cleanupExpiredCardsIfNeeded, ensureDatabaseInitialized } from "@/lib/db/queries";
import { fulfillPendingOrders } from '@/lib/fulfillment'
import { enqueueExpiryAlerts, processInventoryEvents } from '@/lib/inventory-events'

const CRON_TOKEN_HEADER = "x-cron-cleanup-token";
const CARD_CLEANUP_THROTTLE_MS = 60 * 1000;

function getCronToken(): string | null {
    const token = process.env.CRON_CLEANUP_TOKEN?.trim();
    if (token) return token;
    const oauthSecret = process.env.OAUTH_CLIENT_SECRET?.trim();
    return oauthSecret || null;
}

function isAuthorized(request: Request, expectedToken: string): boolean {
    const received = request.headers.get(CRON_TOKEN_HEADER)?.trim();
    return !!received && received === expectedToken;
}

export async function POST(request: Request) {
    const expectedToken = getCronToken();
    if (!expectedToken) {
        return NextResponse.json(
            { success: false, error: "cleanup_token_not_configured" },
            { status: 500 }
        );
    }

    if (!isAuthorized(request, expectedToken)) {
        return NextResponse.json(
            { success: false, error: "unauthorized" },
            { status: 401 }
        );
    }

    const startedAt = Date.now();
    await ensureDatabaseInitialized();
    const [cardsResult, ordersResult] = await Promise.allSettled([
        cleanupExpiredCardsIfNeeded(CARD_CLEANUP_THROTTLE_MS),
        cancelExpiredOrders(),
    ]);

    const durationMs = Date.now() - startedAt;

    if (cardsResult.status === "rejected" || ordersResult.status === "rejected") {
        console.error("[cron-cleanup] failed", {
            cardsError: cardsResult.status === "rejected" ? String(cardsResult.reason) : null,
            ordersError: ordersResult.status === "rejected" ? String(ordersResult.reason) : null,
        });

        return NextResponse.json(
            { success: false, error: "cleanup_failed", durationMs },
            { status: 500 }
        );
    }

    return NextResponse.json({
        success: true,
        durationMs: Date.now() - startedAt,
        cardsCleanupRan: cardsResult.value,
        cancelledOrderCount: ordersResult.value.length,
        fulfillment: await fulfillPendingOrders(undefined, 50),
        expiryAlerts: await enqueueExpiryAlerts(),
        notifications: await processInventoryEvents(),
    });
}
