// Alur create/drop DB + user per engine (versi ringkas dari test 1–3), dipakai 40-docker-exec dan 50-elysia
import type { Sql } from 'postgres'
import postgres from 'postgres'
import type { Pool } from 'mysql2/promise'
import type { MongoClient } from 'mongodb'

const IDENT = /^[a-z][a-z0-9_]{2,40}$/
function ident(name: string) {
  if (!IDENT.test(name)) throw new Error(`nama tidak valid: ${name}`)
  return name
}
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`

export async function pgProvision(admin: Sql, adminUrl: string, name: string, pass: string) {
  const db = ident(name), user = ident(`${name}_u`)
  await admin.unsafe(`CREATE ROLE ${user} LOGIN PASSWORD ${lit(pass)} CONNECTION LIMIT 20`)
  await admin.unsafe(`CREATE DATABASE ${db} OWNER ${user}`)
  await admin.unsafe(`REVOKE CONNECT, TEMPORARY ON DATABASE ${db} FROM PUBLIC`)
  await admin.unsafe(`GRANT CONNECT ON DATABASE ${db} TO ${user}`)
  await admin.unsafe(`ALTER DATABASE ${db} SET statement_timeout = '30s'`)
  const u = new URL(adminUrl); u.pathname = '/' + db
  const inDb = postgres(u.toString(), { max: 1, onnotice: () => {} })
  try {
    await inDb.unsafe(`REVOKE ALL ON SCHEMA public FROM PUBLIC`)
    await inDb.unsafe(`GRANT ALL ON SCHEMA public TO ${user}`)
  } finally {
    await inDb.end()
  }
  return { database: db, user }
}

export async function pgDeprovision(admin: Sql, name: string) {
  const db = ident(name), user = ident(`${name}_u`)
  await admin.unsafe(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`)
  await admin.unsafe(`DROP ROLE IF EXISTS ${user}`)
}

export async function myProvision(admin: Pool, name: string, pass: string) {
  const db = ident(name), user = ident(`${name}_u`)
  await admin.query(`CREATE DATABASE \`${db}\``)
  await admin.query(`CREATE USER '${user}'@'%' IDENTIFIED BY ${lit(pass)} WITH MAX_USER_CONNECTIONS 20 MAX_STATEMENT_TIME 30`)
  await admin.query(`GRANT ALL PRIVILEGES ON \`${db}\`.* TO '${user}'@'%'`)
  return { database: db, user }
}

export async function myDeprovision(admin: Pool, name: string) {
  const db = ident(name), user = ident(`${name}_u`)
  await admin.query(`DROP DATABASE IF EXISTS \`${db}\``)
  await admin.query(`DROP USER IF EXISTS '${user}'@'%'`)
}

export async function mgProvision(admin: MongoClient, name: string, pass: string) {
  const db = ident(name), user = ident(`${name}_u`)
  await admin.db(db).command({
    createUser: user, pwd: pass,
    roles: [{ role: 'readWrite', db }, { role: 'dbAdmin', db }],
  })
  return { database: db, user }
}

export async function mgDeprovision(admin: MongoClient, name: string) {
  const db = ident(name), user = ident(`${name}_u`)
  try { await admin.db(db).command({ dropUser: user }) } catch (e: any) { if (e?.codeName !== 'UserNotFound') throw e }
  await admin.db(db).dropDatabase()
}
