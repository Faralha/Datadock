// Klien GitLab API v4 + OAuth2 (authorization code + PKCE)
import { createHash } from 'node:crypto'
import { randomToken } from './crypto.ts'

export const ACCESS = { guest: 10, reporter: 20, developer: 30, maintainer: 40, owner: 50 } as const
export type Role = 'developer' | 'maintainer'
export const roleFromAccess = (level: number): Role | null =>
  level >= ACCESS.maintainer ? 'maintainer' : level >= ACCESS.developer ? 'developer' : null

export type GitlabUser = { id: number; username: string; name: string; state?: string }
export type GitlabProject = { id: number; path_with_namespace: string; name: string }
export type GitlabMember = { id: number; username: string; access_level: number; state?: string }

export class GitlabError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

export function createGitlab(opts: { url: string; clientId: string; clientSecret: string; botToken: string; redirectUri: string }) {
  async function api<T>(path: string, token: string): Promise<{ data: T; nextPage: string | null }> {
    const r = await fetch(`${opts.url}/api/v4${path}`, { headers: { authorization: `Bearer ${token}` } })
    if (!r.ok) throw new GitlabError(r.status, `GitLab ${path}: ${r.status} ${(await r.text()).slice(0, 200)}`)
    return { data: (await r.json()) as T, nextPage: r.headers.get('x-next-page') || null }
  }

  async function paginate<T>(path: string, token: string) {
    const out: T[] = []
    const sep = path.includes('?') ? '&' : '?'
    for (let page: string | null = '1'; page; ) {
      const r: { data: T[]; nextPage: string | null } = await api<T[]>(`${path}${sep}per_page=100&page=${page}`, token)
      out.push(...r.data)
      page = r.nextPage
    }
    return out
  }

  return {
    // Mulai login: state + verifier PKCE disimpan pemanggil
    authorizeUrl() {
      const state = randomToken(24)
      const verifier = randomToken(48)
      const challenge = createHash('sha256').update(verifier).digest('base64url')
      const u = new URL(`${opts.url}/oauth/authorize`)
      u.search = new URLSearchParams({
        client_id: opts.clientId, redirect_uri: opts.redirectUri, response_type: 'code',
        scope: 'openid profile read_api', state, code_challenge: challenge, code_challenge_method: 'S256',
      }).toString()
      return { url: u.toString(), state, verifier }
    },

    async exchangeCode(code: string, verifier: string) {
      const r = await fetch(`${opts.url}/oauth/token`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: opts.clientId, client_secret: opts.clientSecret, code, grant_type: 'authorization_code',
          redirect_uri: opts.redirectUri, code_verifier: verifier,
        }),
      })
      if (!r.ok) throw new GitlabError(r.status, `token exchange gagal: ${r.status}`)
      return ((await r.json()) as { access_token: string }).access_token
    },

    currentUser: async (token: string) => (await api<GitlabUser>('/user', token)).data,

    // Dua kueri dengan min_access_level menghitung akses warisan grup dengan benar (dihitung GitLab sendiri)
    async userProjects(token: string) {
      const [dev, maint] = await Promise.all([
        paginate<GitlabProject>(`/projects?membership=true&min_access_level=${ACCESS.developer}&simple=true`, token),
        paginate<GitlabProject>(`/projects?membership=true&min_access_level=${ACCESS.maintainer}&simple=true`, token),
      ])
      const maintIds = new Set(maint.map(p => p.id))
      return dev.map(p => ({ project: p, role: (maintIds.has(p.id) ? 'maintainer' : 'developer') as Role }))
    },

    async isGroupMember(token: string, group: string, userId: number) {
      try {
        const { data } = await api<GitlabMember>(`/groups/${encodeURIComponent(group)}/members/all/${userId}`, token)
        return data.state !== 'blocked'
      } catch (e) {
        if (e instanceof GitlabError && e.status === 404) return false
        throw e
      }
    },

    // Sinkron berkala dengan token bot (FR-04, FR-05)
    async projectMembers(projectId: number) {
      return paginate<GitlabMember>(`/projects/${projectId}/members/all`, opts.botToken)
    },

    // CI/CD variable dengan token bot (FR-13..15). Kunci + environment_scope menentukan satu variable.
    async upsertVariable(projectId: number, v: { key: string; value: string; masked: boolean; environment_scope: string }) {
      const body = JSON.stringify({ ...v, raw: true, protected: false, variable_type: 'env_var' })
      const headers = { authorization: `Bearer ${opts.botToken}`, 'content-type': 'application/json' }
      const created = await fetch(`${opts.url}/api/v4/projects/${projectId}/variables`, { method: 'POST', headers, body })
      if (created.ok) return
      const text = await created.text()
      if (created.status !== 400 || !/already been taken/.test(text))
        throw new GitlabError(created.status, `buat variable ${v.key}: ${created.status} ${text.slice(0, 200)}`)
      const scope = encodeURIComponent(v.environment_scope)
      const updated = await fetch(`${opts.url}/api/v4/projects/${projectId}/variables/${v.key}?filter[environment_scope]=${scope}`,
        { method: 'PUT', headers, body })
      if (!updated.ok) throw new GitlabError(updated.status, `ubah variable ${v.key}: ${updated.status} ${(await updated.text()).slice(0, 200)}`)
    },

    async deleteVariable(projectId: number, key: string, environmentScope: string) {
      const scope = encodeURIComponent(environmentScope)
      const r = await fetch(`${opts.url}/api/v4/projects/${projectId}/variables/${key}?filter[environment_scope]=${scope}`,
        { method: 'DELETE', headers: { authorization: `Bearer ${opts.botToken}` } })
      if (!r.ok && r.status !== 404) throw new GitlabError(r.status, `hapus variable ${key}: ${r.status}`)
    },

    async project(projectId: number) {
      try {
        return (await api<GitlabProject>(`/projects/${projectId}`, opts.botToken)).data
      } catch (e) {
        if (e instanceof GitlabError && e.status === 404) return null
        throw e
      }
    },
  }
}
export type Gitlab = ReturnType<typeof createGitlab>
