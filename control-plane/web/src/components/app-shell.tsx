import { useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useLocation } from 'wouter'
import { LayoutGrid, Gauge, ScrollText, Timer, Menu, LogOut, Sun, Moon, Monitor, ChevronsUpDown, Check, ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { useTheme, type ThemeChoice } from '@/lib/theme'
import { api, healthQuery, type Me } from '@/api'
import { Dot } from './common'

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2 font-semibold tracking-tight', className)}>
      <span className="flex size-6 items-center justify-center rounded-md bg-foreground text-background">
        <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
          <ellipse cx="8" cy="4" rx="5" ry="2" />
          <path d="M3 4v4c0 1.1 2.2 2 5 2s5-.9 5-2V4M3 8v4c0 1.1 2.2 2 5 2s5-.9 5-2V8" />
        </svg>
      </span>
      DataDock
    </span>
  )
}

function NavItem({ href, icon, children, match }: { href: string; icon: ReactNode; children: ReactNode; match?: (p: string) => boolean }) {
  const [path] = useLocation()
  const active = match ? match(path) : path === href
  return (
    <Link href={href} className={cn(
      'flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors [&_svg]:size-4 [&_svg]:text-muted-foreground',
      active ? 'bg-sidebar-accent font-medium text-foreground [&_svg]:text-foreground' : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground',
    )}>{icon}{children}</Link>
  )
}

function SectionLabel({ children }: { children: ReactNode }) {
  return <div className="px-2.5 pt-5 pb-1.5 text-[11px] font-medium tracking-wide text-muted-foreground/80 uppercase">{children}</div>
}

function ProjectInitial({ name }: { name: string }) {
  return <span className="flex size-5 shrink-0 items-center justify-center rounded bg-muted text-[10px] font-semibold text-muted-foreground uppercase">{name.slice(0, 1)}</span>
}

function SystemStatus() {
  const q = useQuery({ ...healthQuery, refetchInterval: 30_000 })
  const down = q.data ? Object.entries(q.data.engines).filter(([, s]) => s !== 'up').map(([e]) => e) : []
  return (
    <div className="flex items-center gap-2 px-2.5 py-2 text-xs text-muted-foreground">
      <Dot tone={!q.data ? 'muted' : down.length ? 'error' : 'ok'} />
      {!q.data ? 'Memeriksa server…' : down.length ? `Gangguan: ${down.join(', ')}` : 'Semua server normal'}
    </div>
  )
}

const THEMES: [ThemeChoice, string, ReactNode][] = [['light', 'Terang', <Sun />], ['dark', 'Gelap', <Moon />], ['system', 'Sistem', <Monitor />]]

