import { PaymentLinkContent } from "@/components/payment-link-content"
import { md5, safeEqual } from "@/lib/crypto"
import { getAdminUsernames } from "@/lib/admin-auth"
import { unstable_noStore } from "next/cache"
import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"

function firstParam(value: string | string[] | undefined): string | undefined {
    if (!value) return undefined
    return Array.isArray(value) ? value[0] : value
}

export default async function PaymentLinkPage(props: {
    searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
    unstable_noStore()
    const searchParams = await props.searchParams
    const payeeParam = (firstParam(searchParams.to) || '').trim()
    const sigParam = (firstParam(searchParams.sig) || '').trim()
    const session = await auth()
    if (!session?.user?.id) {
        const params = new URLSearchParams()
        if (payeeParam) params.set('to', payeeParam)
        if (sigParam) params.set('sig', sigParam)
        const callbackUrl = params.size ? `/pay?${params}` : '/pay'
        redirect(`/login?callbackUrl=${encodeURIComponent(callbackUrl)}`)
    }

    const adminUsers = getAdminUsernames()
    const fallbackPayee = adminUsers[0] || null
    const matchedAdmin = payeeParam
        ? adminUsers.find((name) => name.toLowerCase() === payeeParam.toLowerCase())
        : undefined
    const secret = process.env.MERCHANT_KEY || ''
    const expectedSig = payeeParam && secret ? md5(`payee=${payeeParam}${secret}`) : null
    const hasValidSig = !!(payeeParam && safeEqual(sigParam, expectedSig))
    const payee = hasValidSig ? (matchedAdmin || fallbackPayee) : fallbackPayee

    return <PaymentLinkContent payee={payee} />
}
