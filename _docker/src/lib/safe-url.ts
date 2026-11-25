// Links that come from stored or third-party data are checked before use, so
// a javascript: or off-site address can never be placed in an href.

export function safeExternalUrl(input: unknown): string {
    if (typeof input !== 'string') return '#'
    try {
        const url = new URL(input.trim())
        return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password ? url.toString() : '#'
    } catch {
        return '#'
    }
}

export function safeInternalPath(input: unknown): string | undefined {
    if (typeof input !== 'string') return undefined
    const path = input.trim()
    // One leading slash only: "//host" and "/\host" leave the site.
    if (path.length > 500 || !path.startsWith('/') || path.startsWith('//') || path.includes('\\') || /\s/.test(path)) return undefined
    return path
}

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.arpa', '.home', '.lan']

function isBlockedIpv4Tuple(parts: number[]): boolean {
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true
    const [a, b, c] = parts
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return true
    if (a === 192 && b === 88 && c === 99) return true
    if (a === 192 && b === 168) return true
    if (a === 198 && (b === 18 || b === 19)) return true
    if (a === 198 && b === 51 && c === 100) return true
    if (a === 203 && b === 0 && c === 113) return true
    if (a >= 224) return true
    return false
}

function expandIpv6Hextets(raw: string): number[] | null {
    const clean = raw.toLowerCase()
    const doubleColonParts = clean.split('::')
    if (doubleColonParts.length > 2) return null

    const parseSide = (side: string): number[] | null => {
        if (!side) return []
        const tokens = side.split(':')
        const out: number[] = []
        for (let i = 0; i < tokens.length; i++) {
            const token = tokens[i]
            if (!token) return null
            if (token.includes('.')) {
                if (i !== tokens.length - 1) return null
                const ipv4Parts = token.split('.').map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : -1))
                if (ipv4Parts.length !== 4 || ipv4Parts.some((n) => n < 0 || n > 255)) return null
                out.push((ipv4Parts[0] << 8) | ipv4Parts[1], (ipv4Parts[2] << 8) | ipv4Parts[3])
            } else {
                if (!/^[0-9a-f]{1,4}$/.test(token)) return null
                out.push(parseInt(token, 16))
            }
        }
        return out
    }

    const left = parseSide(doubleColonParts[0] || '')
    const right = doubleColonParts.length === 2 ? parseSide(doubleColonParts[1] || '') : []
    if (!left || !right) return null

    if (doubleColonParts.length === 1) {
        return left.length === 8 ? left : null
    }
    const missing = 8 - (left.length + right.length)
    if (missing < 1) return null
    return [...left, ...new Array(missing).fill(0), ...right]
}

function isBlockedIpv6Host(host: string): boolean {
    const hextets = expandIpv6Hextets(host)
    if (!hextets) return true

    const allZero = hextets.every((h) => h === 0)
    if (allZero) return true

    const isLoopback = hextets.slice(0, 7).every((h) => h === 0) && hextets[7] === 1
    if (isLoopback) return true

    const first = hextets[0]
    // Unique local fc00::/7, link-local fe80::/10, site-local fec0::/10, multicast ff00::/8
    if ((first & 0xfe00) === 0xfc00) return true
    if ((first & 0xffc0) === 0xfe80) return true
    if ((first & 0xffc0) === 0xfec0) return true
    if ((first & 0xff00) === 0xff00) return true

    // IPv4-mapped ::ffff:a.b.c.d and IPv4-compatible ::a.b.c.d
    const isIpv4Mapped = hextets.slice(0, 5).every((h) => h === 0) && hextets[5] === 0xffff
    const isIpv4Compat = hextets.slice(0, 6).every((h) => h === 0) && !(hextets[6] === 0 && hextets[7] <= 1)
    // NAT64 64:ff9b::/96
    const isNat64 = hextets[0] === 0x0064 && hextets[1] === 0xff9b
    if (isIpv4Mapped || isIpv4Compat || (isNat64 && hextets[2] === 0 && hextets[3] === 0 && hextets[4] === 0 && hextets[5] === 0)) {
        const ipv4 = [hextets[6] >> 8, hextets[6] & 0xff, hextets[7] >> 8, hextets[7] & 0xff]
        return isBlockedIpv4Tuple(ipv4)
    }

    // 6to4 2002::/16 embeds IPv4 in hextets[1..2]
    if (first === 0x2002) {
        const ipv4 = [hextets[1] >> 8, hextets[1] & 0xff, hextets[2] >> 8, hextets[2] & 0xff]
        if (isBlockedIpv4Tuple(ipv4)) return true
    }

    // Teredo 2001:0000::/32
    if (first === 0x2001 && hextets[1] === 0x0000) return true

    return false
}

