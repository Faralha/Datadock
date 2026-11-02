// Buat akun dbaas_admin hak minimum di ketiga engine, memakai akun root. Idempoten.
// MARIADB_ADMIN_MODE=narrow → pakai grant sempit (untuk uji apakah test MY masih lolos)
import postgres from 'postgres'
import mysql from 'mysql2/promise'
import { MongoClient } from 'mongodb'
import { env } from './lib.ts'

const mode = process.env.MARIADB_ADMIN_MODE ?? 'full'

const pg = postgres(env('PG_ROOT_URL'), { onnotice: () => {} })
await pg.unsafe(`DROP ROLE IF EXISTS dbaas_admin`)
await pg.unsafe(`CREATE ROLE dbaas_admin LOGIN PASSWORD 'adminpass' CREATEDB CREATEROLE`)
await pg.unsafe(`ALTER ROLE dbaas_admin SET createrole_self_grant = 'set, inherit'`)
await pg.end()
console.log('postgres: dbaas_admin dibuat (CREATEDB CREATEROLE, bukan superuser)')

const my = await mysql.createConnection(env('MARIADB_ROOT_URL'))
await my.query(`DROP USER IF EXISTS 'dbaas_admin'@'%'`)
await my.query(`CREATE USER 'dbaas_admin'@'%' IDENTIFIED BY 'adminpass'`)
if (mode === 'narrow') {
  await my.query(`GRANT CREATE, DROP, CREATE USER, RELOAD, PROCESS, SELECT ON *.* TO 'dbaas_admin'@'%' WITH GRANT OPTION`)
} else if (mode === 'narrow-plus') {
  // Sempit + hak data yang harus bisa diteruskan ke tenant (GRANT ALL ON db.* butuh admin memegang semuanya)
  await my.query(`GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, INDEX, ALTER, CREATE TEMPORARY TABLES,
    LOCK TABLES, EXECUTE, CREATE VIEW, SHOW VIEW, CREATE ROUTINE, ALTER ROUTINE, EVENT, TRIGGER, REFERENCES,
    DELETE HISTORY, SHOW CREATE ROUTINE, CREATE USER, RELOAD, PROCESS ON *.* TO 'dbaas_admin'@'%' WITH GRANT OPTION`)
} else {
  await my.query(`GRANT ALL PRIVILEGES ON *.* TO 'dbaas_admin'@'%' WITH GRANT OPTION`)
}
const [grants] = await my.query(`SHOW GRANTS FOR 'dbaas_admin'@'%'`)
await my.end()
console.log(`mariadb: dbaas_admin dibuat (mode ${mode})`, grants)

const mg = new MongoClient(env('MONGO_ROOT_URL'))
const admin = mg.db('admin')
try { await admin.command({ dropUser: 'dbaas_admin' }) } catch {}
await admin.command({
  createUser: 'dbaas_admin', pwd: 'adminpass',
  roles: ['userAdminAnyDatabase', 'dbAdminAnyDatabase', 'readWriteAnyDatabase', 'clusterMonitor'],
})
await mg.close()
console.log('mongo: dbaas_admin dibuat')
