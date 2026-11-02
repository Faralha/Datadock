import { useState } from 'react'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'wouter'
import { toast } from 'sonner'
import { Pencil, Play, RefreshCw, Search, Loader2 } from 'lucide-react'
import { api, formatBytes, formatTime } from '@/api'
import { Dot, ErrorAlert, Mono, PageHeader, StatCard } from '@/components/common'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

type AdminProject = { id: number; path: string; name: string; max_databases: number; max_size_mb: number; max_connections: number; databases: number; size_bytes: number }

function QuotaDialog({ project, onClose }: { project: AdminProject | null; onClose: () => void }) {
  const qc = useQueryClient()
  const [v, setV] = useState({ maxDatabases: '', maxSizeMb: '', maxConnections: '' })
  const [shownFor, setShownFor] = useState<number | null>(null)
  if (project && shownFor !== project.id) {
    setShownFor(project.id)
    setV({ maxDatabases: String(project.max_databases), maxSizeMb: String(project.max_size_mb), maxConnections: String(project.max_connections) })
  }
  const save = useMutation({
    mutationFn: () => api('PUT', `/api/admin/projects/${project!.id}/quota`, {
      maxDatabases: Number(v.maxDatabases), maxSizeMb: Number(v.maxSizeMb), maxConnections: Number(v.maxConnections),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-projects'] })
      qc.invalidateQueries({ queryKey: ['project', project!.id] })
      toast.success(`Quota ${project!.name} diperbarui`)
      onClose()
    },
  })
  const field = (k: keyof typeof v, label: string, hint: string) => (
    <div className="space-y-2">
      <Label htmlFor={k}>{label}</Label>
      <Input id={k} type="number" min={0} value={v[k]} onChange={e => setV({ ...v, [k]: e.target.value })} />
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  )
  return (
    <Dialog open={!!project} onOpenChange={o => { if (!o) { onClose(); save.reset(); setShownFor(null) } }}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={e => { e.preventDefault(); save.mutate() }} className="space-y-5">
          <DialogHeader>
            <DialogTitle>Ubah quota</DialogTitle>
            <DialogDescription><Mono>{project?.path}</Mono></DialogDescription>
          </DialogHeader>
          {field('maxDatabases', 'Jumlah database', `Terpakai ${project?.databases ?? 0}`)}
          {field('maxSizeMb', 'Penyimpanan (MB)', `Terpakai ${formatBytes(project?.size_bytes ?? 0)}. Dicek tiap 5 menit.`)}
          {field('maxConnections', 'Koneksi per database', 'Berlaku untuk database yang dibuat setelahnya.')}
          <ErrorAlert error={save.error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Batal</Button>
            <Button type="submit" disabled={save.isPending}>{save.isPending ? 'Menyimpan…' : 'Simpan'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function AdminQuotasPage() {
  const q = useQuery({ queryKey: ['admin-projects'], queryFn: () => api<AdminProject[]>('GET', '/api/admin/projects') })
  const [editing, setEditing] = useState<AdminProject | null>(null)
  const rows = q.data ?? []
  const over = rows.filter(p => p.size_bytes >= p.max_size_mb * 1048576).length

  return (
    <>
      <PageHeader title="Quota" description="Pemakaian dan batas sumber daya setiap project." />
      <div className="mb-10 grid gap-4 sm:grid-cols-3">
        <StatCard label="Project" value={rows.length} />
        <StatCard label="Database" value={rows.reduce((s, p) => s + p.databases, 0)} />
        <StatCard label="Penyimpanan" value={formatBytes(rows.reduce((s, p) => s + p.size_bytes, 0))}
          hint={over ? `${over} project melewati quota` : 'Semua project di bawah quota'} />
      </div>
      <ErrorAlert error={q.error} />
      <div className="overflow-hidden rounded-xl border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="pl-5">Project</TableHead><TableHead>Database</TableHead><TableHead className="w-[30%]">Penyimpanan</TableHead>
              <TableHead>Koneksi/DB</TableHead><TableHead className="pr-5" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {q.isLoading && <TableRow><TableCell colSpan={5}><Skeleton className="h-10" /></TableCell></TableRow>}
            {rows.map(p => {
              const pct = (p.size_bytes / (p.max_size_mb * 1048576)) * 100
              return (
                <TableRow key={p.id}>
                  <TableCell className="pl-5">
                    <Link href={`/projects/${p.id}`} className="font-medium hover:underline">{p.name}</Link>
                    <div className="font-mono text-xs text-muted-foreground">{p.path}</div>
                  </TableCell>
                  <TableCell className="tabular-nums">{p.databases} <span className="text-muted-foreground">/ {p.max_databases}</span></TableCell>
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
                        <div className={cn('h-full rounded-full', pct >= 100 ? 'bg-destructive' : 'bg-brand')} style={{ width: `${Math.min(100, Math.max(pct, pct > 0 ? 2 : 0))}%` }} />
                      </div>
                      <span className="w-32 text-right text-xs tabular-nums text-muted-foreground">{formatBytes(p.size_bytes)} / {formatBytes(p.max_size_mb * 1048576)}</span>
                    </div>
                  </TableCell>
                  <TableCell className="tabular-nums">{p.max_connections}</TableCell>
                  <TableCell className="pr-5 text-right"><Button variant="ghost" size="sm" onClick={() => setEditing(p)}><Pencil />Ubah</Button></TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>
      <QuotaDialog project={editing} onClose={() => setEditing(null)} />
    </>
  )
}

const RESULT_TONE = { ok: 'ok', denied: 'warn', error: 'error' } as const

export function AdminAuditPage() {
  const [project, setProject] = useState('')
  const [filter, setFilter] = useState('')
  const q = useInfiniteQuery({
    queryKey: ['audit', project],
    queryFn: ({ pageParam }) => api<any[]>('GET', `/api/admin/audit?limit=100${project ? `&project=${project}` : ''}${pageParam ? `&before=${pageParam}` : ''}`),
    initialPageParam: 0,
    getNextPageParam: last => (last.length === 100 ? last[last.length - 1].id : undefined),
  })
  const rows = (q.data?.pages.flat() ?? []).filter(e => !filter || `${e.action} ${e.actor_username} ${e.target ?? ''}`.toLowerCase().includes(filter.toLowerCase()))

  return (
    <>
      <PageHeader title="Audit log" description="Jejak setiap aksi platform dan query console. Tidak bisa diubah atau dihapus."
        actions={<Button variant="outline" size="sm" onClick={() => q.refetch()} disabled={q.isFetching}><RefreshCw className={q.isFetching ? 'animate-spin' : ''} />Muat ulang</Button>} />
      <div className="mb-4 flex flex-wrap gap-2">
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-8" placeholder="Cari aksi, aktor, atau target" value={filter} onChange={e => setFilter(e.target.value)} />
        </div>
        <Input className="w-36" placeholder="ID project" value={project} onChange={e => setProject(e.target.value.replace(/\D/g, ''))} />
      </div>
      <ErrorAlert error={q.error} />
      <div className="overflow-hidden rounded-xl border bg-card">
        <div className="max-h-[640px] overflow-auto">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-card shadow-[inset_0_-1px_0_var(--border)]">
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-5">Waktu</TableHead><TableHead>Aktor</TableHead><TableHead>Aksi</TableHead><TableHead>Hasil</TableHead><TableHead className="pr-5">Detail</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {q.isLoading && <TableRow><TableCell colSpan={5}><Skeleton className="h-24" /></TableCell></TableRow>}
              {rows.map(e => (
                <TableRow key={e.id} className="align-top">
                  <TableCell className="pl-5 whitespace-nowrap text-muted-foreground">{formatTime(e.at)}</TableCell>
                  <TableCell>
                    <div className="font-medium">{e.actor_username}</div>
                    {e.ip && <Mono className="text-xs text-muted-foreground">{e.ip.replace('::ffff:', '')}</Mono>}
                  </TableCell>
                  <TableCell>
                    <Mono className="text-xs">{e.action}</Mono>
                    {e.target && <div className="max-w-[220px] truncate font-mono text-xs text-muted-foreground" title={e.target}>{e.target}</div>}
                  </TableCell>
                  <TableCell><span className="inline-flex items-center gap-1.5 text-xs"><Dot tone={RESULT_TONE[e.result as keyof typeof RESULT_TONE] ?? 'muted'} />{e.result}</span></TableCell>
                  <TableCell className="pr-5">
                    {e.detail && <div className="max-w-[420px] truncate font-mono text-xs text-muted-foreground" title={e.detail}>{e.detail}</div>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        {q.hasNextPage && (
          <div className="border-t p-3 text-center">
            <Button variant="ghost" size="sm" onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>Muat lebih banyak</Button>
          </div>
        )}
      </div>
    </>
  )
}

const JOB_INFO: Record<string, [string, string]> = {
  'sync-memberships': ['Sinkron anggota GitLab', 'Tiap 15 menit'],
  'enforce-quotas': ['Cek ukuran dan quota', 'Tiap 5 menit'],
  'backup-daily': ['Backup harian', 'Setiap hari 02.00 WIB'],
  'backup-expire': ['Hapus backup kedaluwarsa', 'Tiap jam'],
  'purge-sessions': ['Bersihkan sesi kedaluwarsa', 'Tiap jam'],
  'retry-ci-variables': ['Ulangi sinkron CI variable', 'Tiap 15 menit'],
}

export function AdminJobsPage() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['jobs'], queryFn: () => api<any[]>('GET', '/api/admin/jobs'), refetchInterval: 5000 })
  const run = useMutation({
    mutationFn: (name: string) => api('POST', `/api/admin/jobs/${name}/run`),
    onSuccess: (_d, name) => toast.success(`${JOB_INFO[name]?.[0] ?? name} selesai`),
    onError: (e, name) => toast.error(`${JOB_INFO[name]?.[0] ?? name} gagal`, { description: e.message }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['jobs'] }),
  })
  return (
    <>
      <PageHeader title="Job terjadwal" description="Job berjalan otomatis di control plane. Jalankan manual bila perlu." />
      <ErrorAlert error={q.error} />
      <div className="divide-y overflow-hidden rounded-xl border bg-card">
        {q.isLoading && <div className="p-5"><Skeleton className="h-40" /></div>}
        {q.data?.map(j => {
          const [title, schedule] = JOB_INFO[j.name] ?? [j.name, '']
          const busy = j.running || (run.isPending && run.variables === j.name)
          return (
            <div key={j.name} className="flex flex-wrap items-center gap-4 px-5 py-4">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 font-medium">
                  {title}
                  <span className="inline-flex items-center gap-1.5 text-xs font-normal text-muted-foreground">
                    <Dot tone={busy ? 'muted' : j.last_status === 'ok' ? 'ok' : j.last_status === 'error' ? 'error' : 'muted'} />
                    {busy ? 'Berjalan' : j.last_status === 'ok' ? 'OK' : j.last_status === 'error' ? 'Gagal' : 'Belum pernah'}
                  </span>
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground"><Mono className="text-xs">{j.name}</Mono> · {schedule} · terakhir {formatTime(j.last_finished_at ?? j.last_started_at)}</div>
                {j.last_status === 'error' && <div className="mt-1 text-xs text-destructive">{j.last_error}</div>}
              </div>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => run.mutate(j.name)}>
                {busy ? <Loader2 className="animate-spin" /> : <Play />}Jalankan
              </Button>
            </div>
          )
        })}
      </div>
    </>
  )
}
