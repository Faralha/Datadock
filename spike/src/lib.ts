// Helper kecil: check() mencatat PASS/FAIL per ID, results ditulis ke results/<file>.json
import { mkdirSync, writeFileSync } from 'node:fs'

export type Result = { id: string; status: 'PASS' | 'FAIL'; note: string }
export const results: Result[] = []

export async function check(id: string, fn: () => Promise<string | void>) {
  // SKIP=MY-8,MY-9 → lewati langkah tertentu (untuk bisect)
  if (process.env.SKIP?.split(',').includes(id)) return
  const t0 = performance.now()
  try {
    const note = (await fn()) ?? ''
    results.push({ id, status: 'PASS', note })
    console.log(`PASS ${id} (${Math.round(performance.now() - t0)}ms) ${note}`)
  } catch (e: any) {
    const note = String(e?.message ?? e).split('\n')[0]
    results.push({ id, status: 'FAIL', note })
    console.log(`FAIL ${id} ${note}`)
  }
}

// Untuk langkah yang HARUS gagal: lempar kalau fn sukses, kembalikan pesan error kalau gagal
export async function expectReject(fn: () => Promise<unknown>, match?: RegExp) {
  try {
    await fn()
  } catch (e: any) {
    const msg = String(e?.message ?? e)
    if (match && !match.test(msg)) throw new Error(`ditolak dengan pesan tak terduga: ${msg}`)
    return `ditolak: ${msg.split('\n')[0]}`
  }
  throw new Error('seharusnya ditolak, tapi berhasil')
}

export function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg)
}

export function saveResults(name: string) {
  mkdirSync('results', { recursive: true })
  writeFileSync(`results/${name}.json`, JSON.stringify({ runtime: runtimeName(), results }, null, 2))
  console.log(`\n${results.filter(r => r.status === 'PASS').length}/${results.length} PASS`)
}

export function runtimeName() {
  return typeof Bun !== 'undefined' ? `bun ${Bun.version}` : `node ${process.version}`
}

export const env = (k: string) => {
  const v = process.env[k]
  if (!v) throw new Error(`env ${k} kosong`)
  return v
}

// Ganti user/password di URL koneksi (dipakai untuk konek sebagai tenant)
export function withCreds(url: string, user: string, pass: string, path?: string, params?: Record<string, string>) {
  const u = new URL(url)
  u.username = user
  u.password = pass
  if (path !== undefined) u.pathname = '/' + path
  if (params) for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
  return u.toString()
}
