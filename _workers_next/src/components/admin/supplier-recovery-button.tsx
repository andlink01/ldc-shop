'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { getSupplierRecoveryInfo, resumeSupplierOrder } from '@/actions/inventory'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useI18n } from '@/lib/i18n/context'
import { getErrorMessage } from '@/lib/errors'
import { getDeliveryIssue } from '@/lib/delivery-issue'
import type { SupplierRecoveryInfo } from '@/lib/supplier-recovery'
import { toast } from 'sonner'

export function SupplierRecoveryButton({ orderId }: { orderId: string }) {
    const { t } = useI18n()
    const router = useRouter()
    const [open, setOpen] = useState(false)
    const [info, setInfo] = useState<SupplierRecoveryInfo | null>(null)
    const [confirmed, setConfirmed] = useState(false)
    const [busy, setBusy] = useState(false)
    const lock = useRef(false)
    const load = async () => {
        if (lock.current) return
        lock.current = true
        setBusy(true)
        setConfirmed(false)
        setInfo(null)
        setOpen(true)
        try {
            const result = await getSupplierRecoveryInfo(orderId)
            if (!result.success) { toast.error(t(result.error)); setOpen(false); router.refresh() }
            else setInfo(result.info)
        } catch (error) {
            toast.error(getErrorMessage(error))
            setOpen(false)
        } finally { lock.current = false; setBusy(false) }
    }
    const resume = async () => {
        if (lock.current || !confirmed || !info) return
        lock.current = true
        setBusy(true)
        try {
            const result = await resumeSupplierOrder(orderId, info.currentUrl, confirmed)
            if (!result.success) { toast.error(t(result.error)); return }
            if (result.delivered) toast.success(t('common.success'))
            else {
                const issue = getDeliveryIssue(result.supplierError)
                const message = t(`inventory.deliveryIssue.${issue.key}`, { status: issue.status ?? '' })
                if (issue.severity === 'attention') toast.error(message)
                else toast.info(message)
            }
            setOpen(false)
            setInfo(null)
        } catch (error) { toast.error(getErrorMessage(error)) }
        finally { lock.current = false; setBusy(false); router.refresh() }
    }
    return <>
        <Button variant="outline" size="sm" disabled={busy} onClick={load}>{t('inventory.recovery.open')}</Button>
        <Dialog open={open} onOpenChange={value => { if (!lock.current) setOpen(value) }}>
            <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle>{t('inventory.recovery.title')}</DialogTitle>
                    <DialogDescription>{t('inventory.recovery.hint')}</DialogDescription>
                </DialogHeader>
                {info && <div className="space-y-4 text-sm">
                    <dl className="space-y-3 rounded-md border bg-muted/30 p-3">
                        <div><dt className="mb-1 text-muted-foreground">{t('inventory.recovery.oldUrl')}</dt>
                            <dd className="space-y-1 break-all">{info.previousUrls.map(url => <p key={url}>{url}</p>)}</dd></div>
                        <div><dt className="mb-1 text-muted-foreground">{t('inventory.recovery.newUrl')}</dt><dd className="break-all">{info.currentUrl}</dd></div>
                        <div><dt className="mb-1 text-muted-foreground">{t('inventory.recovery.requestIds')}</dt>
                            <dd className="max-h-24 space-y-1 overflow-y-auto break-all font-mono text-xs">{info.requestIds.map(id => <p key={id}>{id}</p>)}</dd></div>
                    </dl>
                    <p className="text-muted-foreground">{t('inventory.recovery.warning')}</p>
                    <label className="flex cursor-pointer items-start gap-2 leading-relaxed">
                        <Checkbox checked={confirmed} disabled={busy} onCheckedChange={value => setConfirmed(value === true)} className="mt-0.5" />
                        <span>{t('inventory.recovery.confirm')}</span>
                    </label>
                </div>}
                <DialogFooter>
                    <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
                    <Button disabled={busy || !info || !confirmed} onClick={resume}>{t('inventory.recovery.resume')}</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    </>
}
