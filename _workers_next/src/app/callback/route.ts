import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getRequestBaseUrl } from "@/lib/url"
import { orderPagePath } from "@/lib/order-path"

function normalizeOrderId(input: string | null): string | null {
  if (!input) return null
  const trimmed = input.trim()
  if (!trimmed) return null
  // Handle "123?out_trade_no=123" style junk
  if (trimmed.includes("?")) {
    return trimmed.split("?")[0] || null
  }
  return trimmed
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const queryOrder =
    normalizeOrderId(url.searchParams.get("out_trade_no")) ||
    normalizeOrderId(url.searchParams.get("order_no")) ||
    normalizeOrderId(url.searchParams.get("orderId"))

  let orderId = queryOrder
  if (!orderId) {
    const cookieStore = await cookies()
    orderId = normalizeOrderId(cookieStore.get("ldc_pending_order")?.value ?? null)
  }

  return NextResponse.redirect(new URL(orderPagePath(orderId) || "/orders", getRequestBaseUrl(request)))
}
