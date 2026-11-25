export interface AdminUserCandidate {
    id?: string | null
    username?: string | null
    provider?: string | null
}

export function getAdminUsernames() {
    return (process.env.ADMIN_USERS || '')
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean)
}

export function isAdminUsername(username?: string | null) {
    if (!username) return false
    const adminUsers = getAdminUsernames()
    return adminUsers.some((name) => name.toLowerCase() === username.toLowerCase())
}

export function isAdminUser(user?: AdminUserCandidate | null) {
    const username = typeof user?.username === 'string' ? user.username : ''
    if (!username || !isAdminUsername(username)) return false

    const normalizedName = username.trim().toLowerCase()
    const provider = typeof user?.provider === 'string' ? user.provider.trim().toLowerCase() : ''
    const userId = typeof user?.id === 'string' ? user.id.trim().toLowerCase() : ''

    if (normalizedName.startsWith('gh_')) {
        if (provider) return provider === 'github'
        return userId.startsWith('github:')
    }

    if (provider === 'github' || userId.startsWith('github:')) {
        return false
    }

    return true
}
