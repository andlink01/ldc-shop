import { NextResponse } from "next/server"
import { headers } from "next/headers"
import { getRegistryMetadata } from "@/lib/registry"
import { getBaseUrlFromHeaders, getRequestBaseUrl } from "@/lib/url"

export async function GET(request?: Request) {
    const origin = request ? getRequestBaseUrl(request) : getBaseUrlFromHeaders(await headers(), "")
    const metadata = await getRegistryMetadata(origin)
    return NextResponse.json(metadata, {
        headers: {
            "Cache-Control": "no-store",
        },
    })
}