export function isBlockedOutboundHostname(rawHostname: string): boolean {
    let host = String(rawHostname || '').trim().toLowerCase().replace(/\.+$/, '')
    if (!host || /[\s@/\\?%#]/.test(host)) return true

    if (host.startsWith('[') && host.endsWith(']')) {
        host = host.slice(1, -1)
        if (!host) return true
    }

    if (host.includes(':')) {
        return isBlockedIpv6Host(host)
    }

    if (/^\d+$/.test(host)) return true

    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
        return isBlockedIpv4Tuple(host.split('.').map(Number))
    }

    if (host === 'localhost' || host === 'localhost.localdomain' || host === 'metadata.google.internal') {
        return true
    }
    if (BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
        return true
    }
    // Single-label hostnames (e.g. "metadata", "redis", "db") target internal services.
    if (!host.includes('.')) {
        return true
    }
    return false
}

export function safeOutboundHttpUrl(input: unknown, options?: { disallowSearch?: boolean }): string | null {
    if (typeof input !== 'string') return null
    const trimmed = input.trim()
    if (!trimmed) return null
    try {
        const parsed = new URL(trimmed)
        if (!['http:', 'https:'].includes(parsed.protocol)) return null
        if (parsed.username || parsed.password) return null
        if (options?.disallowSearch && (parsed.search || parsed.hash)) return null
        if (isBlockedOutboundHostname(parsed.hostname)) return null
        return parsed.toString()
    } catch {
        return null
    }
}

export const ALLOWED_IMAGE_MIME_TYPES = new Set([
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
    'image/x-icon',
    'image/vnd.microsoft.icon',
    'image/svg+xml',
])

export function normalizeImageMimeType(rawContentType: string | null | undefined): string | null {
    if (!rawContentType) return null
    const base = rawContentType.split(';')[0].trim().toLowerCase()
    const normalized = base === 'image/jpg' ? 'image/jpeg' : base
    return ALLOWED_IMAGE_MIME_TYPES.has(normalized) ? normalized : null
}

export function isSafeSvgContent(svg: string): boolean {
    if (typeof svg !== 'string') return false
    const trimmed = svg.trim()
    if (!trimmed || trimmed.length > 1_000_000) return false
    if (!/<svg[\s>/]/i.test(trimmed)) return false

    const decoded = trimmed
        .replace(/&#x([0-9a-f]+);?/gi, (_, hex) => {
            const code = parseInt(hex, 16)
            return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
        })
        .replace(/&#(\d+);?/g, (_, dec) => {
            const code = parseInt(dec, 10)
            return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
        })
        .replace(/&colon;/gi, ':')
        .replace(/&tab;|&newline;/gi, '')

    const forbiddenPattern = /<\s*(?:script|foreignObject|iframe|object|embed|applet|meta|base|set)\b|(?:^|[\s/])on[a-z]+\s*=|\battributeName\s*=\s*["']?\s*on[a-z]+|(?:javascript|vbscript|livescript)\s*:|data\s*:\s*text\/html|@import\b/im
    return !forbiddenPattern.test(trimmed) && !forbiddenPattern.test(decoded)
}

export function decodeSafeImageDataUrl(rawUrl: string): { contentType: string; body: ArrayBuffer | string } | null {
    if (typeof rawUrl !== 'string') return null
    const trimmed = rawUrl.trim()
    if (!trimmed || trimmed.length > 1_000_000) return null

    const match = /^data:([a-z0-9.+\/-]+)((?:;[a-z0-9-]+=[a-z0-9.+_-]+)*)(;base64)?,([\s\S]*)$/i.exec(trimmed)
    if (!match) return null

    const mime = normalizeImageMimeType(match[1])
    if (!mime) return null

    const isBase64 = Boolean(match[3])
    const payload = match[4]
    if (!payload) return null

    if (isBase64) {
        const cleanBase64 = payload.replace(/\s+/g, '')
        if (!cleanBase64 || cleanBase64.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(cleanBase64)) {
            return null
        }
        try {
            const binary = atob(cleanBase64)
            if (!binary.length || binary.length > 750_000) return null
            const bytes = new Uint8Array(binary.length)
            for (let i = 0; i < binary.length; i++) {
                bytes[i] = binary.charCodeAt(i)
            }
            if (mime === 'image/svg+xml') {
                const svgText = new TextDecoder().decode(bytes)
                if (!isSafeSvgContent(svgText)) return null
                return { contentType: mime, body: svgText }
            }
            return { contentType: mime, body: bytes.buffer }
        } catch {
            return null
        }
    }

    if (mime !== 'image/svg+xml') {
        return null
    }

    try {
        const svgText = decodeURIComponent(payload)
        if (!isSafeSvgContent(svgText)) return null
        return { contentType: mime, body: svgText }
    } catch {
        return null
    }
}
