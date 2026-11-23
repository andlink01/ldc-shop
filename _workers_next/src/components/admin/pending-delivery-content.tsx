'use client'

import Link from 'next/link'
import { useTransition, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { AlertCircle, Package, PackageCheck, RefreshCw, Search } from 'lucide-react'
import { useI18n } from '@/lib/i18n/context'
import { AdminOrderActions } from '@/components/admin/order-actions'
import { SupplierRecoveryButton } from '@/components/admin/supplier-recovery-button'
import { RefundButton } from '@/components/admin/refund-button'
import { ClientDate } from '@/components/client-date'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { getDisplayUsername, getExternalProfileUrl } from '@/lib/user-profile-link'
import { getDeliveryIssue } from '@/lib/delivery-issue'
import type { PendingDeliveryOrder } from '@/lib/admin-fulfillment'

function buildUrl(query: string, page = 1) {
    const params = new URLSearchParams()
    if (query) params.set('q', query)
    if (page > 1) params.set('page', String(page))
    return `/admin/fulfillment${params.size ? `?${params}` : ''}`
}

function DeliveryStatus({ order, compact = false }: { order: PendingDeliveryOrder; compact?: boolean }) {
    const { t } = useI18n()
    const issue = getDeliveryIssue(order.supplierError, Boolean(order.onDemand))
    return <div className="space-y-2">
        <div className="flex flex-wrap gap-1.5">
            <Badge variant="secondary">{t('order.status.paid')}</Badge>
            <Badge variant={issue.severity === 'attention' ? 'destructive' : 'outline'}>{t(`inventory.deliveryState.${issue.severity}`)}</Badge>
        </div>
        {!compact && <p className="text-xs leading-relaxed text-muted-foreground">{t(`inventory.deliveryIssue.${issue.key}`, { status: issue.status ?? '' })}</p>}
        {(compact || issue.code) && <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">{t(compact ? 'inventory.deliveryDetails' : 'inventory.errorDetails')}</summary>
            {compact && <p className="mt-1 whitespace-normal leading-relaxed">{t(`inventory.deliveryIssue.${issue.key}`, { status: issue.status ?? '' })}</p>}
            {issue.code && <code className="mt-1 block break-all">{issue.code}</code>}
        </details>}
    </div>
}

function Buyer({ order }: { order: PendingDeliveryOrder }) {
    const name = getDisplayUsername(order.username, order.userId) || '—'
    const url = getExternalProfileUrl(order.username, order.userId)
    return url ? <a href={url} target="_blank" rel="noreferrer" className="text-sm font-medium text-primary hover:underline break-all">{name}</a>
        : <span className="text-sm font-medium break-all">{name}</span>
}

function DeliveryActions({ order }: { order: PendingDeliveryOrder }) {
    const { t } = useI18n()
    return <div className="ml-auto flex w-max items-center justify-end gap-1 sm:gap-2 [&_[data-slot=button]]:px-2 sm:[&_[data-slot=button]]:px-2.5">
        <Button asChild variant="outline" size="sm" title={t('inventory.manageCards')} aria-label={t('inventory.manageCards')}>
            <Link href={`/admin/cards/${order.productId}`}><Package className="h-3.5 w-3.5" aria-hidden="true" /></Link>
        </Button>
        <AdminOrderActions order={order} />
        {order.supplierError === 'supplier_endpoint_changed' && <SupplierRecoveryButton orderId={order.orderId} />}
        <RefundButton order={order} compact />
    </div>
}

export function PendingDeliveryContent({ orders, total, page, pageSize, query }: {
    orders: PendingDeliveryOrder[]; total: number; page: number; pageSize: number; query: string
}) {
    const { t } = useI18n()
    const router = useRouter()
    const [pending, startTransition] = useTransition()
    const totalPages = Math.max(1, Math.ceil(total / pageSize))
    const search = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault()
        const q = String(new FormData(event.currentTarget).get('q') || '').trim()
        startTransition(() => router.push(buildUrl(q)))
    }

    return <div className="space-y-6" aria-busy={pending}>
        <div className="flex flex-wrap items-center justify-between gap-3">
            <h1 className="text-3xl font-bold tracking-tight">{t('inventory.pendingDelivery')}</h1>
            <Button variant="outline" size="sm" disabled={pending} onClick={() => startTransition(() => router.refresh())}>
                <RefreshCw className={`h-4 w-4 ${pending ? 'animate-spin' : ''}`} />{t('inventory.refresh')}
            </Button>
        </div>
        <div className="flex gap-3 rounded-md border bg-card p-4 text-sm">
            <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
            <p className="leading-relaxed text-muted-foreground">{t('inventory.pendingHint')}</p>
        </div>
        <form onSubmit={search} className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <Input key={query} name="q" defaultValue={query} maxLength={200} placeholder={t('inventory.deliverySearch')}
                aria-label={t('inventory.deliverySearch')} className="sm:max-w-[360px]" />
            <div className="flex gap-2">
                <Button type="submit" variant="outline" size="sm" disabled={pending}><Search className="h-4 w-4" />{t('admin.orders.search')}</Button>
                {query && <Button asChild variant="outline" size="sm"><Link href="/admin/fulfillment">{t('admin.orders.clearFilters')}</Link></Button>}
            </div>
        </form>
        <div className="text-sm text-muted-foreground">{t('admin.orders.showing', {
            from: total ? (page - 1) * pageSize + 1 : 0, to: Math.min(page * pageSize, total), total,
        })}</div>
        {!orders.length ? <div className="rounded-md border bg-card py-14 text-center text-muted-foreground">
            <PackageCheck className="mx-auto mb-3 h-9 w-9" />
            <p>{t(query ? 'inventory.noDeliveryMatch' : 'inventory.noPending')}</p>
        </div> : <>
            <div className="hidden rounded-md border bg-card lg:block">
                <Table>
                    <TableHeader><TableRow>
                        {['orderId', 'product', 'user', 'amount'].map(key => <TableHead key={key}>{t(`admin.orders.${key}`)}</TableHead>)}
                        <TableHead>{t('order.paidAt')}</TableHead><TableHead>{t('admin.orders.status')}</TableHead>
                        <TableHead className="text-right">{t('admin.orders.actions')}</TableHead>
                    </TableRow></TableHeader>
                    <TableBody>{orders.map(order => <TableRow key={order.orderId}>
                        <TableCell className="font-mono text-xs"><Link href={`/admin/orders/${order.orderId}`} className="hover:underline">{order.orderId}</Link></TableCell>
                        <TableCell>
                            <span className="font-medium">{order.productName}</span>
                            {order.variantLabel && <span className="ml-1.5 text-muted-foreground">· {order.variantLabel}</span>}
                            <span className="ml-1.5 text-xs text-muted-foreground">× {order.quantity}</span>
                        </TableCell>
                        <TableCell className="max-w-[140px] whitespace-normal"><Buyer order={order} /></TableCell>
                        <TableCell>{Number(order.amount)}</TableCell>
                        <TableCell className="text-xs text-muted-foreground"><ClientDate value={order.paidAt} format="dateTime" placeholder="—" /></TableCell>
                        <TableCell className="min-w-[140px] max-w-[280px] whitespace-normal"><DeliveryStatus order={order} compact /></TableCell>
                        <TableCell><DeliveryActions order={order} /></TableCell>
                    </TableRow>)}</TableBody>
                </Table>
            </div>
            <div className="space-y-3 lg:hidden">{orders.map(order => <article key={order.orderId} className="space-y-4 rounded-md border bg-card p-4">
                <Link href={`/admin/orders/${order.orderId}`} className="block break-all font-mono text-xs text-primary hover:underline">{order.orderId}</Link>
                <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0"><p className="break-words font-medium">{order.productName}</p>
                        {order.variantLabel && <p className="mt-1 text-xs text-muted-foreground">{order.variantLabel}</p>}</div>
                    <span className="shrink-0 text-sm">× {order.quantity}</span>
                </div>
                <dl className="grid grid-cols-2 gap-3 text-sm">
                    <div><dt className="mb-1 text-xs text-muted-foreground">{t('inventory.buyer')}</dt><dd><Buyer order={order} /></dd></div>
                    <div><dt className="mb-1 text-xs text-muted-foreground">{t('admin.orders.amount')}</dt><dd>{Number(order.amount)}</dd></div>
                    <div className="col-span-2"><dt className="mb-1 text-xs text-muted-foreground">{t('order.paidAt')}</dt>
                        <dd><ClientDate value={order.paidAt} format="dateTime" placeholder="—" /></dd></div>
                </dl>
                <div className="border-t pt-3"><DeliveryStatus order={order} /></div>
                <div className="overflow-x-auto"><DeliveryActions order={order} /></div>
            </article>)}</div>
        </>}
        <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">{t('admin.orders.page', { page, totalPages })}</p>
            <div className="flex gap-2">
                {page > 1 ? <Button asChild variant="outline" size="sm"><Link href={buildUrl(query, page - 1)}>{t('admin.orders.prev')}</Link></Button>
                    : <Button variant="outline" size="sm" disabled>{t('admin.orders.prev')}</Button>}
                {page < totalPages ? <Button asChild variant="outline" size="sm"><Link href={buildUrl(query, page + 1)}>{t('admin.orders.next')}</Link></Button>
                    : <Button variant="outline" size="sm" disabled>{t('admin.orders.next')}</Button>}
            </div>
        </div>
    </div>
}
