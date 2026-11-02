import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'wouter'
import { ArrowUpRight, ChevronLeft, ChevronRight, FolderGit2, Search, X } from 'lucide-react'
import { useMe } from '../App.tsx'
import { api, formatBytes, type Me, type ProjectSummary } from '@/api'
import { EmptyState, EngineMark, PageHeader, StatCard } from '@/components/common'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'

const PAGE_SIZE = 12

type Project = Me['projects'][number]

// Grup parent GitLab: path tanpa segmen terakhir (lab/tim-a → lab, lab/riset/x → lab/riset)
const parentOf = (path: string) => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '—'

function groupByParent(projects: Project[]) {
  const groups = new Map<string, Project[]>()
  for (const p of projects) groups.set(parentOf(p.path), [...(groups.get(parentOf(p.path)) ?? []), p])
  return [...groups]
}

function ProjectCard({ project, summary }: { project: Project; summary?: ProjectSummary }) {
  return (
    <Link href={`/projects/${project.id}`}
      className="group relative rounded-xl border bg-card p-5 transition-all hover:border-foreground/20 hover:shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-medium">{project.name}</div>
          <div className="truncate font-mono text-xs text-muted-foreground">{project.path}</div>
        </div>
        <ArrowUpRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
      </div>
      <div className="mt-6 flex items-end justify-between gap-3">
        {summary ? (
          <div className="flex items-center gap-3">
            {summary.engines.length > 0 && (
              <div className="flex -space-x-1.5">
                {summary.engines.map(e => <EngineMark key={e} engine={e} size="sm" />)}
              </div>
            )}
            <span className="text-xs text-muted-foreground">
              {summary.databases}/{summary.maxDatabases} database · {formatBytes(summary.sizeBytes)}
            </span>
          </div>
        ) : <Skeleton className="h-6 w-40" />}
        <Badge variant="secondary" className="font-normal">{project.role === 'maintainer' ? 'Maintainer' : 'Developer'}</Badge>
      </div>
    </Link>
  )
}

function Pagination({ page, pages, from, to, total, onPage }: { page: number; pages: number; from: number; to: number; total: number; onPage: (p: number) => void }) {
  return (
    <div className="mt-8 flex items-center justify-between gap-3 text-sm text-muted-foreground">
      <span>{from}–{to} dari {total} project</span>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}><ChevronLeft />Sebelumnya</Button>
        <span className="tabular-nums">{page} / {pages}</span>
        <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>Berikutnya<ChevronRight /></Button>
      </div>
    </div>
  )
}

export function ProjectsPage() {
  const { data } = useMe()
  const { user, projects } = data!
  const summaries = useQuery({ queryKey: ['projects'], queryFn: () => api<{ projects: ProjectSummary[] }>('GET', '/api/projects') })
  const byId = useMemo(() => new Map(summaries.data?.projects.map(s => [s.id, s])), [summaries.data])
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)

  const all = summaries.data?.projects ?? []
  const totalDbs = all.reduce((s, p) => s + p.databases, 0)
  const totalSize = all.reduce((s, p) => s + p.sizeBytes, 0)
  const limited = all.reduce((s, p) => s + p.limited, 0)

  // Urut path supaya project satu grup selalu berdampingan, juga saat terpotong antar halaman
  const q = query.trim().toLowerCase()
  const filtered = useMemo(() => [...projects]
    .filter(p => !q || p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q))
    .sort((a, b) => a.path.localeCompare(b.path)), [projects, q])
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const current = Math.min(page, pages)
  const visible = filtered.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE)

  function search(v: string) {
    setQuery(v)
    setPage(1)
  }

  return (
    <>
      <PageHeader title={`Halo, ${user.name.split(' ')[0]}`} description="Ringkasan database di semua project-mu." />

      {projects.length === 0 ? (
        <EmptyState icon={<FolderGit2 className="size-5" />} title="Belum ada project"
          description="Kamu perlu akses minimal Developer di sebuah project GitLab lab. Minta Maintainer project menambahkanmu, lalu masuk ulang." />
      ) : (
        <>
          <div className="mb-10 grid gap-4 sm:grid-cols-3">
            <StatCard label="Project" value={projects.length} hint="Dengan akses Developer atau lebih" />
            <StatCard label="Database" value={summaries.data ? totalDbs : '…'} hint={limited ? `${limited} terbatas karena quota` : 'Semua dapat ditulisi'} />
            <StatCard label="Total penyimpanan" value={summaries.data ? formatBytes(totalSize) : '…'} hint="Diperbarui tiap 5 menit" />
          </div>

          <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <h2 className="text-sm font-medium text-muted-foreground">Project</h2>
            <div className="relative sm:w-80">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={query} onChange={e => search(e.target.value)} placeholder="Cari nama atau path project…"
                aria-label="Cari project" className="pr-8 pl-8" />
              {query && (
                <button type="button" onClick={() => search('')} aria-label="Hapus pencarian"
                  className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground">
                  <X className="size-4" />
                </button>
              )}
            </div>
          </div>

          {filtered.length === 0 ? (
            <EmptyState icon={<Search className="size-5" />} title="Tidak ada project yang cocok"
              description={`Tidak ada project dengan nama atau path yang memuat "${query.trim()}".`} />
          ) : (
            <>
              <div className="space-y-8">
                {groupByParent(visible).map(([group, items]) => (
                  <section key={group}>
                    <div className="mb-3 flex items-center gap-2">
                      <FolderGit2 className="size-4 text-muted-foreground" />
                      <h3 className="font-mono text-sm">{group}</h3>
                      <span className="text-xs text-muted-foreground">
                        {filtered.filter(p => parentOf(p.path) === group).length} project
                      </span>
                    </div>
                    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                      {items.map(p => <ProjectCard key={p.id} project={p} summary={byId.get(p.id)} />)}
                    </div>
                  </section>
                ))}
              </div>
              {pages > 1 && (
                <Pagination page={current} pages={pages} total={filtered.length}
                  from={(current - 1) * PAGE_SIZE + 1} to={Math.min(current * PAGE_SIZE, filtered.length)}
                  onPage={p => { setPage(p); window.scrollTo({ top: 0, behavior: 'smooth' }) }} />
              )}
            </>
          )}
        </>
      )}
    </>
  )
}
