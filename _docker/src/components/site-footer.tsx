import { getStorefrontSettings } from "@/lib/storefront"
import { FooterContent } from "./footer-content"
import { APP_VERSION } from "@/lib/version"

export async function SiteFooter() {
    let shopFooter: string | null = null
    try {
        shopFooter = (await getStorefrontSettings()).shop_footer ?? null
    } catch {
        shopFooter = null
    }

    return <FooterContent customFooter={shopFooter} version={APP_VERSION} />
}
