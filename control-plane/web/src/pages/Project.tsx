import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useLocation } from 'wouter'
import { toast } from 'sonner'
import { Database, Plus, TriangleAlert } from 'lucide-react'
import { api, formatBytes, formatTime, healthQuery, type DatabaseInfo, type Engine, type ProjectDetail } from '@/api'
import { EmptyState, EngineMark, ErrorAlert, PageHeader, StatCard, StatusIndicator, engineLabel } from '@/components/common'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Skeleton } from '@/components/ui/skeleton'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { cn } from '@/lib/utils'

const ENV_RE = /^[a-z][a-z0-9]{0,11}$/
const NAME_RE = /^[a-z][a-z0-9_]{0,23}$/
const ENGINES: Engine[] = ['postgres', 'mariadb', 'mongo']
const GRID_COLS: Record<number, string> = { 1: 'grid-cols-1', 2: 'grid-cols-2', 3: 'grid-cols-3' }
const ENGINE_HINT: Record<Engine, string> = { postgres: 'Relasional, serbaguna', mariadb: 'Kompatibel MySQL', mongo: 'Dokumen JSON' }

const ENV_EXAMPLES = ['dev', 'staging', 'prod']
const NAME_EXAMPLES = ['app', 'auth', 'analytics']

// Pilihan cepat di bawah input: klik untuk mengisi
function Suggestions({ values, current, onPick }: { values: string[]; current: string; onPick: (v: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {values.map(v => (
        <button key={v} type="button" onClick={() => onPick(v)}
          className={cn('rounded-md border px-2 py-0.5 font-mono text-xs transition-colors focus-visible:outline-2 focus-visible:outline-ring',
            current === v ? 'border-foreground/40 bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground')}>
          {v}
        </button>
      ))}
    </div>
  )
}

function CreateDatabaseDialog({ projectId, open, onOpenChange, blocked }: { projectId: number; open: boolean; onOpenChange: (o: boolean) => void; blocked: string | null }) {
  const qc = useQueryClient()
  const [, navigate] = useLocation()
  const health = useQuery(healthQuery)
  const enabled = health.data?.engines
  const available = enabled ? ENGINES.filter(e => e in enabled) : ENGINES
  const [picked, setPicked] = useState<Engine>('postgres')
  const engine = available.includes(picked) ? picked : available[0]
  const [environment, setEnvironment] = useState('dev')
  const [name, setName] = useState('app')
  const create = useMutation({
    mutationFn: () => api<DatabaseInfo>('POST', `/api/projects/${projectId}/databases`, { engine, environment, name }),
    onSuccess: db => {
      qc.invalidateQueries({ queryKey: ['project', projectId] })
      toast.success(`Database ${db.name} siap dipakai`)
      onOpenChange(false)
      navigate(`/databases/${db.id}`)
    },
  })
  const envOk = ENV_RE.test(environment), nameOk = NAME_RE.test(name)
  const prefix = name.toUpperCase() || 'NAMA'

  return (
    <Dialog open={open} onOpenChange={o => { onOpenChange(o); if (!o) create.reset() }}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={e => { e.preventDefault(); create.mutate() }} className="space-y-6">
          <DialogHeader>
            <DialogTitle>Database baru</DialogTitle>
            <DialogDescription>User dan password dibuat otomatis. Database siap dalam beberapa detik.</DialogDescription>
          </DialogHeader>

          {blocked && <Alert><TriangleAlert /><AlertDescription>{blocked}</AlertDescription></Alert>}

          <div className="space-y-2">
            <Label>Engine</Label>
            <div role="radiogroup" className={cn('grid gap-2', GRID_COLS[available.length])}>
              {available.map(e => (
                <button key={e} type="button" role="radio" aria-checked={engine === e} onClick={() => setPicked(e)}
                  className={cn('flex flex-col items-start gap-2 rounded-lg border p-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-ring',
                    engine === e ? 'border-foreground/60 bg-accent ring-1 ring-foreground/20' : 'hover:bg-accent/50')}>
                  <EngineMark engine={e} size="sm" />
                  <span>
                    <span className="block text-sm font-medium">{engineLabel(e)}</span>
                    <span className="block text-xs text-muted-foreground">{ENGINE_HINT[e]}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="env">Environment</Label>
              <Input id="env" value={environment} placeholder="dev" onChange={e => setEnvironment(e.target.value.toLowerCase())} aria-invalid={!envOk} />
              <Suggestions values={ENV_EXAMPLES} current={environment} onPick={setEnvironment} />
              <p className="text-xs text-muted-foreground">Samakan dengan environment GitLab, mis. <span className="font-mono">dev</span>, <span className="font-mono">staging</span>, atau <span className="font-mono">prod</span>.</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="name">Nama</Label>
              <Input id="name" value={name} placeholder="app" onChange={e => setName(e.target.value.toLowerCase())} aria-invalid={!nameOk} />
              <Suggestions values={NAME_EXAMPLES} current={name} onPick={setName} />
              <p className="text-xs text-muted-foreground">Kegunaan database, mis. <span className="font-mono">app</span>, <span className="font-mono">auth</span>, atau <span className="font-mono">analytics</span>. Huruf kecil, angka, atau _.</p>
            </div>
          </div>

          <div className="rounded-lg border bg-muted/40 p-3 text-xs text-muted-foreground">
            Credential dipasang di GitLab sebagai
            <span className="font-mono text-foreground"> {prefix}_DATABASE_URL</span>,
            <span className="font-mono text-foreground"> {prefix}_DB_PASSWORD</span>, dan lainnya dengan scope
            <span className="font-mono text-foreground"> {environment || '…'}</span>.
          </div>

          {(!envOk || !nameOk) && <p className="text-xs text-destructive">Environment maks 12 karakter dan nama maks 24 karakter, diawali huruf kecil.</p>}
          <ErrorAlert error={create.error} />

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Batal</Button>
            <Button type="submit" disabled={!envOk || !nameOk || !!blocked || create.isPending}>
              {create.isPending ? 'Membuat…' : 'Buat database'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function ProjectPage({ projectId }: { projectId: number }) {
  const [creating, setCreating] = useState(false)
  const [, navigate] = useLocation()
  const q = useQuery({ queryKey: ['project', projectId], queryFn: () => api<ProjectDetail>('GET', `/api/projects/${projectId}`) })

  if (q.isLoading) return <div className="space-y-4"><Skeleton className="h-8 w-56" /><div className="grid gap-4 sm:grid-cols-3"><Skeleton className="h-28" /><Skeleton className="h-28" /><Skeleton className="h-28" /></div><Skeleton className="h-48" /></div>
  if (q.error) return <ErrorAlert error={q.error} />
  const { project, role, quota, usage, databases } = q.data!
  const limitBytes = quota.maxSizeMb * 1024 * 1024
  const blocked = usage.databases >= quota.maxDatabases
    ? `Quota penuh: ${usage.databases} dari ${quota.maxDatabases} database sudah dipakai. Hapus database yang tidak dipakai atau minta admin menaikkan quota.`
    : usage.sizeBytes >= limitBytes ? 'Quota penyimpanan penuh. Kosongkan data atau minta admin menaikkan quota.' : null
  const limited = databases.filter(d => d.status === 'read_only' || d.status === 'blocked')

  return (
    <>
      <PageHeader
        eyebrow={<div className="text-xs text-muted-foreground"><Link href="/" className="hover:text-foreground">Overview</Link> <span className="mx-1">/</span> <span className="font-mono">{project.path}</span></div>}
        title={<span className="flex items-center gap-3">{project.name}<Badge variant="secondary" className="font-normal">{role === 'maintainer' ? 'Maintainer' : 'Developer'}</Badge></span>}
        actions={databases.length > 0 && <Button onClick={() => setCreating(true)}><Plus />Database baru</Button>}
      />

      {limited.length > 0 && (
        <Alert className="mb-6 border-warning/40 text-warning [&>svg]:text-warning">
          <TriangleAlert />
          <AlertTitle>Penyimpanan melewati quota</AlertTitle>
          <AlertDescription>{limited.length} database tidak bisa ditulisi. Hapus data yang tidak perlu (terdeteksi dalam ±5 menit) atau minta admin menaikkan quota.</AlertDescription>
        </Alert>
      )}

      <div className="mb-10 grid gap-4 sm:grid-cols-3">
        <StatCard label="Database" value={<>{usage.databases}<span className="text-base font-normal text-muted-foreground"> / {quota.maxDatabases}</span></>}
          progress={(usage.databases / quota.maxDatabases) * 100} />
        <StatCard label="Penyimpanan" value={<>{formatBytes(usage.sizeBytes)}<span className="text-base font-normal text-muted-foreground"> / {formatBytes(limitBytes)}</span></>}
          progress={(usage.sizeBytes / limitBytes) * 100} tone={usage.sizeBytes >= limitBytes ? 'danger' : 'default'} />
        <StatCard label="Batas per database" value={<>{quota.maxConnections}<span className="text-base font-normal text-muted-foreground"> koneksi</span></>}
          hint="Query dihentikan setelah 30 detik" />
      </div>

      {databases.length === 0 ? (
        <EmptyState icon={<Database className="size-5" />} title="Belum ada database"
          description="Buat database pertama untuk project ini. Credential otomatis tersedia di CI/CD GitLab."
          action={<Button onClick={() => setCreating(true)}><Plus />Buat database</Button>} />
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-5">Database</TableHead>
                <TableHead>Environment</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Ukuran</TableHead>
                <TableHead className="hidden pr-5 text-right md:table-cell">Dibuat</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {databases.map(d => (
                <TableRow key={d.id} className="cursor-pointer" onClick={() => navigate(`/databases/${d.id}`)}>
                  <TableCell className="py-3 pl-5">
                    <Link href={`/databases/${d.id}`} className="flex items-center gap-3 outline-none" onClick={e => e.stopPropagation()}>
                      <EngineMark engine={d.engine} />
                      <span className="min-w-0">
                        <span className="block font-medium">{d.name}</span>
                        <span className="block font-mono text-xs text-muted-foreground">{d.connection?.database}</span>
                      </span>
                    </Link>
                  </TableCell>
                  <TableCell><Badge variant="outline" className="font-mono font-normal">{d.environment}</Badge></TableCell>
                  <TableCell><StatusIndicator status={d.status} /></TableCell>
                  <TableCell className="text-right tabular-nums">{formatBytes(d.sizeBytes)}</TableCell>
                  <TableCell className="hidden pr-5 text-right text-muted-foreground md:table-cell">{formatTime(d.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <CreateDatabaseDialog projectId={projectId} open={creating} onOpenChange={setCreating} blocked={blocked} />
    </>
  )
}
