import { useEffect, useState, type ReactNode } from 'react'
import { Check, Copy, AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { DatabaseInfo, Engine } from '@/api'

// Tanda engine: kotak kecil berwarna dengan inisial, konsisten di semua halaman
const ENGINE_MARK: Record<Engine, { label: string; short: string; className: string }> = {
  postgres: { label: 'PostgreSQL', short: 'Pg', className: 'bg-sky-500/12 text-sky-700 ring-sky-500/25 dark:text-sky-300' },
  mariadb: { label: 'MariaDB', short: 'Ma', className: 'bg-amber-500/12 text-amber-700 ring-amber-500/25 dark:text-amber-300' },
  mongo: { label: 'MongoDB', short: 'Mg', className: 'bg-emerald-500/12 text-emerald-700 ring-emerald-500/25 dark:text-emerald-300' },
}
export const engineLabel = (e: Engine) => ENGINE_MARK[e].label

export function EngineMark({ engine, size = 'md' }: { engine: Engine; size?: 'sm' | 'md' | 'lg' }) {
  const m = ENGINE_MARK[engine]
  return (
    <span
      aria-label={m.label}
      className={cn('inline-flex shrink-0 items-center justify-center rounded-md font-mono font-semibold ring-1 ring-inset', m.className,
        size === 'sm' && 'size-6 text-[10px]', size === 'md' && 'size-8 text-xs', size === 'lg' && 'size-11 text-sm')}
    >{m.short}</span>
  )
}

const STATUS: Record<DatabaseInfo['status'], { label: string; dot: string; text: string }> = {
  provisioning: { label: 'Provisioning', dot: 'bg-muted-foreground animate-pulse', text: 'text-muted-foreground' },
  ready: { label: 'Aktif', dot: 'bg-success', text: 'text-foreground' },
  read_only: { label: 'Read-only', dot: 'bg-warning', text: 'text-warning' },
  blocked: { label: 'Diblokir', dot: 'bg-destructive', text: 'text-destructive' },
  deleting: { label: 'Menghapus', dot: 'bg-muted-foreground animate-pulse', text: 'text-muted-foreground' },
}
export function StatusIndicator({ status }: { status: DatabaseInfo['status'] }) {
  const s = STATUS[status] ?? STATUS.provisioning
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-xs font-medium', s.text)}>
      <span className={cn('size-1.5 rounded-full', s.dot)} />{s.label}
    </span>
  )
}

export function Dot({ tone }: { tone: 'ok' | 'warn' | 'error' | 'muted' }) {
  return <span className={cn('inline-block size-1.5 rounded-full', {
    ok: 'bg-success', warn: 'bg-warning', error: 'bg-destructive', muted: 'bg-muted-foreground',
  }[tone])} />
}

export function CopyButton({ value, label = 'Salin' }: { value: string; label?: string }) {
  const [done, setDone] = useState(false)
  useEffect(() => { if (done) { const t = setTimeout(() => setDone(false), 1400); return () => clearTimeout(t) } }, [done])
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" variant="ghost" size="icon-sm" className="size-7 text-muted-foreground"
          onClick={async () => { await navigator.clipboard.writeText(value); setDone(true) }} aria-label={label}>
          {done ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{done ? 'Tersalin' : label}</TooltipContent>
    </Tooltip>
  )
}

export function ErrorAlert({ error, className }: { error: unknown; className?: string }) {
  if (!error) return null
  return (
    <Alert variant="destructive" className={className}>
      <AlertCircle />
      <AlertDescription>{error instanceof Error ? error.message : String(error)}</AlertDescription>
    </Alert>
  )
}

export function PageHeader({ title, description, actions, eyebrow }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode }) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0 space-y-1.5">
        {eyebrow}
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <div className="text-sm text-muted-foreground">{description}</div>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  )
}

export function StatCard({ label, value, hint, progress, tone }: {
  label: string; value: ReactNode; hint?: ReactNode; progress?: number; tone?: 'default' | 'danger'
}) {
  return (
    <div className="rounded-xl border bg-card p-5">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="mt-2 text-2xl font-semibold tracking-tight tabular-nums">{value}</div>
      {progress !== undefined && (
        <div className="mt-3 h-1 overflow-hidden rounded-full bg-muted">
          <div className={cn('h-full rounded-full transition-all', tone === 'danger' ? 'bg-destructive' : progress >= 100 ? 'bg-warning' : 'bg-brand')}
            style={{ width: `${Math.min(100, Math.max(progress, progress > 0 ? 2 : 0))}%` }} />
        </div>
      )}
      {hint && <div className="mt-2 text-xs text-muted-foreground">{hint}</div>}
    </div>
  )
}

export function EmptyState({ icon, title, description, action }: { icon: ReactNode; title: string; description: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center rounded-xl border border-dashed px-6 py-14 text-center">
      <div className="mb-4 flex size-11 items-center justify-center rounded-xl border bg-card text-muted-foreground shadow-xs">{icon}</div>
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  )
}

// Konfirmasi dengan ketik ulang nama (hapus database, perintah destruktif di console)
export function ConfirmByName({ open, name, title, description, action, busy, error, onConfirm, onOpenChange }: {
  open: boolean; name: string; title: string; description: ReactNode; action: string; busy?: boolean; error?: unknown
  onConfirm: () => void; onOpenChange: (open: boolean) => void
}) {
  const [typed, setTyped] = useState('')
  useEffect(() => { if (open) setTyped('') }, [open])
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={e => { e.preventDefault(); if (typed === name) onConfirm() }} className="space-y-5">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription asChild><div>{description}</div></DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="confirm-name" className="font-normal text-muted-foreground">
              Ketik <span className="font-mono font-medium text-foreground">{name}</span> untuk melanjutkan
            </Label>
            <Input id="confirm-name" autoFocus autoComplete="off" spellCheck={false} value={typed} onChange={e => setTyped(e.target.value)} />
          </div>
          <ErrorAlert error={error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Batal</Button>
            <Button type="submit" variant="destructive" disabled={typed !== name || busy}>{busy ? 'Memproses…' : action}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('font-mono text-[13px]', className)}>{children}</span>
}
