'use client'

import { useCallback, useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { modelModalities } from '@studio/domain'
import { apiErrorMessage } from '@/lib/api-error'
import {
  BoxesIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  EyeIcon,
  EyeOffIcon,
  LoaderCircleIcon,
  PlusIcon,
  Trash2Icon,
} from 'lucide-react'
import type { Catalog, CatalogHiddenInfo, CatalogModel } from '@/lib/api'
import { translateEnum, useI18n } from '@/lib/i18n'
import { useSession } from '@/lib/session'
import type { AsyncState } from '@/lib/use-async'
import { useAsync } from '@/lib/use-async'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { Field } from '@/components/ui/field'
import { Hint } from '@/components/ui/hint'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { TableSkeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ErrorState } from '@/components/error-state'
import { GuardedButton, usePermission } from '@/components/permission'

export function CatalogsPanel({ catalogs, onChanged }: { catalogs: AsyncState<Catalog[]>; onChanged(): void }) {
  const { t } = useI18n()
  const { api } = useSession()
  const { can } = usePermission()
  const manage = can('providers:manage')

  const loadHidden = useCallback(() => api<CatalogHiddenInfo>('/providers/catalogs/hidden'), [api])
  const hidden = useAsync<CatalogHiddenInfo>(loadHidden, { providers: [], models: [] })

  /** Every overlay mutation lands in two places — the catalogs view and the hidden list. */
  const refresh = useCallback(() => {
    hidden.reload()
    onChanged()
  }, [hidden, onChanged])

  /** Fire-and-forget mutations (row hide, chip restore): failures surface as a toast. */
  async function run(action: () => Promise<unknown>) {
    try {
      await action()
      refresh()
    } catch (err) {
      toast.error(apiErrorMessage(err, t))
    }
  }

  const unhideModel = (provider: string, model: string) =>
    run(() => api(`/providers/catalogs/${provider}/hide?model=${encodeURIComponent(model)}`, { method: 'DELETE' }))
  const unhideProvider = (provider: string) =>
    run(() => api(`/providers/catalogs/${provider}/hide`, { method: 'DELETE' }))

  const hasHiddenProviders = hidden.data.providers.length > 0

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-base font-semibold">{t('models.catalogs')}</h2>
        <p className="text-muted-foreground text-sm">{t('models.catalogsHint')}</p>
      </div>

      {catalogs.loading && catalogs.data.length === 0 ? (
        <Card>
          <TableSkeleton rows={4} columns={4} />
        </Card>
      ) : catalogs.data.length === 0 && !hasHiddenProviders ? (
        <EmptyState icon={<BoxesIcon />} title={t('common.empty')} />
      ) : (
        <div className="space-y-4">
          {catalogs.data.map(catalog => (
            <CatalogCard
              key={catalog.provider}
              catalog={catalog}
              manage={manage}
              hiddenModels={hidden.data.models.filter(row => row.provider === catalog.provider)}
              onRun={run}
              onRefresh={refresh}
            />
          ))}
        </div>
      )}

      {hasHiddenProviders && (
        <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-sm">
          <span className="text-xs font-medium">{t('models.hiddenProviders')}</span>
          {hidden.data.providers.map(entry => (
            <Hint key={entry.provider} text={t('models.restore')}>
              <button
                type="button"
                onClick={() => unhideProvider(entry.provider)}
                aria-label={`${entry.label} · ${t('models.restore')}`}
                className="bg-muted hover:bg-muted/70 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs transition-colors"
              >
                <EyeIcon className="size-3" />
                {entry.label}
              </button>
            </Hint>
          ))}
        </div>
      )}
    </div>
  )
}

