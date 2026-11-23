'use client'

import type { AdminOrderSummary } from '@/lib/admin-types'
import { getErrorMessage } from '@/lib/errors'

import { Button } from "@/components/ui/button"
import { markOrderRefunded, proxyRefund } from "@/actions/refund"
import { verifyOrderRefundStatus } from "@/actions/admin-orders"
import { useRef, useState } from "react"
import { useRouter } from 'next/navigation'
import { toast } from "sonner"
import { Loader2, ExternalLink, CheckCircle, RefreshCcw } from "lucide-react"
import { useI18n } from "@/lib/i18n/context"

export function RefundButton({ order, compact = false }: { order: AdminOrderSummary; compact?: boolean }) {
    const [loading, setLoading] = useState(false)
    const [showMarkDone, setShowMarkDone] = useState(false)
    const [retryNeedsReview, setRetryNeedsReview] = useState(false)
    const lock = useRef(false)
    const router = useRouter()
    const { t } = useI18n()

    if (order.status !== 'delivered' && order.status !== 'paid') return null
    if (!order.tradeNo) return null
    if (Number(order.amount) <= 0) return null // No refund for orders paid entirely with points

    const handleRefund = async () => {
        if (lock.current) return
        if (!confirm(t(retryNeedsReview ? 'admin.orders.refundRetryConfirm' : 'admin.orders.refundProxyConfirm'))) return
        lock.current = true
        setLoading(true)
        try {
            const result = await proxyRefund(order.orderId, retryNeedsReview)
            if (result.processed) {
                toast.success(t('admin.orders.verifySuccessRefunded'))
            } else {
                toast.error(result.messageKey ? t(result.messageKey) : result.message || t('admin.orders.refundProxyNotProcessed'), { duration: 8000 })
                setRetryNeedsReview(result.needsReview === true)
                setShowMarkDone(result.needsVerification === true || (result.needsVerification === undefined && !result.inProgress && !result.messageKey))
            }
        } catch (e) {
            toast.error(getErrorMessage(e) || "Refund failed", { duration: 8000 })
            setShowMarkDone(true)
        } finally {
            router.refresh()
            lock.current = false
            setLoading(false)
        }
    }

    const handleMarkDone = async () => {
        if (lock.current) return
        if (!confirm(t('admin.orders.refundVerifyPlatform'))) return

        lock.current = true
        setLoading(true)
        try {
            await markOrderRefunded(order.orderId)
            toast.success(t('admin.orders.refundSuccess'))
            setShowMarkDone(false)
        } catch (e) {
            toast.error(getErrorMessage(e))
        } finally {
            router.refresh()
            lock.current = false
            setLoading(false)
        }
    }

    const handleVerify = async () => {
        if (lock.current) return
        lock.current = true
        setLoading(true)
        try {
            const result = await verifyOrderRefundStatus(order.orderId)
            if (result.success) {
                if (result.status === 0) { // Refunded
                    toast.success(t('admin.orders.verifySuccessRefunded'))
                } else if (result.status === 1) { // Paid
                    toast.info(t(result.canRetry === false ? 'admin.orders.refundInProgress' : 'admin.orders.verifyInfoPaid'))
                    setRetryNeedsReview(result.needsReview === true)
                    setShowMarkDone(false)
                } else {
                    toast.info(`${t('admin.orders.verifyStatus')}: ${result.msg}`)
                }
            } else {
                toast.error(result.error || t('common.error'))
            }
        } catch (e) {
            toast.error(getErrorMessage(e))
        } finally {
            router.refresh()
            lock.current = false
            setLoading(false)
        }
    }

    return (
        <div className={compact ? 'inline-flex shrink-0 items-center gap-1 sm:gap-2' : 'inline-flex shrink-0 items-center gap-2'}>
            <Button variant="outline" size="sm" onClick={handleVerify} disabled={loading} title={t('admin.orders.checkStatus')} aria-label={t('admin.orders.checkStatus')}>
                {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <><RefreshCcw className="h-3 w-3" /></>}
            </Button>
            <Button variant="outline" size="sm" onClick={handleRefund} disabled={loading || showMarkDone}
                title={t('admin.orders.refund')} aria-label={t('admin.orders.refund')}>
                {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <ExternalLink className={compact ? 'h-3 w-3' : 'h-3 w-3 mr-1'} />}
                {!compact && !loading && t('admin.orders.refund')}
            </Button>
            {showMarkDone && (
                <Button variant="default" size="sm" onClick={handleMarkDone} disabled={loading}
                    title={t('admin.orders.markRefunded')} aria-label={t('admin.orders.markRefunded')}>
                    {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle className={compact ? 'h-3 w-3' : 'h-3 w-3 mr-1'} />}
                    {!compact && !loading && t('admin.orders.markRefunded')}
                </Button>
            )}
        </div>
    )
}
