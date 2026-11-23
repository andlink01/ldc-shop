import { cache } from 'react'
import { inArray } from 'drizzle-orm'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { settings } from '@/lib/db/schema'

const PUBLIC_SETTING_KEYS = [
    'shop_name', 'shop_description', 'noindex_enabled', 'shop_logo_updated_at',
    'theme_color', 'theme_font', 'currency_unit', 'shop_footer',
    'registry_opt_in', 'registry_hide_nav', 'wishlist_enabled', 'checkin_enabled',
] as const

export type StorefrontSettings = Partial<Record<typeof PUBLIC_SETTING_KEYS[number], string | null>>

// React cache shares reads only within one server render. The next request reads
// current settings and its own session; inventory and orders are never cached here.
export const getStorefrontSettings = cache(async (): Promise<StorefrontSettings> => {
    const rows = await db.select({ key: settings.key, value: settings.value }).from(settings)
        .where(inArray(settings.key, [...PUBLIC_SETTING_KEYS]))
    return Object.fromEntries(rows.map(row => [row.key, row.value]))
})

export const getStorefrontSession = cache(async () => auth())
