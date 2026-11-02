// Tema terang/gelap/sistem: kelas `.dark` di <html>, pilihan disimpan per browser
import { useEffect, useSyncExternalStore } from 'react'

export type ThemeChoice = 'light' | 'dark' | 'system'
const KEY = 'datadock-theme'
const listeners = new Set<() => void>()
const media = window.matchMedia('(prefers-color-scheme: dark)')

function read(): ThemeChoice {
  try { return (localStorage.getItem(KEY) as ThemeChoice) || 'system' } catch { return 'system' }
}
const resolve = (c: ThemeChoice) => (c === 'system' ? (media.matches ? 'dark' : 'light') : c)
function apply() { document.documentElement.classList.toggle('dark', resolve(read()) === 'dark') }

apply()
media.addEventListener('change', () => { apply(); listeners.forEach(l => l()) })

export function setTheme(c: ThemeChoice) {
  try { localStorage.setItem(KEY, c) } catch {}
  apply()
  listeners.forEach(l => l())
}

export function useTheme() {
  const choice = useSyncExternalStore(cb => { listeners.add(cb); return () => listeners.delete(cb) }, read)
  useEffect(apply, [choice])
  return { choice, resolved: resolve(choice) as 'light' | 'dark', setTheme }
}
