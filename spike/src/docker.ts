// Docker Engine API lewat fetch + unix socket (tanpa dockerode)
import { createWriteStream } from 'node:fs'

const SOCK = process.env.DOCKER_SOCK ?? '/var/run/docker.sock'
const base = 'http://docker'

function dfetch(path: string, init: RequestInit = {}) {
  // Bun: opsi `unix`; Node (undici) tidak mendukung opsi ini → lihat dfetchNode
  return fetch(`${base}${path}`, { ...init, unix: SOCK } as RequestInit)
}

export async function dockerVersion() {
  const r = await dfetch('/version')
  if (!r.ok) throw new Error(`GET /version ${r.status}`)
  return (await r.json()) as { Version: string; ApiVersion: string; Os: string; KernelVersion: string }
}

async function createExec(container: string, cmd: string[]) {
  const r = await dfetch(`/containers/${container}/exec`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ Cmd: cmd, AttachStdout: true, AttachStderr: true, Tty: false }),
  })
  if (!r.ok) throw new Error(`exec create ${r.status}: ${await r.text()}`)
  return ((await r.json()) as { Id: string }).Id
}

async function startExec(id: string) {
  const r = await dfetch(`/exec/${id}/start`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ Detach: false, Tty: false }),
  })
  if (!r.ok) throw new Error(`exec start ${r.status}: ${await r.text()}`)
  return r
}

// Stream selesai saat proses selesai, tapi ExitCode bisa masih null sesaat → tunggu Running=false
async function exitCode(id: string) {
  for (let i = 0; i < 50; i++) {
    const info = (await (await dfetch(`/exec/${id}/json`)).json()) as { Running: boolean; ExitCode: number | null }
    if (!info.Running && info.ExitCode !== null) return info.ExitCode
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error('exec tidak selesai')
}

export async function dockerExec(container: string, cmd: string[]) {
  const id = await createExec(container, cmd)
  const res = await startExec(id)
  const { stdout, stderr } = demux(new Uint8Array(await res.arrayBuffer()))
  return { exitCode: await exitCode(id), stdout: stdout.toString('utf8'), stderr }
}

// Tty:false → stream multiplexed: header 8 byte [tipe(1=stdout,2=stderr),0,0,0, ukuran uint32 BE] + payload
export function demux(buf: Uint8Array) {
  const out: Uint8Array[] = [], err: Uint8Array[] = []
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  for (let i = 0; i + 8 <= buf.length; ) {
    const type = buf[i], size = view.getUint32(i + 4)
    const chunk = buf.subarray(i + 8, i + 8 + size)
    ;(type === 2 ? err : out).push(chunk)
    i += 8 + size
  }
  return { stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8') }
}

// Versi streaming: demux frame per chunk (frame bisa terpotong antar chunk), stdout ditulis langsung ke file
export async function dockerExecToFile(container: string, cmd: string[], file: string) {
  const id = await createExec(container, cmd)
  const res = await startExec(id)
  const out = createWriteStream(file)
  const errChunks: Uint8Array[] = []
  let pending = new Uint8Array(0)
  let written = 0
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    let buf = pending.length ? Buffer.concat([pending, chunk]) : chunk
    let i = 0
    while (i + 8 <= buf.length) {
      const size = new DataView(buf.buffer, buf.byteOffset + i, 8).getUint32(4)
      if (i + 8 + size > buf.length) break
      const payload = buf.subarray(i + 8, i + 8 + size)
      if (buf[i] === 2) errChunks.push(payload)
      else if (!out.write(payload)) await new Promise(r => out.once('drain', r))
      if (buf[i] !== 2) written += size
      i += 8 + size
    }
    pending = buf.slice(i)
  }
  await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())))
  return { exitCode: await exitCode(id), bytes: written, stderr: Buffer.concat(errChunks).toString('utf8') }
}
