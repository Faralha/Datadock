// Query console (FR-16..18, FR-29) dan penjelajah skema (FR-19). Selalu memakai user database project,
// bukan admin, jadi tidak pernah bisa menyentuh project lain. Timeout 30 detik, maks 1.000 baris (NFR-09).
import postgres from 'postgres'
import mysql from 'mysql2/promise'
import { MongoClient, BSON } from 'mongodb'
import type { Db } from '../db.ts'
import type { Audit, Actor } from '../audit.ts'
import type { Cipher } from '../crypto.ts'
import type { Config } from '../config.ts'
import { engineConfig } from '../config.ts'
import type { DatabaseRow } from './databases.ts'
import { HttpError } from './databases.ts'

export const MAX_ROWS = 1000
const MAX_QUERY_CHARS = 100_000
const AUDIT_QUERY_CHARS = 10_000

export type SqlResult = { kind: 'rows'; columns: string[]; rows: unknown[][]; truncated: boolean; command: string | null; affected: number | null }

// Komentar dibuang dulu supaya `/* */ DROP ...` tetap terdeteksi
const stripComments = (q: string) => q.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ').replace(/#[^\n]*/g, ' ').trim()

// FR-18: DROP/TRUNCATE, atau DELETE/UPDATE tanpa WHERE. Ini pengaman UX, bukan batas keamanan:
// tenant memang berhak penuh atas DB-nya sendiri.
export function isDestructiveSql(query: string) {
  const q = stripComments(query).toLowerCase()
  if (/^(drop|truncate)\b/.test(q)) return true
  if (/^(delete|update)\b/.test(q) && !/\bwhere\b/.test(q)) return true
  return false
}

export type MongoCommand = {
  collection?: string
  operation: 'find' | 'aggregate' | 'count' | 'insertOne' | 'insertMany' | 'updateOne' | 'updateMany' | 'deleteOne' | 'deleteMany' | 'listCollections' | 'drop'
  filter?: object; projection?: object; sort?: object; limit?: number
  pipeline?: object[]; document?: object; documents?: object[]; update?: object | object[]
}

const isEmpty = (o: object | undefined) => !o || Object.keys(o).length === 0
export function isDestructiveMongo(c: MongoCommand) {
  return c.operation === 'drop' || ((c.operation === 'deleteMany' || c.operation === 'updateMany') && isEmpty(c.filter))
}

// Nilai yang tidak bisa langsung jadi JSON (bigint, Buffer, Date) diubah ke bentuk teks
function jsonable(v: unknown): unknown {
  if (v === null || v === undefined) return null
  if (typeof v === 'bigint') return v.toString()
  if (v instanceof Date) return v.toISOString()
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return '\\x' + Buffer.from(v).toString('hex')
  if (Array.isArray(v)) return v.map(jsonable)
  if (typeof v === 'object') return Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, jsonable(x)]))
  return v
}

