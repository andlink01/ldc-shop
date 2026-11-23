'use client'

import type { AdminOrderSummary } from '@/lib/admin-types'
import { getErrorMessage } from '@/lib/errors'
import { getDeliveryIssue } from '@/lib/delivery-issue'

import Link from "next/link"
import { useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { markOrderDelivered, markOrderPaid, cancelOrder } from "@/actions/admin-orders"
import { retryOrderDelivery } from '@/actions/inventory'
import { useRouter } from 'next/navigation'
import { toast } from "sonner"
import { useI18n } from "@/lib/i18n/context"
import { CheckCircle, Truck, XCircle, ExternalLink } from "lucide-react"

export function AdminOrderActions({ order }: { order: AdminOrderSummary }) {
  const { t } = useI18n()
  const [loading, setLoading] = useState(false)
  const loadingRef = useRef(false)

  const router = useRouter()
  const status = order.status || 'pending'
  const canMarkPaid = status === 'pending'
  const canMarkDelivered = status === 'paid' && !!order.cardKey
  const canCancel = status === 'pending'

  const handle = async (action: 'paid' | 'delivered' | 'cancel' | 'retry') => {
    if (loadingRef.current) return
    try {
      loadingRef.current = true
      setLoading(true)
      if (action === 'retry') {
        const result = await retryOrderDelivery(order.orderId)
        if (result.delivered) toast.success(t('common.success'))
        else {
          const issue = getDeliveryIssue(result.supplierError)
          const message = t(`inventory.deliveryIssue.${issue.key}`, { status: issue.status ?? '' })
          if (issue.severity === 'attention') toast.error(message)
          else toast.info(message)
        }
        return
      }
      if (action === 'paid') {
        if (!confirm(t('admin.orders.confirmMarkPaid'))) return
        await markOrderPaid(order.orderId)
        toast.success(t('common.success'))
        return
      }
      if (action === 'delivered') {
        if (!confirm(t('admin.orders.confirmMarkDelivered'))) return
        await markOrderDelivered(order.orderId)
        toast.success(t('common.success'))
        return
      }
      if (action === 'cancel') {
        if (!confirm(t('admin.orders.confirmCancel'))) return
        await cancelOrder(order.orderId)
        toast.success(t('common.success'))
      }
    } catch (e) {
      toast.error(getErrorMessage(e))
    } finally {
      router.refresh()
      setLoading(false)
      loadingRef.current = false
    }
  }

  return (
    <>
      <Button asChild variant="outline" size="sm" title={t('admin.orders.view')}>
        <Link href={`/admin/orders/${order.orderId}`}>
          <ExternalLink className="h-3.5 w-3.5" />
        </Link>
      </Button>
      {status === 'paid' && !order.cardKey && order.productId !== 'payment_link' && (
        <Button variant="outline" size="sm" onClick={() => handle('retry')} disabled={loading}>{t('inventory.retryDelivery')}</Button>
      )}
      {canMarkPaid && (
        <Button variant="outline" size="sm" onClick={() => handle('paid')} title={t('admin.orders.markPaid')} disabled={loading}>
          <CheckCircle className="h-3.5 w-3.5" />
        </Button>
      )}
      {canMarkDelivered && (
        <Button variant="outline" size="sm" onClick={() => handle('delivered')} title={t('admin.orders.markDelivered')} disabled={loading}>
          <Truck className="h-3.5 w-3.5" />
        </Button>
      )}
      {canCancel && (
        <Button variant="destructive" size="sm" onClick={() => handle('cancel')} title={t('admin.orders.cancel')} disabled={loading}>
          <XCircle className="h-3.5 w-3.5" />
        </Button>
      )}
    </>
  )
}