/** 参考型清单：默认收起，卡头留模型数与目录版本，展开才见全表。 */
function CatalogCard({
  catalog,
  manage,
  hiddenModels,
  onRun,
  onRefresh,
}: {
  catalog: Catalog
  manage: boolean
  hiddenModels: CatalogHiddenInfo['models']
  onRun(action: () => Promise<unknown>): Promise<void>
  onRefresh(): void
}) {
  const { t } = useI18n()
  const { api } = useSession()
  const [open, setOpen] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [confirmHide, setConfirmHide] = useState(false)

  const hideModel = (model: string) =>
    onRun(() => api(`/providers/catalogs/${catalog.provider}/hide`, { method: 'POST', body: JSON.stringify({ model }) }))
  const unhideModel = (model: string) =>
    onRun(() => api(`/providers/catalogs/${catalog.provider}/hide?model=${encodeURIComponent(model)}`, { method: 'DELETE' }))

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start gap-3">
          <button
            type="button"
            aria-expanded={open}
            aria-label={open ? t('common.collapse') : t('common.expand')}
            onClick={() => setOpen(value => !value)}
            className="text-muted-foreground hover:text-foreground mt-1 shrink-0"
          >
            {open ? <ChevronDownIcon className="size-4" /> : <ChevronRightIcon className="size-4" />}
          </button>
          <span className="bg-primary/10 text-primary flex size-9 shrink-0 items-center justify-center rounded-lg">
            <BoxesIcon className="size-4.5" />
          </span>
          <div className="min-w-0 space-y-1.5">
            <CardTitle className="flex flex-wrap items-center gap-2">
              {catalog.label}
              <Badge variant="outline">{catalog.provider}</Badge>
            </CardTitle>
            <CardDescription className="truncate font-mono text-xs">
              {catalog.defaultBaseUrl ?? t('models.hostFromOperator')} · {t('models.catalogVersion')}{' '}
              {catalog.catalogVersion}
            </CardDescription>
          </div>
        </div>
        <CardAction>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Badge variant="muted">{t('models.capabilityCount', { count: catalog.models.length })}</Badge>
            {manage && (
              <>
                <Button variant="outline" size="sm" onClick={() => setAddOpen(true)}>
                  <PlusIcon />
                  {t('models.addCatalogModel')}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirmHide(true)}>
                  <EyeOffIcon />
                  {t('models.hideVendor')}
                </Button>
              </>
            )}
          </div>
        </CardAction>
      </CardHeader>

      {open && (catalog.models.length === 0 ? (
        <p className="text-muted-foreground px-6 text-sm">{t('models.noCapabilities')}</p>
      ) : (
        <div className="border-t">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>{t('common.model')}</TableHead>
                <TableHead>{t('common.modality')}</TableHead>
                <TableHead>{t('models.inputs')}</TableHead>
                <TableHead>{t('models.spec')}</TableHead>
                {manage && <TableHead className="w-16" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {catalog.models.map(model => (
                // One model name can serve several modalities (wan3.0-video is both
                // t2v and i2v), so the key must include the modality to stay unique.
                <CatalogModelRow key={`${model.model}:${model.modality}`} model={model} manage={manage} onHide={() => hideModel(model.model)} onDelete={() => onRun(() => api(`/providers/catalogs/entries/${model.entryId}`, { method: 'DELETE' }))} />
              ))}
            </TableBody>
          </Table>
        </div>
      ))}

      {open && hiddenModels.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-t px-6 py-3">
          <span className="text-muted-foreground text-xs font-medium">{t('models.hiddenModels', { count: hiddenModels.length })}</span>
          {hiddenModels.map(row => (
            <Tooltip key={row.model}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => unhideModel(row.model)}
                  className="bg-muted hover:bg-muted/70 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs transition-colors"
                >
                  <EyeIcon className="size-3" />
                  {row.displayName}
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">{t('models.restoreHint')}</TooltipContent>
            </Tooltip>
          ))}
        </div>
      )}

      <AddCatalogModelDialog provider={catalog.provider} open={addOpen} onOpenChange={setAddOpen} onDone={onRefresh} />

      <AlertDialog open={confirmHide} onOpenChange={setConfirmHide}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('models.hideVendorConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('models.hideVendorConfirmBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmHide(false)
                void onRun(() => api(`/providers/catalogs/${catalog.provider}/hide`, { method: 'POST', body: JSON.stringify({}) }))
              }}
            >
              {t('models.hideVendor')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}

function CatalogModelRow({ model, manage, onHide, onDelete }: { model: CatalogModel; manage: boolean; onHide(): void; onDelete(): void }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const spec = model.spec ?? {}
  const specKeys = Object.keys(spec)

  return (
    <TableRow>
      <TableCell>
        <p className="font-medium">
          {model.model}
          {model.source === 'custom' && (
            <Badge variant="info" className="ml-2">{t('models.customEntry')}</Badge>
          )}
        </p>
        {model.displayName && model.displayName !== model.model && (
          <p className="text-muted-foreground text-xs">{model.displayName}</p>
        )}
      </TableCell>
      <TableCell>
        <Badge variant="outline">{translateEnum(t, 'modality', model.modality)}</Badge>
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap gap-1">
          {model.acceptsFirstFrame && <Badge variant="muted">{t('models.firstFrame')}</Badge>}
          {model.acceptsReferenceImages && (
            <Badge variant="muted">
              {t('models.referenceImages')}
              {model.maxReferenceImages ? ` · ${model.maxReferenceImages}` : ''}
            </Badge>
          )}
          {!model.acceptsFirstFrame && !model.acceptsReferenceImages && (
            <span className="text-muted-foreground">—</span>
          )}
        </div>
      </TableCell>
      <TableCell>
        {specKeys.length === 0 ? (
          <span className="text-muted-foreground text-xs">{t('models.noSpec')}</span>
        ) : (
          <div className="space-y-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-muted-foreground -ml-2 h-7 gap-1 px-2 text-xs"
              aria-expanded={open}
              onClick={() => setOpen(value => !value)}
            >
              {open ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}
              {specKeys.length === 1 ? specLabel(t, specKeys[0]) : t('common.count', { count: specKeys.length })}
            </Button>
            {open && (
              <pre className="bg-muted/60 text-foreground max-w-md overflow-x-auto rounded-md p-3 font-mono text-xs">
                {JSON.stringify(spec, null, 2)}
              </pre>
            )}
          </div>
        )}
      </TableCell>
      {manage && (
        <TableCell className="text-right">
          {model.source === 'custom' ? (
            <>
              <Button variant="ghost" size="icon-sm" aria-label={t('common.delete')} onClick={() => setConfirmDelete(true)}>
                <Trash2Icon />
              </Button>
              <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>{t('models.deleteCustomConfirmTitle')}</AlertDialogTitle>
                    <AlertDialogDescription>{t('models.deleteCustomConfirmBody')}</AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                    <AlertDialogAction onClick={onDelete}>{t('common.delete')}</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label={t('models.hideModel')} onClick={onHide}>
                  <EyeOffIcon />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="left">{t('models.hideModelHint')}</TooltipContent>
            </Tooltip>
          )}
        </TableCell>
      )}
    </TableRow>
  )
}

