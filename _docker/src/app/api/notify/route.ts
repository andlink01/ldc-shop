import { getErrorMessage } from '@/lib/errors';
import { db } from "@/lib/db";
import { orders } from "@/lib/db/schema";
import { generateSign, safeEqual } from "@/lib/crypto";
import { eq } from "drizzle-orm";
import { withOrderColumnFallback } from "@/lib/db/queries";

const LOG_NOTIFY_DETAILS = process.env.NODE_ENV !== 'production';

function summarizeNotifyParams(params: Record<string, string>) {
    return {
        out_trade_no: params.out_trade_no,
        trade_status: params.trade_status,
        money: params.money
    }
}

async function processNotify(params: Record<string, string>) {
    if (LOG_NOTIFY_DETAILS) {
        console.log("[Notify] Processing params:", JSON.stringify(params));
    } else {
        console.log("[Notify] Processing:", summarizeNotifyParams(params));
    }

    // Verify Sign
    const merchantKey = process.env.MERCHANT_KEY;
    if (!merchantKey) {
        console.error("[Notify] MERCHANT_KEY is not configured");
        return new Response('error', { status: 500 });
    }

    if (!safeEqual(params.sign, generateSign(params, merchantKey))) {
        console.log("[Notify] Signature mismatch!");
        return new Response('fail', { status: 400 });
    }

    console.log("[Notify] Signature verified OK. trade_status:", params.trade_status);

    if (params.trade_status === 'TRADE_SUCCESS') {
        let orderId = params.out_trade_no;
        if (!orderId || !params.trade_no) return new Response('fail', { status: 400 });
        // Strip retry suffix if present (e.g. ORDER123_retry173654)
        if (orderId.includes('_retry')) {
            orderId = orderId.split('_retry')[0];
        }

        const tradeNo = params.trade_no;

        console.log("[Notify] Processing order:", orderId);

        // Find Order
        const order = await withOrderColumnFallback(async () => {
            return await db.query.orders.findFirst({
                where: eq(orders.orderId, orderId)
            });
        });

        console.log("[Notify] Order found:", order ? "YES" : "NO", "status:", order?.status);

        if (order) {
            // Verify Amount (Prevent penny-dropping)
            const notifyMoney = Number(params.money);
            const orderMoney = Number(order.amount);

            if (!params.money?.trim() || !Number.isFinite(notifyMoney) || !Number.isFinite(orderMoney)
                || notifyMoney < 0 || Math.round(notifyMoney * 100) !== Math.round(orderMoney * 100)) {
                console.error(`[Notify] Amount mismatch! Order: ${orderMoney}, Notify: ${notifyMoney}`);
                return new Response('fail', { status: 400 });
            }

            if (order.status === 'pending' || order.status === 'cancelled') {
                try {
                    const { processOrderFulfillment } = await import("@/lib/order-processing");
                    await processOrderFulfillment(orderId, notifyMoney, tradeNo);
                } catch (e) {
                    console.error("[Notify] Fulfillment error:", e);
                    const message = getErrorMessage(e).toLowerCase();
                    if (message.includes('amount mismatch') || message.includes('invalid trade number')) {
                        return new Response('fail', { status: 400 });
                    }
                    // Fulfillment defers delivery failures itself. An exception here means
                    // confirmed payment was not safely saved, so the gateway must retry.
                    return new Response('error', { status: 500 });
                }
            }
        }
    }

    return new Response('success');
}

// Handle GET requests (Linux DO Credit sends GET)
export async function GET(request: Request) {
    console.log("[Notify] Received GET callback");

    try {
        const url = new URL(request.url);
        const params: Record<string, string> = {};
        url.searchParams.forEach((value, key) => {
            params[key] = value;
        });

        return await processNotify(params);
    } catch (e) {
        console.error("[Notify] Error:", e);
        return new Response('error', { status: 500 });
    }
}

// Also handle POST requests for compatibility
export async function POST(request: Request) {
    console.log("[Notify] Received POST callback");

    try {
        const formData = await request.formData();
        const params: Record<string, string> = {};
        for (const [key, value] of formData.entries()) {
            if (typeof value !== 'string') return new Response('fail', { status: 400 });
            params[key] = value;
        }

        return await processNotify(params);
    } catch (e) {
        console.error("[Notify] Error:", e);
        return new Response('error', { status: 500 });
    }
}
