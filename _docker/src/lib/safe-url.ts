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
