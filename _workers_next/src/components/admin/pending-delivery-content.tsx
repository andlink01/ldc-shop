'use client'

import { useI18n } from '@/lib/i18n/context'
import { AdminOrderActions } from '@/components/admin/order-actions'

type Row = { supplierError?: string | null; orderId: string; productId: string; productName: string; quantity: number; username: string | null; status: string | null; cardKey: string | null }

export function PendingDeliveryContent({ orders }: { orders: Row[] }) {
    const { t } = useI18n()
    return <div className="space-y-4">
        <h1 className="text-2xl font-bold">{t('inventory.pendingDelivery')}</h1>
        <p className="text-sm text-muted-foreground">{t('inventory.pendingHint')}</p>
        <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr>{['order', 'product', 'quantity', 'buyer', 'action'].map(k => <th key={k} className="p-3 text-left">{t(`inventory.${k}`)}</th>)}</tr></thead>
            <tbody>{orders.map(order => <tr key={order.orderId} className="border-t"><td className="p-3 font-mono">{order.orderId}</td><td className="p-3">{order.productName}{order.supplierError && <p className="text-xs text-destructive mt-1">{t('inventory.supplierError')}: {order.supplierError}</p>}</td><td className="p-3">{order.quantity}</td><td className="p-3">{order.username}</td><td className="p-3 flex gap-2"><AdminOrderActions order={order} /></td></tr>)}</tbody>
        </table>{!orders.length && <p className="py-8 text-center text-muted-foreground">{t('inventory.noPending')}</p>}</div>
    </div>
}
