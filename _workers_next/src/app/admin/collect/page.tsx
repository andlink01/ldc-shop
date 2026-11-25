import { requireAdminPage } from "@/lib/admin-guard"
import { headers } from "next/headers"
import { auth } from "@/lib/auth"
import { AdminPaymentCodeContent } from "@/components/admin/payment-code-content"
import { md5 } from "@/lib/crypto"
import { getAdminUsernames } from "@/lib/admin-auth"
import { getBaseUrlFromHeaders } from "@/lib/url"

async function resolveBaseUrl() {
    return getBaseUrlFromHeaders(await headers(), 'http://localhost:3000')
}

export default async function AdminCollectPage() {
    await requireAdminPage()
    const baseUrl = await resolveBaseUrl()
    const session = await auth()
    const adminUsers = getAdminUsernames()
    const adminFromEnv = adminUsers[0] || null
    const payeeCandidate = session?.user?.username || session?.user?.name || adminFromEnv || null
    const payeeMatch = payeeCandidate
        ? adminUsers.find((name) => name.toLowerCase() === payeeCandidate.toLowerCase())
        : undefined
    const payee = payeeMatch || payeeCandidate
    const secret = process.env.MERCHANT_KEY || ''
    const sig = payee && secret ? md5(`payee=${payee}${secret}`) : null
    const payLink = payee && sig
        ? `${baseUrl}/pay?to=${encodeURIComponent(payee)}&sig=${sig}`
        : `${baseUrl}/pay`

    return <AdminPaymentCodeContent payLink={payLink} payee={payee} />
}
