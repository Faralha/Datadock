// Query console: SQL untuk PostgreSQL/MariaDB, perintah JSON untuk MongoDB. Ctrl/Cmd+Enter menjalankan.
import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Play, Loader2, TriangleAlert, Clock, Rows3 } from 'lucide-react'
import { api, ApiError, type DatabaseInfo } from '@/api'
import { ConfirmByName, ErrorAlert, Mono } from '@/components/common'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { cn } from '@/lib/utils'

type SqlResult = { columns: string[]; rows: unknown[][]; truncated: boolean; command: string | null; affected: number | null; durationMs: number }
type MongoResult = { documents: unknown[]; truncated: boolean; affected: number | null; durationMs: number }

const MONGO_PRESETS: Record<string, object> = {
  listCollections: { operation: 'listCollections' },
  find: { operation: 'find', collection: 'users', filter: {}, sort: { _id: -1 }, limit: 50 },
  insertOne: { operation: 'insertOne', collection: 'users', document: { name: 'Ani' } },
  updateOne: { operation: 'updateOne', collection: 'users', filter: { name: 'Ani' }, update: { $set: { active: true } } },
  deleteOne: { operation: 'deleteOne', collection: 'users', filter: { name: 'Ani' } },
  aggregate: { operation: 'aggregate', collection: 'users', pipeline: [{ $group: { _id: '$active', n: { $sum: 1 } } }] },
  count: { operation: 'count', collection: 'users', filter: {} },
}
const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform)

function Kbd({ children }: { children: string }) {
  return <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">{children}</kbd>
}

function Cell({ v }: { v: unknown }) {
  if (v === null || v === undefined) return <TableCell className="font-mono text-xs text-muted-foreground/70 italic">NULL</TableCell>
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
  return <TableCell className="max-w-[420px] truncate font-mono text-xs" title={s.length > 60 ? s : undefined}>{s}</TableCell>
}

