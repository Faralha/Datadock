import { useQuery } from '@tanstack/react-query'
import { Link, Redirect, Route, Switch } from 'wouter'
import { api, ApiError, type Me } from './api.ts'
import { AppShell } from '@/components/app-shell'
import { EmptyState, ErrorAlert } from '@/components/common'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import { Compass } from 'lucide-react'
import { LoginPage } from './pages/Login.tsx'
import { ProjectsPage } from './pages/Projects.tsx'
import { ProjectPage } from './pages/Project.tsx'
import { DatabasePage } from './pages/Database.tsx'
import { AdminAuditPage, AdminJobsPage, AdminQuotasPage } from './pages/Admin.tsx'

export function useMe() {
  return useQuery({ queryKey: ['me'], queryFn: () => api<Me>('GET', '/api/me') })
}

export function App() {
  const me = useMe()
  if (me.isLoading) {
    return (
      <div className="flex min-h-svh">
        <div className="hidden w-64 border-r bg-sidebar lg:block" />
        <div className="mx-auto w-full max-w-6xl space-y-4 px-8 py-10">
          <Skeleton className="h-8 w-48" /><Skeleton className="h-4 w-80" /><Skeleton className="mt-8 h-32 w-full" />
        </div>
      </div>
    )
  }
  if (me.error instanceof ApiError && me.error.status === 401) return <LoginPage />
  if (me.error) return <div className="p-8"><ErrorAlert error={me.error} /></div>
  const data = me.data!

  return (
    <AppShell me={data}>
      <Switch>
        <Route path="/" component={ProjectsPage} />
        <Route path="/projects/:pid">{p => <ProjectPage projectId={Number(p.pid)} />}</Route>
        <Route path="/databases/:id">{p => <DatabasePage id={p.id} />}</Route>
        {data.user.isAdmin && <Route path="/admin"><Redirect to="/admin/quotas" /></Route>}
        {data.user.isAdmin && <Route path="/admin/quotas" component={AdminQuotasPage} />}
        {data.user.isAdmin && <Route path="/admin/audit" component={AdminAuditPage} />}
        {data.user.isAdmin && <Route path="/admin/jobs" component={AdminJobsPage} />}
        <Route>
          <EmptyState icon={<Compass className="size-5" />} title="Halaman tidak ditemukan" description="Alamat ini tidak ada atau kamu tidak punya akses."
            action={<Button asChild variant="outline"><Link href="/">Kembali ke overview</Link></Button>} />
        </Route>
      </Switch>
    </AppShell>
  )
}
