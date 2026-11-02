import { useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useLocation } from 'wouter'
import { toast } from 'sonner'
import { ChevronRight, Eye, EyeOff, KeyRound, RefreshCw, Table2, Archive, TriangleAlert, Ban } from 'lucide-react'
import { api, formatBytes, formatTime, type DatabaseInfo, type Role } from '@/api'
import {
  ConfirmByName, CopyButton, Dot, EmptyState, EngineMark, ErrorAlert, Mono, PageHeader, StatusIndicator, engineLabel,
} from '@/components/common'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { ConsoleTab } from './Console.tsx'

// Garis aktif menutup border bawah daftar tab (bawaan shadcn -5px membuat bar ikut menggulir)
const TAB = 'flex-none px-0.5 after:bottom-[-1px]!'

type Detail = DatabaseInfo & { role: Role; project: { id: number; path: string; name: string } }

function Section({ title, description, children, action }: { title: string; description?: ReactNode; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="rounded-xl border bg-card">
      <div className="flex items-start justify-between gap-4 border-b px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold">{title}</h2>
          {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid items-center gap-1 border-b px-5 py-3 last:border-b-0 sm:grid-cols-[180px_1fr]">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="flex min-w-0 items-center gap-1">{children}</div>
    </div>
  )
}

function ConnectionTab({ db }: { db: Detail }) {
  const [secret, setSecret] = useState<{ password: string; connectionString: string } | null>(null)
  const reveal = useMutation({
    mutationFn: () => api<{ password: string; connectionString: string }>('POST', `/api/databases/${db.id}/password/reveal`),
    onSuccess: setSecret,
  })
  const vars = useQuery({ queryKey: ['ci', db.id], queryFn: () => api<any[]>('GET', `/api/databases/${db.id}/ci-variables`) })
  const c = db.connection!
  const conn = secret?.connectionString ?? c.connectionString

  return (
    <div className="space-y-6">
      <Section title="Detail koneksi" description="Dipakai aplikasi dan pipeline GitLab. Koneksi hanya diterima dari runner dan server aplikasi lab.">
        <Field label="Host"><Mono className="truncate">{c.host}</Mono><CopyButton value={c.host} /></Field>
        <Field label="Port"><Mono>{c.port}</Mono></Field>
        <Field label="Database"><Mono className="truncate">{c.database}</Mono><CopyButton value={c.database} /></Field>
        <Field label="User"><Mono className="truncate">{c.user}</Mono><CopyButton value={c.user} /></Field>
        <Field label="Password">
          <Mono className="truncate">{secret ? secret.password : '••••••••••••••••'}</Mono>
          {secret && <CopyButton value={secret.password} />}
          <Button variant="ghost" size="sm" className="ml-auto text-muted-foreground" disabled={reveal.isPending}
            onClick={() => (secret ? setSecret(null) : reveal.mutate())}>
            {secret ? <><EyeOff />Sembunyikan</> : <><Eye />Tampilkan</>}
          </Button>
        </Field>
        <div className="px-5 py-4">
          <div className="mb-2 text-sm text-muted-foreground">Connection string</div>
          <div className="flex items-center gap-1 rounded-lg border bg-muted/40 py-1 pr-1 pl-3">
            <Mono className="min-w-0 flex-1 truncate">{conn}</Mono>
            {secret && <CopyButton value={conn} />}
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Password terakhir diganti {formatTime(c.passwordRotatedAt)}. Setiap kali password ditampilkan, aksinya tercatat di audit log.
          </p>
          <ErrorAlert error={reveal.error} className="mt-3" />
        </div>
      </Section>

      <Section title="CI/CD variable" description={<>Terpasang di GitLab dengan scope <Mono>{db.environment}</Mono> dan diperbarui saat password dirotasi.</>}>
        {vars.isLoading ? <div className="p-5"><Skeleton className="h-24" /></div> : vars.error ? <div className="p-5"><ErrorAlert error={vars.error} /></div>
          : vars.data!.length === 0 ? <p className="p-5 text-sm text-muted-foreground">Belum ada variable.</p> : (
          <Table>
            <TableHeader><TableRow className="hover:bg-transparent"><TableHead className="pl-5">Key</TableHead><TableHead>Status</TableHead><TableHead className="pr-5 text-right">Disinkronkan</TableHead></TableRow></TableHeader>
            <TableBody>
              {vars.data!.map(v => (
                <TableRow key={v.key}>
                  <TableCell className="pl-5"><Mono>{v.key}</Mono></TableCell>
                  <TableCell>
                    {v.status === 'ok'
                      ? <span className="inline-flex items-center gap-1.5 text-xs"><Dot tone="ok" />Tersinkron</span>
                      : <span className="inline-flex items-center gap-1.5 text-xs text-destructive" title={v.last_error}><Dot tone="error" />Gagal, dicoba ulang otomatis</span>}
                  </TableCell>
                  <TableCell className="pr-5 text-right text-muted-foreground">{formatTime(v.synced_at)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>
    </div>
  )
}

function SchemaTab({ db }: { db: Detail }) {
  const q = useQuery({ queryKey: ['schema', db.id], queryFn: () => api<any[]>('GET', `/api/databases/${db.id}/schema`) })
  const noun = db.engine === 'mongo' ? 'koleksi' : 'tabel'
  if (q.isLoading) return <Skeleton className="h-48" />
  if (q.error) return <ErrorAlert error={q.error} />
  if (!q.data!.length) return <EmptyState icon={<Table2 className="size-5" />} title={`Belum ada ${noun}`} description="Buat lewat tab Console atau dari aplikasimu." />
  return (
    <Section title={`${q.data!.length} ${noun}`} action={<Button variant="outline" size="sm" onClick={() => q.refetch()} disabled={q.isFetching}><RefreshCw className={q.isFetching ? 'animate-spin' : ''} />Muat ulang</Button>}>
      <div className="divide-y">
        {q.data!.map(t => (
          <Collapsible key={`${t.schema}.${t.name}`}>
            <CollapsibleTrigger className="group flex w-full items-center gap-3 px-5 py-3 text-left hover:bg-muted/40">
              <ChevronRight className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
              <Mono className="font-medium">{db.engine === 'postgres' && t.schema !== 'public' ? `${t.schema}.` : ''}{t.name}</Mono>
              <Badge variant="secondary" className="font-normal">{t.type}</Badge>
              <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                {t.approx_rows === null ? 'baris belum dihitung' : `≈ ${Number(t.approx_rows).toLocaleString('id-ID')} baris`} · {formatBytes(t.size_bytes)}
              </span>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="bg-muted/30 px-5 pb-3 pl-12">
                <Table>
                  <TableHeader><TableRow className="hover:bg-transparent"><TableHead>Kolom</TableHead><TableHead>Tipe</TableHead><TableHead>Null</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {t.columns.map((c: any) => (
                      <TableRow key={c.name}><TableCell><Mono>{c.name}</Mono></TableCell><TableCell><Mono className="text-muted-foreground">{c.type}</Mono></TableCell><TableCell className="text-muted-foreground">{c.nullable ? 'ya' : 'tidak'}</TableCell></TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CollapsibleContent>
          </Collapsible>
        ))}
      </div>
    </Section>
  )
}

const BACKUP_KIND: Record<string, string> = { daily: 'Harian', final: 'Akhir', manual: 'Manual' }

function BackupsTab({ db }: { db: Detail }) {
  const q = useQuery({ queryKey: ['backups', db.id], queryFn: () => api<any[]>('GET', `/api/databases/${db.id}/backups`) })
  if (q.isLoading) return <Skeleton className="h-48" />
  if (q.error) return <ErrorAlert error={q.error} />
  if (!q.data!.length) return <EmptyState icon={<Archive className="size-5" />} title="Belum ada backup" description="Backup otomatis dibuat setiap hari pukul 02.00 WIB dan disimpan 7 hari." />
  return (
    <Section title="Backup" description="Otomatis setiap hari pukul 02.00 WIB, disimpan 7 hari. Untuk memulihkan data, Maintainer menghubungi admin platform.">
      <Table>
        <TableHeader><TableRow className="hover:bg-transparent"><TableHead className="pl-5">Waktu</TableHead><TableHead>Jenis</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Ukuran</TableHead><TableHead className="pr-5 text-right">Disimpan sampai</TableHead></TableRow></TableHeader>
        <TableBody>
          {q.data!.map(b => (
            <TableRow key={b.id}>
              <TableCell className="pl-5">{formatTime(b.started_at)}</TableCell>
              <TableCell>{BACKUP_KIND[b.kind] ?? b.kind}</TableCell>
              <TableCell>
                <span className="inline-flex items-center gap-1.5 text-xs" title={b.error ?? undefined}>
                  <Dot tone={b.status === 'ok' ? 'ok' : b.status === 'running' ? 'muted' : 'error'} />
                  {b.status === 'ok' ? 'Berhasil' : b.status === 'running' ? 'Berjalan' : 'Gagal'}
                </span>
              </TableCell>
              <TableCell className="text-right tabular-nums">{formatBytes(b.size_bytes)}</TableCell>
              <TableCell className="pr-5 text-right text-muted-foreground">{formatTime(b.expires_at)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Section>
  )
}

function SettingsTab({ db }: { db: Detail }) {
  const qc = useQueryClient()
  const [, navigate] = useLocation()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const rotate = useMutation({
    mutationFn: () => api('POST', `/api/databases/${db.id}/password/rotate`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['database', db.id] })
      qc.invalidateQueries({ queryKey: ['ci', db.id] })
      toast.success('Password dirotasi', { description: 'CI/CD variable sudah diperbarui.' })
    },
    onError: e => toast.error('Rotasi gagal', { description: e.message }),
  })
  const remove = useMutation({
    mutationFn: () => api('DELETE', `/api/databases/${db.id}`, { confirm: db.name }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['project', db.projectId] })
      toast.success(`Database ${db.name} dihapus`, { description: 'Backup terakhir disimpan 7 hari.' })
      navigate(`/projects/${db.projectId}`)
    },
  })
  if (db.role !== 'maintainer') {
    return <EmptyState icon={<KeyRound className="size-5" />} title="Khusus Maintainer" description="Rotasi password dan penghapusan database hanya bisa dilakukan Maintainer project." />
  }

  return (
    <div className="space-y-6">
      <section className="flex flex-wrap items-center justify-between gap-4 rounded-xl border bg-card px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold">Rotasi password</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">Password lama langsung tidak berlaku dan CI/CD variable diperbarui. Aplikasi yang memakai password lama perlu di-deploy ulang.</p>
        </div>
          <AlertDialog>
            <AlertDialogTrigger asChild><Button variant="outline" disabled={rotate.isPending}><KeyRound />{rotate.isPending ? 'Merotasi…' : 'Rotasi'}</Button></AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Rotasi password {db.name}?</AlertDialogTitle>
                <AlertDialogDescription>Koneksi yang memakai password lama akan gagal sampai aplikasi memakai password baru.</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Batal</AlertDialogCancel>
                <AlertDialogAction onClick={() => rotate.mutate()}>Rotasi password</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
      </section>

      <section className="rounded-xl border border-destructive/30 bg-card">
        <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold text-destructive">Hapus database</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">Database, user, dan CI/CD variable dihapus. Backup terakhir dibuat dulu dan disimpan 7 hari.</p>
          </div>
          <Button variant="destructive" onClick={() => setConfirmDelete(true)}>Hapus database</Button>
        </div>
      </section>

      <ConfirmByName
        open={confirmDelete} onOpenChange={setConfirmDelete} name={db.name} title={`Hapus ${db.name}?`} action="Hapus permanen"
        description={<>Semua data di <Mono className="text-foreground">{db.connection?.database}</Mono> akan dihapus. Aksi ini tidak bisa dibatalkan dari UI.</>}
        busy={remove.isPending} error={remove.error} onConfirm={() => remove.mutate()}
      />
    </div>
  )
}

export function DatabasePage({ id }: { id: string }) {
  const q = useQuery({
    queryKey: ['database', id], queryFn: () => api<Detail>('GET', `/api/databases/${id}`),
    refetchInterval: d => (d.state.data?.status === 'provisioning' ? 1000 : false),
  })
  if (q.isLoading) return <div className="space-y-4"><Skeleton className="h-12 w-72" /><Skeleton className="h-9 w-96" /><Skeleton className="h-64" /></div>
  if (q.error) return <ErrorAlert error={q.error} />
  const db = q.data!

  return (
    <>
      <PageHeader
        eyebrow={
          <div className="text-xs text-muted-foreground">
            <Link href="/" className="hover:text-foreground">Overview</Link><span className="mx-1">/</span>
            <Link href={`/projects/${db.project.id}`} className="hover:text-foreground">{db.project.name}</Link><span className="mx-1">/</span>{db.name}
          </div>
        }
        title={<span className="flex items-center gap-3"><EngineMark engine={db.engine} size="lg" />{db.name}</span>}
        description={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>{engineLabel(db.engine)}</span>
            <Badge variant="outline" className="font-mono font-normal">{db.environment}</Badge>
            <span className="tabular-nums">{formatBytes(db.sizeBytes)}</span>
            <StatusIndicator status={db.status} />
          </span>
        }
      />

      {db.status === 'read_only' && (
        <Alert className="mb-6 border-warning/40 text-warning [&>svg]:text-warning">
          <TriangleAlert /><AlertTitle>Hanya bisa dibaca</AlertTitle>
          <AlertDescription>Penyimpanan project melewati quota. Hapus data yang tidak perlu atau minta admin menaikkan quota.</AlertDescription>
        </Alert>
      )}
      {db.status === 'blocked' && (
        <Alert variant="destructive" className="mb-6">
          <Ban /><AlertTitle>Koneksi diblokir</AlertTitle>
          <AlertDescription>Penyimpanan project jauh melewati quota. Koneksi ditolak sampai pemakaian turun atau quota dinaikkan admin.</AlertDescription>
        </Alert>
      )}

      <Tabs defaultValue="connection">
        <TabsList variant="line" className="mb-6 h-10 w-full justify-start gap-5 border-b p-0">
          <TabsTrigger value="connection" className={TAB}>Koneksi</TabsTrigger>
          <TabsTrigger value="console" className={TAB}>Console</TabsTrigger>
          <TabsTrigger value="schema" className={TAB}>{db.engine === 'mongo' ? 'Koleksi' : 'Tabel'}</TabsTrigger>
          <TabsTrigger value="backups" className={TAB}>Backup</TabsTrigger>
          <TabsTrigger value="settings" className={TAB}>Pengaturan</TabsTrigger>
        </TabsList>
        <TabsContent value="connection"><ConnectionTab db={db} /></TabsContent>
        <TabsContent value="console"><ConsoleTab db={db} /></TabsContent>
        <TabsContent value="schema"><SchemaTab db={db} /></TabsContent>
        <TabsContent value="backups"><BackupsTab db={db} /></TabsContent>
        <TabsContent value="settings"><SettingsTab db={db} /></TabsContent>
      </Tabs>
    </>
  )
}
