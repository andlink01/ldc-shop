import { NextResponse, type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { isAdminUsername } from '@/lib/admin-auth'
import { getRequestBaseUrl } from '@/lib/url'

/**
 * Runs before anything under /admin is rendered, so a visitor gets a real redirect instead of the
 * start of an admin page. It is a second check, not the only one: every admin page, export and
 * server action still identifies its caller itself, because an action can be posted to any path.
 *
 * This file must stay "middleware.ts". Next.js suggests renaming it to "proxy.ts", but a proxy runs
 * on the Node.js runtime, which OpenNext on Cloudflare only supports experimentally: with it every
 * page of the Worker answered HTTP 500 in the workerd tests (npm run test:production).
 */
export async function middleware(request: NextRequest) {
    const secret = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET || process.env.OAUTH_CLIENT_SECRET
    let username: unknown
    if (secret) {
        // The session cookie carries the __Secure- prefix on HTTPS and no prefix on plain HTTP.
        for (const secureCookie of [true, false]) {
            try { username = (await getToken({ req: request, secret, secureCookie }))?.username } catch { /* not a session of this shop */ }
            if (username) break
        }
    }
    if (typeof username === 'string' && isAdminUsername(username)) return NextResponse.next()

    // Only a page visit is sent to the storefront; an export or a submitted request is simply refused.
    const refused = { headers: { 'Cache-Control': 'no-store' } }
    if (/^\/admin\/(?:data|export)\/download\/?$/.test(request.nextUrl.pathname)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, ...refused })
    if (request.method !== 'GET' && request.method !== 'HEAD') return NextResponse.json({ error: 'Forbidden' }, { status: 403, ...refused })
    return NextResponse.redirect(new URL('/', getRequestBaseUrl(request)), { status: 307, ...refused })
}

export const config = { matcher: ['/admin', '/admin/:path*'] }
