import { checkAdmin } from '@/actions/admin'
import { ensureDatabaseInitialized } from '@/lib/db/queries'
import { getPendingDeliveryOrders } from '@/lib/admin-fulfillment'
import { PendingDeliveryContent } from '@/components/admin/pending-delivery-content'

export const dynamic = 'force-dynamic'

export default async function FulfillmentPage({ searchParams }: {
    searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
    await checkAdmin()
    await ensureDatabaseInitialized()
    const data = await getPendingDeliveryOrders(searchParams ? await searchParams : {})
    return <PendingDeliveryContent {...data} />
}
