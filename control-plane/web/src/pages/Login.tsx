import { ArrowRight, DatabaseZap, KeyRound, ShieldCheck, TerminalSquare } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Logo } from '@/components/app-shell'
import { EngineMark } from '@/components/common'

const FEATURES = [
  { icon: <DatabaseZap />, title: 'Database dalam hitungan detik', text: 'PostgreSQL, MariaDB, atau MongoDB, langsung siap dipakai.' },
  { icon: <KeyRound />, title: 'Credential otomatis di CI/CD', text: 'Variable GitLab terpasang dan diperbarui saat rotasi.' },
  { icon: <TerminalSquare />, title: 'Console di browser', text: 'Lihat dan ubah data tanpa memasang aplikasi tambahan.' },
  { icon: <ShieldCheck />, title: 'Backup harian dan audit', text: 'Backup 7 hari dan jejak setiap aksi.' },
]

export function LoginPage() {
  return (
    <div className="grid min-h-svh lg:grid-cols-[1.1fr_1fr]">
      <section className="relative hidden overflow-hidden border-r bg-sidebar p-12 lg:flex lg:flex-col">
        {/* Grid halus sebagai latar */}
        <div aria-hidden className="pointer-events-none absolute inset-0 opacity-[0.5] [background-image:linear-gradient(to_right,var(--border)_1px,transparent_1px),linear-gradient(to_bottom,var(--border)_1px,transparent_1px)] [background-size:44px_44px] [mask-image:radial-gradient(ellipse_at_30%_40%,black,transparent_75%)]" />
        <div aria-hidden className="pointer-events-none absolute -top-40 -left-40 size-[480px] rounded-full bg-brand/15 blur-3xl" />
        <Logo className="relative text-base" />
        <div className="relative mt-auto max-w-md">
          <div className="mb-6 flex gap-2"><EngineMark engine="postgres" /><EngineMark engine="mariadb" /><EngineMark engine="mongo" /></div>
          <h2 className="text-3xl font-semibold tracking-tight text-balance">Database untuk setiap project Lab MCI.</h2>
          <p className="mt-3 text-muted-foreground">Masuk dengan akun GitLab, pilih project, dan mulai ngoding. Tanpa menunggu admin.</p>
          <ul className="mt-10 grid gap-5">
            {FEATURES.map(f => (
              <li key={f.title} className="flex gap-3">
                <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border bg-card text-muted-foreground shadow-xs [&_svg]:size-4">{f.icon}</span>
                <span><span className="block text-sm font-medium">{f.title}</span><span className="block text-sm text-muted-foreground">{f.text}</span></span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="flex flex-col p-6 sm:p-12">
        <Logo className="lg:hidden" />
        <div className="m-auto w-full max-w-sm">
          <h1 className="text-2xl font-semibold tracking-tight">Masuk ke DataDock</h1>
          <p className="mt-2 text-sm text-muted-foreground">Gunakan akun GitLab lab. Project dan aksesmu mengikuti keanggotaan di GitLab.</p>
          <Button asChild size="lg" className="mt-8 w-full">
            <a href="/auth/login">
              <svg viewBox="0 0 24 24" className="size-4" fill="currentColor" aria-hidden>
                <path d="m23.6 9.6-.03-.09L20.3.98a.85.85 0 0 0-1.62.06l-2.2 6.75H7.53L5.33 1.04A.85.85 0 0 0 3.7.98L.44 9.51l-.04.09a6.06 6.06 0 0 0 2.01 7l.01.01.03.02 4.98 3.73 2.47 1.86 1.5 1.14a1 1 0 0 0 1.22 0l1.5-1.14 2.47-1.86 5.01-3.75.01-.01a6.06 6.06 0 0 0 2-6.99Z" />
              </svg>
              Lanjutkan dengan GitLab
              <ArrowRight className="ml-auto" />
            </a>
          </Button>
          <p className="mt-6 text-xs leading-relaxed text-muted-foreground">
            Butuh minimal akses <span className="font-medium text-foreground">Developer</span> di project GitLab.
            Belum melihat project-mu? Minta Maintainer project menambahkanmu, lalu masuk ulang.
          </p>
        </div>
        <p className="text-xs text-muted-foreground">Lab MCI · Platform internal</p>
      </section>
    </div>
  )
}
