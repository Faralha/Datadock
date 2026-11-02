// GitLab palsu (HTTP) untuk test: OAuth + PKCE dan endpoint API v4 yang dipakai control plane
import { createHash } from 'node:crypto'

type User = { id: number; username: string; name: string; token: string }

export function startFakeGitlab(botToken: string, port = 0) {
  const users = new Map<number, User>()
  const projects = new Map<number, { id: number; path_with_namespace: string; name: string }>()
  const members = new Map<number, Map<number, number>>() // project → user → access level
  const groups = new Map<string, Set<number>>()
  const codes = new Map<string, { userId: number; challenge: string }>()
  const variables = new Map<string, { key: string; value: string; masked: boolean; environment_scope: string }>()
  let variablesDown = false

  const userByToken = (req: Request) => {
    const t = req.headers.get('authorization')?.replace(/^Bearer /, '')
    return [...users.values()].find(u => u.token === t) ?? null
  }
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'x-next-page': '' } })

  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url)
      const p = url.pathname
      // Halaman authorize untuk pemakaian dev di browser: pilih user, lalu kembali ke redirect_uri
      if (p === '/oauth/authorize') {
        const as = url.searchParams.get('as')
        if (as) {
          const code = crypto.randomUUID()
          codes.set(code, { userId: Number(as), challenge: url.searchParams.get('code_challenge')! })
          const back = new URL(url.searchParams.get('redirect_uri')!)
          back.searchParams.set('code', code)
          back.searchParams.set('state', url.searchParams.get('state')!)
          return Response.redirect(back.toString(), 302)
        }
        const links = [...users.values()].map(u => {
          const q = new URLSearchParams(url.searchParams); q.set('as', String(u.id))
          return `<li><a href="/oauth/authorize?${q}">${u.username}</a></li>`
        }).join('')
        return new Response(`<!doctype html><meta charset="utf-8"><title>GitLab palsu</title>
          <body style="font-family:system-ui;max-width:420px;margin:10vh auto"><h2>GitLab palsu (dev)</h2>
          <p>Masuk sebagai:</p><ul>${links}</ul></body>`, { headers: { 'content-type': 'text/html; charset=utf-8' } })
      }
      if (p === '/oauth/token' && req.method === 'POST') {
        const form = new URLSearchParams(await req.text())
        const c = codes.get(form.get('code') ?? '')
        const verifier = form.get('code_verifier') ?? ''
        if (!c || createHash('sha256').update(verifier).digest('base64url') !== c.challenge) return json({ error: 'invalid_grant' }, 400)
        codes.delete(form.get('code')!)
        return json({ access_token: users.get(c.userId)!.token, token_type: 'Bearer' })
      }
      const isBot = req.headers.get('authorization') === `Bearer ${botToken}`
      const me = userByToken(req)
      if (!me && !isBot) return json({ message: '401 Unauthorized' }, 401)

      if (p === '/api/v4/user') return me ? json(me) : json({}, 403)
      if (p === '/api/v4/projects') {
        const min = Number(url.searchParams.get('min_access_level') ?? 10)
        return json([...projects.values()].filter(pr => (members.get(pr.id)?.get(me!.id) ?? 0) >= min))
      }
      let m = /^\/api\/v4\/groups\/([^/]+)\/members\/all\/(\d+)$/.exec(p)
      if (m) {
        return groups.get(decodeURIComponent(m[1]))?.has(Number(m[2])) ? json({ id: Number(m[2]), access_level: 30 }) : json({}, 404)
      }
      m = /^\/api\/v4\/projects\/(\d+)\/members\/all$/.exec(p)
      if (m && isBot) {
        const pm = members.get(Number(m[1]))
        if (!pm) return json({ message: '404' }, 404)
        return json([...pm].map(([id, access_level]) => ({ id, username: users.get(id)?.username, access_level })))
      }
      m = /^\/api\/v4\/projects\/(\d+)\/variables(?:\/([A-Za-z0-9_]+))?$/.exec(p)
      if (m && isBot) {
        if (variablesDown) return json({ message: '503 Service Unavailable' }, 503)
        const pid = Number(m[1])
        if (req.method === 'POST') {
          const v = await req.json() as any
          // Aturan masking GitLab: ≥ 8 karakter, tanpa spasi/'?'/'&'
          if (v.masked && (v.value.length < 8 || /[\s?&]/.test(v.value))) return json({ message: { value: ['is invalid'] } }, 400)
          const id = `${pid}|${v.key}|${v.environment_scope}`
          if (variables.has(id)) return json({ message: { key: [`(${v.key}) has already been taken`] } }, 400)
          variables.set(id, v)
          return json(v, 201)
        }
        const id = `${pid}|${m[2]}|${url.searchParams.get('filter[environment_scope]')}`
        if (!variables.has(id)) return json({ message: '404 Variable Not Found' }, 404)
        if (req.method === 'PUT') { variables.set(id, { ...variables.get(id), ...(await req.json() as any) }); return json(variables.get(id)) }
        if (req.method === 'DELETE') { variables.delete(id); return new Response(null, { status: 204 }) }
      }
      m = /^\/api\/v4\/projects\/(\d+)$/.exec(p)
      if (m && isBot) return projects.has(Number(m[1])) ? json(projects.get(Number(m[1]))) : json({ message: '404' }, 404)
      return json({ message: '404 Not Found' }, 404)
    },
  })

  return {
    url: `http://localhost:${server.port}`,
    addUser(id: number, username: string) {
      users.set(id, { id, username, name: username.toUpperCase(), token: `tok-${id}-${crypto.randomUUID()}` })
    },
    addProject(id: number, path: string) {
      projects.set(id, { id, path_with_namespace: path, name: path.split('/').pop()! })
      members.set(id, new Map())
    },
    setMember(projectId: number, userId: number, access: number | null) {
      if (access === null) members.get(projectId)!.delete(userId)
      else members.get(projectId)!.set(userId, access)
    },
    addGroupMember(group: string, userId: number) {
      if (!groups.has(group)) groups.set(group, new Set())
      groups.get(group)!.add(userId)
    },
    // Simulasi user menyetujui di halaman authorize GitLab
    approve(authorizeUrl: string, userId: number) {
      const u = new URL(authorizeUrl)
      const code = crypto.randomUUID()
      codes.set(code, { userId, challenge: u.searchParams.get('code_challenge')! })
      return { code, state: u.searchParams.get('state')! }
    },
    // Variable CI milik satu project, dikelompokkan per environment scope
    variables(projectId: number) {
      return [...variables].filter(([id]) => id.startsWith(`${projectId}|`)).map(([, v]) => v)
    },
    setVariablesDown(down: boolean) { variablesDown = down },
    stop() { server.stop(true) },
  }
}
export type FakeGitlab = ReturnType<typeof startFakeGitlab>
