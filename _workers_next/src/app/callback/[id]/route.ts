import { NextResponse } from "next/server"
import { getRequestBaseUrl } from "@/lib/url"
import { orderPagePath } from "@/lib/order-path"

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params
  return NextResponse.redirect(new URL(orderPagePath(id) || "/", getRequestBaseUrl(request)))
}