function UserMenu({ me }: { me: Me }) {
  const qc = useQueryClient()
  const { choice, setTheme } = useTheme()
  const initials = me.user.name.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase()
  async function logout() {
    await api('POST', '/auth/logout')
    qc.clear()
    location.href = '/'
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="flex w-full items-center gap-2.5 rounded-md p-2 text-left text-sm hover:bg-sidebar-accent/60 focus-visible:outline-2">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-brand/80 to-brand text-xs font-semibold text-white">{initials}</span>
          <span className="min-w-0 flex-1 leading-tight">
            <span className="block truncate font-medium">{me.user.name}</span>
            <span className="block truncate text-xs text-muted-foreground">@{me.user.username}{me.user.isAdmin ? ' · Admin' : ''}</span>
          </span>
          <ChevronsUpDown className="size-4 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-60">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Tampilan</DropdownMenuLabel>
        {THEMES.map(([t, label, icon]) => (
          <DropdownMenuItem key={t} onSelect={e => { e.preventDefault(); setTheme(t) }}>
            {icon}{label}{choice === t && <Check className="ml-auto" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={logout}><LogOut />Keluar</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// Di halaman database, project induknya ikut disorot. Data diambil dari cache query halaman itu.
function useActiveProjectId() {
  const [path] = useLocation()
  const dbId = /^\/databases\/([^/]+)/.exec(path)?.[1]
  const db = useQuery<{ projectId: number }>({ queryKey: ['database', dbId], enabled: false })
  const pid = /^\/projects\/(\d+)/.exec(path)?.[1]
  return pid ? Number(pid) : db.data?.projectId
}

const SIDEBAR_PROJECTS = 10

function ProjectLink({ project, active }: { project: Me['projects'][number]; active: boolean }) {
  return (
    <NavItem href={`/projects/${project.id}`} icon={<ProjectInitial name={project.name} />} match={() => active}>
      <span className="truncate">{project.name}</span>
    </NavItem>
  )
}

// 10 project pertama selalu tampil; sisanya dilipat supaya menu Admin tidak terdorong jauh ke bawah.
// Bagian lipatan terbuka sendiri bila project yang sedang dibuka ada di sana.
function ProjectList({ projects, activeProject }: { projects: Me['projects']; activeProject?: number }) {
  // null = otomatis (terbuka bila project aktif tersembunyi); setelah diklik, pilihan user yang dipakai
  const [open, setOpen] = useState<boolean | null>(null)
  const shown = projects.slice(0, SIDEBAR_PROJECTS), rest = projects.slice(SIDEBAR_PROJECTS)
  const expanded = open ?? rest.some(p => p.id === activeProject)
  return (
    <>
      {shown.map(p => <ProjectLink key={p.id} project={p} active={activeProject === p.id} />)}
      {rest.length > 0 && (
        <Collapsible open={expanded} onOpenChange={setOpen}>
          <CollapsibleContent>
            {rest.map(p => <ProjectLink key={p.id} project={p} active={activeProject === p.id} />)}
          </CollapsibleContent>
          <CollapsibleTrigger className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-foreground focus-visible:outline-2">
            <ChevronDown className={cn('size-4 transition-transform', expanded && 'rotate-180')} />
            {expanded ? 'Tampilkan lebih sedikit' : `${rest.length} project lainnya`}
          </CollapsibleTrigger>
        </Collapsible>
      )}
    </>
  )
}

function SidebarContent({ me }: { me: Me }) {
  const activeProject = useActiveProjectId()
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 items-center px-4"><Link href="/"><Logo /></Link></div>
      <nav className="flex-1 overflow-y-auto px-2.5 pb-4">
        <NavItem href="/" icon={<LayoutGrid />}>Overview</NavItem>
        <SectionLabel>Project</SectionLabel>
        {me.projects.length === 0 && <div className="px-2.5 text-xs text-muted-foreground">Belum ada project</div>}
        <ProjectList projects={me.projects} activeProject={activeProject} />
        {me.user.isAdmin && (
          <>
            <SectionLabel>Admin</SectionLabel>
            <NavItem href="/admin/quotas" icon={<Gauge />}>Quota</NavItem>
            <NavItem href="/admin/audit" icon={<ScrollText />}>Audit log</NavItem>
            <NavItem href="/admin/jobs" icon={<Timer />}>Job terjadwal</NavItem>
          </>
        )}
      </nav>
      <div className="border-t border-sidebar-border p-2">
        <SystemStatus />
        <UserMenu me={me} />
      </div>
    </div>
  )
}

export function AppShell({ me, children }: { me: Me; children: ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false)
  const [path] = useLocation()
  return (
    <div className="min-h-svh bg-background">
      <aside className="fixed inset-y-0 left-0 hidden w-64 border-r border-sidebar-border bg-sidebar lg:block">
        <SidebarContent me={me} />
      </aside>
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="w-72 bg-sidebar p-0" onClick={e => { if ((e.target as HTMLElement).closest('a')) setMobileOpen(false) }}>
          <SheetTitle className="sr-only">Navigasi</SheetTitle>
          <SidebarContent me={me} />
        </SheetContent>
      </Sheet>
      <div className="lg:pl-64">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b bg-background/80 px-4 backdrop-blur lg:hidden">
          <Button variant="ghost" size="icon-sm" onClick={() => setMobileOpen(true)} aria-label="Buka navigasi"><Menu /></Button>
          <Link href="/"><Logo /></Link>
        </header>
        <main key={path} className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-8 lg:py-10">{children}</main>
      </div>
    </div>
  )
}
