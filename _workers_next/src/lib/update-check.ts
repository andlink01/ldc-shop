import { APP_DIRECTORY } from '@/lib/version'

export const SHOP_REPOSITORY = 'andlink01/ldc-shop'
export const SHOP_REPOSITORY_URL = `https://github.com/${SHOP_REPOSITORY}`

export interface UpdateCheckResult {
    hasUpdate: boolean
    currentVersion: string
    latestVersion: string | null
    releaseUrl: string | null
    error?: string
}

function parseVersion(value: unknown) {
    if (typeof value !== 'string') throw new Error('invalid_version')
    const match = value.trim().match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/)
    if (!match) throw new Error('invalid_version')
    const numbers = match.slice(1, 4).map(Number)
    const prerelease = match[4]?.split('.') || []
    if (numbers.some((part) => !Number.isSafeInteger(part))
        || prerelease.some((part) => /^\d+$/.test(part) && (!Number.isSafeInteger(Number(part)) || (part.length > 1 && part.startsWith('0'))))) {
        throw new Error('invalid_version')
    }
    return { version: value.trim(), numbers, prerelease }
}

function compareVersions(a: ReturnType<typeof parseVersion>, b: ReturnType<typeof parseVersion>): number {
    for (let i = 0; i < 3; i++) {
        if (a.numbers[i] !== b.numbers[i]) return a.numbers[i] > b.numbers[i] ? 1 : -1
    }
    if (!a.prerelease.length || !b.prerelease.length) {
        return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length ? -1 : 1
    }
    for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
        const left = a.prerelease[i], right = b.prerelease[i]
        if (left === undefined) return -1
        if (right === undefined) return 1
        if (left === right) continue
        const leftNumeric = /^\d+$/.test(left), rightNumeric = /^\d+$/.test(right)
        if (leftNumeric && rightNumeric) return Number(left) > Number(right) ? 1 : -1
        if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
        return left > right ? 1 : -1
    }
    return 0
}

// Releases and tags inherited from upstream do not describe this fork's main branch.
export async function checkRepositoryForUpdates(currentVersion: string): Promise<UpdateCheckResult> {
    try {
        const response = await fetch(
            `https://raw.githubusercontent.com/${SHOP_REPOSITORY}/main/${APP_DIRECTORY}/package.json`,
            { headers: { Accept: 'application/json' }, cache: 'no-store' },
        )
        if (!response.ok) throw new Error(`Update check HTTP ${response.status}`)
        const manifest: unknown = await response.json()
        if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || !('version' in manifest)) {
            throw new Error('invalid_version_manifest')
        }
        const latest = parseVersion(manifest.version)
        const current = parseVersion(currentVersion)
        return {
            hasUpdate: compareVersions(latest, current) > 0,
            currentVersion,
            latestVersion: latest.version,
            releaseUrl: `${SHOP_REPOSITORY_URL}/tree/main/${APP_DIRECTORY}`,
        }
    } catch (error: unknown) {
        return {
            hasUpdate: false, currentVersion, latestVersion: null, releaseUrl: null,
            error: error instanceof Error ? error.message : 'update_check_failed',
        }
    }
}