export function ConsoleTab({ db }: { db: DatabaseInfo }) {
  const isMongo = db.engine === 'mongo'
  const [text, setText] = useState(isMongo ? JSON.stringify(MONGO_PRESETS.listCollections, null, 2) : 'SELECT now();')
  const [needsConfirm, setNeedsConfirm] = useState(false)
  const [parseError, setParseError] = useState<string | null>(null)

  const exec = useMutation({
    mutationFn: (confirm?: string) => {
      // Titik koma penutup dibuang: engine hanya menerima satu perintah per eksekusi
      const body = isMongo ? { mongo: JSON.parse(text), confirm } : { query: text.trim().replace(/;\s*$/, ''), confirm }
      return api<SqlResult | MongoResult>('POST', `/api/databases/${db.id}/console`, body)
    },
    onSuccess: () => setNeedsConfirm(false),
    onError: e => { if (e instanceof ApiError && e.data.needsConfirmation) setNeedsConfirm(true) },
  })

  function run(confirm?: string) {
    if (isMongo) {
      try { JSON.parse(text); setParseError(null) } catch (e: any) { setParseError(`JSON tidak valid: ${e.message}`); return }
    }
    exec.mutate(confirm)
  }

  const r = exec.data
  const confirmError = exec.error instanceof ApiError && exec.error.data.needsConfirmation
  const count = r ? ('columns' in r ? r.rows.length : r.documents.length) : 0

  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-xl border bg-card focus-within:ring-2 focus-within:ring-ring/40">
        <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
          <Mono className="text-xs text-muted-foreground">{isMongo ? 'mongo' : db.engine === 'postgres' ? 'postgresql' : 'mariadb'} · {db.connection?.database}</Mono>
          {isMongo && (
            <div className="flex flex-wrap gap-1">
              {Object.entries(MONGO_PRESETS).map(([k, v]) => (
                <Button key={k} variant="ghost" size="xs" className="font-mono text-muted-foreground" onClick={() => setText(JSON.stringify(v, null, 2))}>{k}</Button>
              ))}
            </div>
          )}
          <div className="ml-auto flex items-center gap-3">
            <span className="hidden items-center gap-1 text-xs text-muted-foreground sm:flex"><Kbd>{isMac ? '⌘' : 'Ctrl'}</Kbd><Kbd>↵</Kbd></span>
            <Button size="sm" onClick={() => run()} disabled={exec.isPending}>
              {exec.isPending ? <Loader2 className="animate-spin" /> : <Play />}Jalankan
            </Button>
          </div>
        </div>
        <textarea
          rows={isMongo ? 10 : 8} value={text} spellCheck={false} aria-label="Query"
          className="block w-full resize-y bg-transparent px-4 py-3 font-mono text-[13px] leading-relaxed outline-none placeholder:text-muted-foreground"
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run() } }}
        />
        <div className="border-t bg-muted/30 px-4 py-2 text-xs text-muted-foreground">
          Satu perintah per eksekusi · maks 30 detik · tampil maks 1.000 {isMongo ? 'dokumen' : 'baris'} · semua query tercatat di audit log
        </div>
      </div>

      <ErrorAlert error={parseError} />
      {exec.error && !confirmError && <ErrorAlert error={exec.error} />}

      {r && (
        <div className="overflow-hidden rounded-xl border bg-card">
          <div className="flex flex-wrap items-center gap-4 border-b px-4 py-2.5 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5"><Clock className="size-3.5" />{r.durationMs} ms</span>
            {('documents' in r || r.columns.length > 0) && <span className="inline-flex items-center gap-1.5"><Rows3 className="size-3.5" />{count.toLocaleString('id-ID')} {isMongo ? 'dokumen' : 'baris'}</span>}
            {r.affected !== null && <span>{r.affected.toLocaleString('id-ID')} terdampak</span>}
            {'command' in r && r.command && r.command !== 'SELECT' && <Mono className="text-xs">{r.command}</Mono>}
          </div>
          {r.truncated && (
            <Alert className="rounded-none border-x-0 border-t-0 border-warning/40 text-warning [&>svg]:text-warning">
              <TriangleAlert /><AlertDescription>Hasil dipotong di 1.000. Tambahkan filter atau LIMIT untuk melihat sisanya.</AlertDescription>
            </Alert>
          )}
          {'columns' in r && r.columns.length > 0 && (
            <div className="max-h-[520px] overflow-auto">
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-card shadow-[inset_0_-1px_0_var(--border)]">
                  <TableRow className="hover:bg-transparent">{r.columns.map((c, i) => <TableHead key={i} className="font-mono text-xs">{c}</TableHead>)}</TableRow>
                </TableHeader>
                <TableBody>{r.rows.map((row, i) => <TableRow key={i}>{row.map((v, j) => <Cell key={j} v={v} />)}</TableRow>)}</TableBody>
              </Table>
            </div>
          )}
          {'columns' in r && r.columns.length === 0 && <p className="px-4 py-6 text-sm text-muted-foreground">Perintah berhasil dijalankan.</p>}
          {'documents' in r && (r.documents.length > 0
            ? <pre className={cn('max-h-[520px] overflow-auto px-4 py-3 font-mono text-xs leading-relaxed')}>{r.documents.map(d => JSON.stringify(d, null, 2)).join('\n')}</pre>
            : <p className="px-4 py-6 text-sm text-muted-foreground">Perintah berhasil dijalankan.</p>)}
        </div>
      )}

      <ConfirmByName
        open={needsConfirm} onOpenChange={setNeedsConfirm} name={db.name} title="Jalankan perintah destruktif?" action="Jalankan"
        description="Perintah ini menghapus atau mengubah semua data (DROP, TRUNCATE, atau DELETE/UPDATE tanpa WHERE). Pastikan ini yang kamu maksud."
        busy={exec.isPending} error={confirmError ? null : exec.error} onConfirm={() => run(db.name)}
      />
    </div>
  )
}
