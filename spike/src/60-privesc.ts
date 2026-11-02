// Tambahan: apakah akun dbaas_admin "hak minimum" bisa menaikkan haknya sendiri / mengambil alih akun lain?
// PASS = eskalasi DITOLAK. Jalankan setelah 00-setup (MariaDB sebaiknya mode narrow-plus).
import postgres from 'postgres'
import { MongoClient } from 'mongodb'
import { check, expectReject, saveResults, env } from './lib.ts'
import { myConnect } from './mydriver.ts'

const pgOpts = { max: 1, onnotice: () => {}, connect_timeout: 5 }
const pgRoot = postgres(env('PG_ROOT_URL'), pgOpts)
const pgAdmin = postgres(env('PG_ADMIN_URL'), pgOpts)
try {
  await pgRoot.unsafe(`DROP ROLE IF EXISTS victim_su`)
  await pgRoot.unsafe(`CREATE ROLE victim_su LOGIN SUPERUSER PASSWORD 'v'`)
  await check('ESC-PG-1', () => expectReject(() => pgAdmin.unsafe(`ALTER ROLE victim_su PASSWORD 'pwn'`), /permission denied/))
  await check('ESC-PG-2', () => expectReject(() => pgAdmin.unsafe(`CREATE ROLE x_su SUPERUSER`), /permission denied/))
  await check('ESC-PG-3', () => expectReject(() => pgAdmin.unsafe(`GRANT pg_read_all_data TO dbaas_admin`), /permission denied/))
  await check('ESC-PG-4', () => expectReject(() => pgAdmin.unsafe(`ALTER ROLE dbaas_admin SUPERUSER`), /permission denied/))
} finally {
  await pgRoot.unsafe(`DROP ROLE IF EXISTS victim_su`).catch(() => {})
  await pgRoot.unsafe(`DROP ROLE IF EXISTS x_su`).catch(() => {})
  await pgRoot.end(); await pgAdmin.end()
}

const myRoot = await myConnect(env('MARIADB_ROOT_URL'))
const myAdmin = await myConnect(env('MARIADB_ADMIN_URL'))
try {
  const [g] = await myAdmin.query(`SHOW GRANTS`)
  console.log('mariadb admin:', Object.values(g)[0])
  await myRoot.query(`DROP USER IF EXISTS 'victim_su'@'%'`)
  await myRoot.query(`CREATE USER 'victim_su'@'%' IDENTIFIED BY 'v'`)
  await myRoot.query(`GRANT ALL PRIVILEGES ON *.* TO 'victim_su'@'%' WITH GRANT OPTION`)
  // CREATE USER global di MariaDB juga mengizinkan ALTER USER untuk SEMUA akun
  await check('ESC-MY-1', () => expectReject(() => myAdmin.query(`ALTER USER 'victim_su'@'%' IDENTIFIED BY 'pwn'`), /denied/))
  await check('ESC-MY-2', () => expectReject(() => myAdmin.query(`GRANT SUPER ON *.* TO 'dbaas_admin'@'%'`), /denied/))
  await check('ESC-MY-3', () => expectReject(() => myAdmin.query(`DROP USER 'victim_su'@'%'`), /denied/))
} finally {
  await myRoot.query(`DROP USER IF EXISTS 'victim_su'@'%'`).catch(() => {})
  await myRoot.end(); await myAdmin.end()
}

const mgRoot = new MongoClient(env('MONGO_ROOT_URL'))
const mgAdmin = new MongoClient(env('MONGO_ADMIN_URL'))
try {
  // Jangan pernah sasar akun root asli: pakai korban dummy dengan role root
  try { await mgRoot.db('admin').command({ dropUser: 'victim_su' }) } catch {}
  await mgRoot.db('admin').command({ createUser: 'victim_su', pwd: 'v', roles: ['root'] })
  await check('ESC-MG-1', () => expectReject(
    () => mgAdmin.db('admin').command({ grantRolesToUser: 'dbaas_admin', roles: ['root'] }), /not authorized/))
  await check('ESC-MG-2', () => expectReject(
    () => mgAdmin.db('admin').command({ updateUser: 'victim_su', pwd: 'pwn' }), /not authorized/))
} finally {
  // kembalikan kalau eskalasi berhasil
  await mgRoot.db('admin').command({ revokeRolesFromUser: 'dbaas_admin', roles: ['root'] }).catch(() => {})
  await mgRoot.db('admin').command({ dropUser: 'victim_su' }).catch(() => {})
  await mgRoot.close(); await mgAdmin.close()
}
saveResults('60-privesc')