export function createConsoleService(deps: { db: Db; audit: Audit; cipher: Cipher; cfg: Config }) {
  const { db, audit, cipher, cfg } = deps
  const timeoutS = cfg.queryTimeoutS

  function tenantCreds(row: DatabaseRow) {
    const c = db.query(`SELECT db_user, password_enc FROM credentials WHERE database_id = ?`).get(row.id) as
      { db_user: string; password_enc: string } | null
    if (!c) throw new HttpError(404, 'credential tidak ditemukan')
    return { user: c.db_user, password: cipher.decrypt(c.password_enc) }
  }

  // Engine dijangkau lewat host admin internal, tapi dengan kredensial tenant
  function tenantUrl(row: DatabaseRow) {
    const { user, password } = tenantCreds(row)
    const u = new URL(engineConfig(cfg, row.engine).adminUrl)
    u.username = encodeURIComponent(user)
    u.password = encodeURIComponent(password)
    u.pathname = '/' + row.physical_name
    u.search = ''
    return u
  }

  async function withPg<T>(row: DatabaseRow, fn: (s: postgres.Sql) => Promise<T>) {
    const s = postgres(tenantUrl(row).toString(), { max: 1, connect_timeout: 5, onnotice: () => {}, idle_timeout: 1 })
    try {
      // Setelan sesi, supaya tidak bergantung pada default DB yang bisa diubah tenant
      await s.unsafe(`SET statement_timeout = '${timeoutS}s'`)
      return await fn(s)
    } finally {
      await s.end({ timeout: 1 })
    }
  }

  async function withMy<T>(row: DatabaseRow, fn: (c: mysql.Connection) => Promise<T>) {
    const u = tenantUrl(row)
    const c = await mysql.createConnection({
      host: u.hostname, port: Number(u.port || 3306), user: decodeURIComponent(u.username), password: decodeURIComponent(u.password),
      database: row.physical_name, connectTimeout: 5000, rowsAsArray: true, dateStrings: true, supportBigNumbers: true, bigNumberStrings: true,
    })
    c.on('error', () => {})
    try {
      await c.query(`SET SESSION max_statement_time = ${timeoutS}, sql_select_limit = ${MAX_ROWS + 1}`)
      return await fn(c)
    } finally {
      await c.end().catch(() => {})
    }
  }

  async function withMongo<T>(row: DatabaseRow, fn: (c: MongoClient) => Promise<T>) {
    const c = new MongoClient(tenantUrl(row).toString(), { serverSelectionTimeoutMS: 5000, maxPoolSize: 1 })
    try { return await fn(c) } finally { await c.close() }
  }

  async function runSql(row: DatabaseRow, query: string): Promise<SqlResult> {
    if (row.engine === 'postgres') {
      return withPg(row, async s => {
        let batch: any = null
        for await (const b of s.unsafe(query).values().cursor(MAX_ROWS + 1)) { batch = b; break }
        if (!batch) return { kind: 'rows', columns: [], rows: [], truncated: false, command: null, affected: null }
        return {
          kind: 'rows', columns: (batch.columns ?? []).map((c: any) => c.name),
          rows: jsonable(batch.slice(0, MAX_ROWS)) as unknown[][], truncated: batch.length > MAX_ROWS,
          command: batch.command ?? 'SELECT', affected: batch.command && batch.command !== 'SELECT' ? (batch.count ?? null) : null,
        }
      })
    }
    return withMy(row, async c => {
      const [res, fields] = await c.query(query)
      if (!Array.isArray(res)) {
        const h = res as mysql.ResultSetHeader
        return { kind: 'rows', columns: [], rows: [], truncated: false, command: 'OK', affected: h.affectedRows }
      }
      const rows = res as unknown[][]
      return {
        kind: 'rows', columns: (fields ?? []).map(f => f.name), rows: jsonable(rows.slice(0, MAX_ROWS)) as unknown[][],
        truncated: rows.length > MAX_ROWS, command: 'SELECT', affected: null,
      }
    })
  }

  async function runMongo(row: DatabaseRow, raw: MongoCommand) {
    // EJSON supaya {"$oid": ...} dan {"$date": ...} dari UI menjadi tipe BSON yang benar
    const cmd = BSON.EJSON.deserialize(raw as any, { relaxed: true }) as MongoCommand
    const opts = { maxTimeMS: timeoutS * 1000 }
    return withMongo(row, async client => {
      const d = client.db(row.physical_name)
      if (cmd.operation === 'listCollections') {
        const cols = await d.listCollections({}, { nameOnly: true }).toArray()
        return { documents: cols.map(c => ({ name: c.name })), truncated: false, affected: null }
      }
      if (!cmd.collection || !/^[^$\0][^\0]{0,119}$/.test(cmd.collection)) throw new HttpError(400, 'nama koleksi tidak valid')
      const col = d.collection(cmd.collection)
      const ser = (docs: unknown[]) => docs.map(x => BSON.EJSON.serialize(x as any, { relaxed: true }))
      switch (cmd.operation) {
        case 'find': {
          const limit = Math.min(cmd.limit ?? MAX_ROWS, MAX_ROWS)
          const docs = await col.find(cmd.filter ?? {}, { ...opts, projection: cmd.projection, sort: cmd.sort as any, limit: limit + 1 }).toArray()
          return { documents: ser(docs.slice(0, limit)), truncated: docs.length > limit, affected: null }
        }
        case 'aggregate': {
          const docs: unknown[] = []
          for await (const x of col.aggregate(cmd.pipeline ?? [], opts)) {
            docs.push(x)
            if (docs.length > MAX_ROWS) break
          }
          return { documents: ser(docs.slice(0, MAX_ROWS)), truncated: docs.length > MAX_ROWS, affected: null }
        }
        case 'count':
          return { documents: [{ count: await col.countDocuments(cmd.filter ?? {}, opts) }], truncated: false, affected: null }
        case 'insertOne': {
          const r = await col.insertOne((cmd.document ?? {}) as any)
          return { documents: ser([{ insertedId: r.insertedId }]), truncated: false, affected: 1 }
        }
        case 'insertMany': {
          const r = await col.insertMany((cmd.documents ?? []) as any[])
          return { documents: [], truncated: false, affected: r.insertedCount }
        }
        case 'updateOne':
        case 'updateMany': {
          if (!cmd.update) throw new HttpError(400, 'update wajib diisi')
          const r = await col[cmd.operation](cmd.filter ?? {}, cmd.update as any)
          return { documents: [{ matched: r.matchedCount, modified: r.modifiedCount }], truncated: false, affected: r.modifiedCount }
        }
        case 'deleteOne':
        case 'deleteMany': {
          const r = await col[cmd.operation](cmd.filter ?? {})
          return { documents: [], truncated: false, affected: r.deletedCount }
        }
        case 'drop':
          await col.drop()
          return { documents: [], truncated: false, affected: null }
        default:
          throw new HttpError(400, `operasi tidak dikenal: ${(cmd as any).operation}`)
      }
    })
  }

  return {
    async run(actor: Actor, row: DatabaseRow, input: { query?: string; mongo?: MongoCommand; confirm?: string }, ip: string | null) {
      const isMongo = row.engine === 'mongo'
      const text = isMongo ? JSON.stringify(input.mongo ?? null) : String(input.query ?? '')
      if (isMongo ? !input.mongo?.operation : !text.trim()) throw new HttpError(400, isMongo ? 'operation wajib diisi' : 'query kosong')
      if (text.length > MAX_QUERY_CHARS) throw new HttpError(400, `query terlalu panjang (maks ${MAX_QUERY_CHARS} karakter)`)

      const destructive = isMongo ? isDestructiveMongo(input.mongo!) : isDestructiveSql(text)
      if (destructive && input.confirm !== row.name)
        throw new HttpError(409, `perintah ini destruktif; ketik ulang nama database "${row.name}" untuk melanjutkan`, { needsConfirmation: true })

      const t0 = performance.now()
      try {
        const result = isMongo ? await runMongo(row, input.mongo!) : await runSql(row, text)
        const durationMs = Math.round(performance.now() - t0)
        const rows = 'rows' in result ? result.rows.length : result.documents.length
        audit.log({ actor, action: 'console.query', target: `database:${row.id}`, projectId: row.project_id, result: 'ok', ip,
          detail: { query: text.slice(0, AUDIT_QUERY_CHARS), durationMs, rows, affected: result.affected, destructive } })
        return { ...result, durationMs }
      } catch (e: any) {
        if (e instanceof HttpError) throw e
        const durationMs = Math.round(performance.now() - t0)
        audit.log({ actor, action: 'console.query', target: `database:${row.id}`, projectId: row.project_id, result: 'error', ip,
          detail: { query: text.slice(0, AUDIT_QUERY_CHARS), durationMs, error: e.message } })
        // Error query milik tenant sendiri (sintaks, izin, timeout) → 400 dengan pesan engine
        throw new HttpError(400, String(e.message).split('\n')[0], { durationMs })
      }
    },

    // FR-19: tabel/koleksi, kolom, ukuran, perkiraan jumlah baris
    async schema(row: DatabaseRow) {
      try {
        if (row.engine === 'postgres') {
          return await withPg(row, async s => {
            const tables = await s`SELECT n.nspname AS schema, c.relname AS name,
                CASE c.relkind WHEN 'r' THEN 'table' WHEN 'p' THEN 'table' WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view' END AS type,
                NULLIF(c.reltuples, -1)::bigint AS approx_rows, pg_total_relation_size(c.oid)::bigint AS size_bytes
              FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE c.relkind IN ('r', 'p', 'v', 'm') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'
              ORDER BY 1, 2`
            const cols = await s`SELECT table_schema AS schema, table_name AS table, column_name AS name, data_type AS type, is_nullable = 'YES' AS nullable
              FROM information_schema.columns WHERE table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY table_schema, table_name, ordinal_position`
            return tables.map(t => ({
              ...jsonable(t) as object,
              columns: cols.filter(c => c.schema === t.schema && c.table === t.name).map(c => ({ name: c.name, type: c.type, nullable: c.nullable })),
            }))
          })
        }
        if (row.engine === 'mariadb') {
          return await withMy(row, async c => {
            const [tables] = await c.query({ sql: `SELECT table_name, IF(table_type = 'VIEW', 'view', 'table'), table_rows, data_length + index_length
              FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY 1`, rowsAsArray: true })
            const [cols] = await c.query({ sql: `SELECT table_name, column_name, column_type, is_nullable = 'YES'
              FROM information_schema.columns WHERE table_schema = DATABASE() ORDER BY table_name, ordinal_position`, rowsAsArray: true })
            return (tables as any[][]).map(([name, type, approx, size]) => ({
              schema: row.physical_name, name, type, approx_rows: approx === null ? null : String(approx), size_bytes: size === null ? null : String(size),
              columns: (cols as any[][]).filter(x => x[0] === name).map(x => ({ name: x[1], type: x[2], nullable: !!Number(x[3]) })),
            }))
          })
        }
        return await withMongo(row, async client => {
          const d = client.db(row.physical_name)
          const out = []
          for (const { name, type } of await d.listCollections({}, { nameOnly: false }).toArray()) {
            if (name.startsWith('system.')) continue
            const col = d.collection(name)
            const [stats] = await col.aggregate([{ $collStats: { storageStats: {} } }]).toArray().catch(() => [null])
            const sample = await col.findOne({}, { maxTimeMS: 5000 }).catch(() => null)
            out.push({
              schema: row.physical_name, name, type: type === 'view' ? 'view' : 'collection',
              approx_rows: String(await col.estimatedDocumentCount().catch(() => 0)),
              size_bytes: stats ? String((stats.storageStats?.storageSize ?? 0) + (stats.storageStats?.totalIndexSize ?? 0)) : null,
              // Mongo tanpa skema: kolom diambil dari satu dokumen contoh
              columns: sample ? Object.entries(sample).map(([k, v]) => ({
                name: k, type: v === null ? 'null' : Array.isArray(v) ? 'array' : (v as any)?._bsontype ?? typeof v, nullable: true,
              })) : [],
            })
          }
          return out
        })
      } catch (e: any) {
        throw new HttpError(400, `gagal membaca skema: ${String(e.message).split('\n')[0]}`)
      }
    },
  }
}
export type ConsoleService = ReturnType<typeof createConsoleService>