function specLabel(t: (key: string) => string, key: string): string {
  switch (key) {
    case 'use':
      return t('models.specUse')
    case 'resolutions':
      return t('models.specResolutions')
    case 'durations':
      return t('models.specDurations')
    default:
      return key
  }
}

interface AddCatalogModelDialogProps {
  provider: string
  open: boolean
  onOpenChange(open: boolean): void
  onDone(): void
}

/**
 * The org's own row for a model the code catalog has not shipped yet. Whatever lands
 * here rides along on every new connection for this provider, exactly like an
 * official row — minus the vendor-verified spec.
 */
function AddCatalogModelDialog({ provider, open, onOpenChange, onDone }: AddCatalogModelDialogProps) {
  const { t } = useI18n()
  const { api } = useSession()
  const [model, setModel] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [modality, setModality] = useState<string>('text')
  const [acceptsFirstFrame, setAcceptsFirstFrame] = useState(false)
  const [acceptsReferenceImages, setAcceptsReferenceImages] = useState(false)
  const [maxReferenceImages, setMaxReferenceImages] = useState('1')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const takesInput = modality === 'i2v' || modality === 'r2v' || modality === 'image'
  const videoInput = modality === 'i2v' || modality === 'r2v'

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await api(`/providers/catalogs/${provider}/models`, {
        method: 'POST',
        body: JSON.stringify({
          model: model.trim(),
          displayName: displayName.trim() || undefined,
          modality,
          ...(takesInput ? { ...(videoInput ? { acceptsFirstFrame } : {}), acceptsReferenceImages, ...(acceptsReferenceImages ? { maxReferenceImages: Number(maxReferenceImages) } : {}) } : {}),
        }),
      })
      setModel('')
      setDisplayName('')
      setAcceptsFirstFrame(false)
      setAcceptsReferenceImages(false)
      onDone()
      onOpenChange(false)
    } catch (err) {
      setError(apiErrorMessage(err, t))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={next => !busy && onOpenChange(next)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('models.addCatalogModelTitle')}</DialogTitle>
          <DialogDescription>{t('models.addCatalogModelHint')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <Field label={t('models.modelName')} htmlFor="catalogModelName" required error={error}>
            <Input
              id="catalogModelName"
              value={model}
              onChange={event => setModel(event.target.value)}
              placeholder={t('models.modelNamePlaceholder')}
              required
              autoFocus
            />
          </Field>

          <Field label={t('models.modelDisplayName')} htmlFor="catalogModelDisplayName" hint={t('models.modelDisplayNameHint')}>
            <Input
              id="catalogModelDisplayName"
              value={displayName}
              onChange={event => setDisplayName(event.target.value)}
              placeholder={t('models.modelDisplayNamePlaceholder')}
            />
          </Field>

          <Field label={t('common.modality')} htmlFor="catalogModelModality" required>
            <Select value={modality} onValueChange={setModality}>
              <SelectTrigger id="catalogModelModality" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {modelModalities.map(item => (
                  <SelectItem key={item} value={item}>
                    {translateEnum(t, 'modality', item)}
                    <span className="text-muted-foreground ml-2 font-mono text-xs">{item}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          {takesInput && (
            <div className="space-y-3 rounded-lg border p-3">
              {modality === 'i2v' && (
                <label className="flex items-center justify-between gap-3 text-sm">
                  <span>{t('models.firstFrame')}</span>
                  <Switch checked={acceptsFirstFrame} onCheckedChange={setAcceptsFirstFrame} />
                </label>
              )}
              {(videoInput || modality === 'image') && (
                <label className="flex items-center justify-between gap-3 text-sm">
                  <span>{t('models.referenceImages')}</span>
                  <Switch checked={acceptsReferenceImages} onCheckedChange={setAcceptsReferenceImages} />
                </label>
              )}
              {acceptsReferenceImages && (
                <Field label={t('models.maxRefs')} htmlFor="catalogModelMaxRefs">
                  <Input
                    id="catalogModelMaxRefs"
                    type="number"
                    min={1}
                    max={8}
                    value={maxReferenceImages}
                    onChange={event => setMaxReferenceImages(event.target.value)}
                    className="w-24"
                  />
                </Field>
              )}
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={busy || !model.trim()}>
              {busy ? <LoaderCircleIcon className="animate-spin" /> : null}
              {busy ? t('common.saving') : t('common.add')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
