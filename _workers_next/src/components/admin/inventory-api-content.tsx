'use client'

import { getErrorMessage } from '@/lib/errors'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { createInventoryKey, viewInventoryKey, resetInventoryKey, setInventoryKeyEnabled, saveExpiryAlertMinutes } from '@/actions/inventory'
import { useI18n } from '@/lib/i18n/context'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { toast } from 'sonner'
import { ClientDate } from '@/components/client-date'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'

type KeyData = { id: string; name: string; prefix: string; productIds: string; canRead: boolean; canWrite: boolean; enabled: boolean; expiresAt: number | null; lastUsedAt: number | null; recoverable?: boolean }
type LogData = { id: string; keyId: string | null; action: string; productId: string | null; status: number; addedCount: number; replayed: boolean; error: string | null; createdAt: number }
type Props = { keysData: KeyData[]; products: { id: string; name: string }[]; logs: LogData[]; page: number; hasNext: boolean; keyFilter: string; statusFilter: string; alertMinutes: number }

export function InventoryApiContent(props: Props) {
    const { t } = useI18n(), router = useRouter()
    const [busy, setBusy] = useState(false), lock = useRef(false)
    const [token, setToken] = useState(''), [allProducts, setAllProducts] = useState(true)
    const [tokenName, setTokenName] = useState(''), [resetKey, setResetKey] = useState<KeyData | null>(null)
    const perform = async (fn: () => Promise<unknown>) => {
        if (lock.current) return
        lock.current = true; setBusy(true)
        try { if (await fn() === false) return; toast.success(t('common.success')); router.refresh() }
        catch (error) { toast.error(error instanceof Error ? getErrorMessage(error) : t('common.error')) }
        finally { lock.current = false; setBusy(false) }
    }
    const copyToken = async (value: string) => {
        try { await navigator.clipboard.writeText(value); toast.success(t('common.success')) }
        catch { toast.error(t('inventory.copyManually')) }
    }
    const revealToken = async (key: KeyData, copy: boolean) => {
        if (lock.current) return
        lock.current = true; setBusy(true)
        try {
            const result = await viewInventoryKey(key.id)
            if (!result.success) { toast.error(t(result.error)); return }
            setTokenName(key.name); setToken(result.token)
            if (copy) await copyToken(result.token)
        } catch { toast.error(t('common.error')) }
        finally { lock.current = false; setBusy(false) }
    }
    const date = (value: number | null) => value ? <ClientDate value={new Date(value)} format="dateTime" /> : '—'
    const pageLink = (page: number) => `/admin/inventory-api?${new URLSearchParams({ page: String(page), key: props.keyFilter, status: props.statusFilter })}`
    return <div className="space-y-6">
        <h1 className="text-2xl font-bold">{t('inventory.apiTitle')}</h1>
        <p className="text-sm text-muted-foreground">{t('inventory.apiHint')}</p>
        <ol className="list-decimal space-y-2 pl-5 text-sm text-muted-foreground">
            <li>{t('inventory.apiStepCreate')}</li>
            <li>{t('inventory.apiStepConnect')}</li>
            <li>{t('inventory.apiStepCheck')}</li>
        </ol>
        <p className="text-sm text-muted-foreground">{t('inventory.apiProcurementHint')}</p>
        <Card><CardHeader><CardTitle>{t('inventory.createKey')}</CardTitle></CardHeader><CardContent>
            <form className="space-y-4" onSubmit={event => {
                event.preventDefault()
                const form = event.currentTarget, data = new FormData(form)
                void perform(async () => {
                    const expires = String(data.get('expires') || '')
                    const result = await createInventoryKey({ name: String(data.get('name') || ''),
                        productIds: allProducts ? [] : data.getAll('products').map(String), canRead: data.has('read'), canWrite: data.has('write'),
                        expiresAt: expires ? new Date(expires).toISOString() : null })
                    if (!result.success) { toast.error(t(result.error)); return false }
                    setTokenName(String(data.get('name') || '')); setToken(result.token); form.reset(); setAllProducts(true)
                })
            }}>
                <label className="block text-sm">{t('inventory.keyName')}<Input name="name" placeholder={t('inventory.keyNamePlaceholder')} required maxLength={80} disabled={busy} /></label>
                <div className="flex flex-wrap gap-4">
                    <label><input type="checkbox" name="read" defaultChecked disabled={busy} /> {t('inventory.read')}</label>
                    <label><input type="checkbox" name="write" defaultChecked disabled={busy} /> {t('inventory.write')}</label>
                    <label><input type="checkbox" checked={allProducts} onChange={e => setAllProducts(e.target.checked)} disabled={busy} /> {t('inventory.allProducts')}</label>
                </div>
                {!allProducts && <label className="block text-sm">{t('inventory.chooseProducts')}<select name="products" multiple required disabled={busy} className="block w-full border rounded p-2 min-h-32">
                    {props.products.map(p => <option key={p.id} value={p.id}>{p.name} ({p.id})</option>)}
                </select></label>}
                <label className="block text-sm">{t('inventory.keyExpiry')}<Input type="datetime-local" name="expires" disabled={busy} /></label>
                <Button disabled={busy}>{t('inventory.createKey')}</Button>
            </form>
        </CardContent></Card>
        <Card><CardHeader><CardTitle>{t('inventory.keys')}</CardTitle></CardHeader><CardContent className="overflow-x-auto">
            <table className="w-full text-sm"><thead><tr>{['keyName', 'scope', 'permissions', 'keyExpiry', 'lastUsed', 'state', 'action'].map(k => <th key={k} className="p-2 text-left">{t(`inventory.${k}`)}</th>)}</tr></thead><tbody>
                {props.keysData.map(key => <tr key={key.id} className="border-t"><td className="p-2">{key.name}<div className="font-mono text-xs">{key.prefix}…</div></td>
                    <td className="p-2 max-w-64 break-words">{key.productIds === '[]' ? t('inventory.allProducts') : (JSON.parse(key.productIds) as string[]).join(', ')}</td>
                    <td className="p-2">{[key.canRead && t('inventory.read'), key.canWrite && t('inventory.write')].filter(Boolean).join(' / ')}</td>
                    <td className="p-2">{date(key.expiresAt)}</td><td className="p-2">{date(key.lastUsedAt)}</td>
                    <td className="p-2"><Badge variant={key.enabled ? 'default' : 'secondary'}>{t(key.enabled ? 'inventory.keyActive' : 'inventory.keyInactive')}</Badge></td>
                    <td className="p-2"><div className="flex flex-wrap gap-2">
                        <Button size="sm" variant="outline" disabled={busy} onClick={() => void revealToken(key, false)}>{t('inventory.viewKey')}</Button>
                        <Button size="sm" variant="outline" disabled={busy} onClick={() => void revealToken(key, true)}>{t('common.copy')}</Button>
                        <Button size="sm" variant="outline" disabled={busy} onClick={() => setResetKey(key)}>{t('inventory.resetKey')}</Button>
                        <Button size="sm" variant="outline" disabled={busy} onClick={() => void perform(() => setInventoryKeyEnabled(key.id, !key.enabled))}>{t(key.enabled ? 'inventory.disable' : 'inventory.enable')}</Button>
                    </div>{!key.recoverable && <p className="mt-2 text-xs text-muted-foreground">{t('inventory.legacyKeyHint')}</p>}</td>
                </tr>)}
            </tbody></table>
        </CardContent></Card>
        <Dialog open={Boolean(token)} onOpenChange={open => { if (!open) setToken('') }}>
            <DialogContent><DialogHeader><DialogTitle>{t('inventory.tokenLabel')}{tokenName ? `：${tokenName}` : ''}</DialogTitle><DialogDescription>{t('inventory.tokenOnce')}</DialogDescription></DialogHeader>
                <Input readOnly value={token} onFocus={event => event.currentTarget.select()} className="font-mono" aria-label={t('inventory.tokenLabel')} />
                <DialogFooter><Button onClick={() => void copyToken(token)}>{t('common.copy')}</Button><Button variant="outline" onClick={() => setToken('')}>{t('inventory.close')}</Button></DialogFooter>
            </DialogContent>
        </Dialog>
        <Dialog open={Boolean(resetKey)} onOpenChange={open => { if (!open && !busy) setResetKey(null) }}>
            <DialogContent><DialogHeader><DialogTitle>{t('inventory.resetKey')}</DialogTitle><DialogDescription>{t('inventory.resetKeyHint')}</DialogDescription></DialogHeader>
                <DialogFooter><Button variant="outline" disabled={busy} onClick={() => setResetKey(null)}>{t('common.cancel')}</Button><Button disabled={busy} onClick={() => {
                    if (!resetKey) return
                    const key = resetKey
                    void perform(async () => {
                        const result = await resetInventoryKey(key.id)
                        if (!result.success) { toast.error(t(result.error)); return false }
                        setResetKey(null); setTokenName(key.name); setToken(result.token)
                    })
                }}>{t('common.confirm')}</Button></DialogFooter>
            </DialogContent>
        </Dialog>
        <Card><CardHeader><CardTitle>{t('inventory.expiryAlert')}</CardTitle></CardHeader><CardContent>
            <form className="flex flex-wrap items-end gap-3" onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget); void perform(() => saveExpiryAlertMinutes(Number(data.get('minutes')))) }}>
                <label className="text-sm">{t('inventory.alertHint')}<Input name="minutes" type="number" min={0} max={10080} defaultValue={props.alertMinutes} required disabled={busy} /></label>
                <Button disabled={busy}>{t('common.save')}</Button>
            </form>
        </CardContent></Card>
        <Card><CardHeader><CardTitle>{t('inventory.logs')}</CardTitle></CardHeader><CardContent className="space-y-3 overflow-x-auto">
            <form className="flex flex-wrap gap-3" method="get">
                <select name="key" defaultValue={props.keyFilter} className="border rounded p-2" aria-label={t('inventory.keys')}><option value="">{t('inventory.allKeys')}</option>{props.keysData.map(k => <option key={k.id} value={k.id}>{k.name}</option>)}</select>
                <select name="status" defaultValue={props.statusFilter} className="border rounded p-2" aria-label={t('inventory.state')}><option value="">{t('inventory.allResults')}</option><option value="success">{t('common.success')}</option><option value="error">{t('common.error')}</option></select>
                <Button variant="outline">{t('inventory.search')}</Button>
            </form>
            <table className="w-full text-sm"><thead><tr>{['time', 'keyName', 'action', 'product', 'result', 'added'].map(k => <th key={k} className="p-2 text-left">{t(`inventory.${k}`)}</th>)}</tr></thead><tbody>
                {props.logs.map(log => <tr key={log.id} className="border-t"><td className="p-2 whitespace-nowrap">{date(log.createdAt)}</td><td className="p-2">{props.keysData.find(k => k.id === log.keyId)?.name || t('inventory.environmentKey')}</td>
                    <td className="p-2">{t(`inventory.${log.action}`)}</td><td className="p-2">{log.productId || '—'}</td><td className="p-2">{log.status}{log.error && <span className="ml-2">{log.error}</span>}{log.replayed && <span className="ml-2">{t('inventory.replayed')}</span>}</td><td className="p-2">{log.addedCount}</td></tr>)}
            </tbody></table>
            <div className="flex items-center gap-4">{props.page > 1 && <Link href={pageLink(props.page - 1)}>{t('inventory.previous')}</Link>}<span>{props.page}</span>{props.hasNext && <Link href={pageLink(props.page + 1)}>{t('inventory.next')}</Link>}</div>
        </CardContent></Card>
    </div>
}
