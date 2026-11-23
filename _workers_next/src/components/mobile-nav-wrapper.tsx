import { getStorefrontSession, getStorefrontSettings } from "@/lib/storefront"
import { isRegistryEnabled } from "@/lib/registry"
import { MobileNav } from "./mobile-nav"

export async function MobileNavWrapper() {
    const [session, storefront] = await Promise.all([
        getStorefrontSession(), getStorefrontSettings().catch(() => null),
    ])
    const user = session?.user

    // Check if admin (case-insensitive)
    const rawAdminUsers = process.env.ADMIN_USERS?.split(',') || []
    const adminUsers = rawAdminUsers.map(u => u.toLowerCase())
    const isAdmin = user?.username && adminUsers.includes(user.username.toLowerCase()) || false

    const registryEnabled = isRegistryEnabled()
    let registryOptIn = false
    let registryHideNav = false
    if (registryEnabled) {
        registryOptIn = storefront?.registry_opt_in === 'true'
        registryHideNav = storefront?.registry_hide_nav === 'true'
    }
    const showNav = registryEnabled && (registryOptIn || !registryHideNav)

    return <MobileNav isLoggedIn={!!user} isAdmin={isAdmin} showNav={showNav} />
}
