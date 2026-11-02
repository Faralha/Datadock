// Apakah login gagal ke MariaDB membocorkan file descriptor / socket? Hitung /proc/self/fd sebelum dan sesudah
import { readdirSync } from 'node:fs'
import { myConnect, driver } from '../mydriver.ts'
const ROOT = process.env.MARIADB_ROOT_URL!
const fds = () => readdirSync('/proc/self/fd').length
const root = await myConnect(ROOT)
await root.query(`DROP USER IF EXISTS 'fd_u'@'%'`)
await root.query(`CREATE USER 'fd_u'@'%' IDENTIFIED BY 'lama' WITH MAX_USER_CONNECTIONS 20`)
await root.query(`ALTER USER 'fd_u'@'%' IDENTIFIED BY 'baru'`)
const f0 = fds()
for (let i = 0; i < 200; i++) await myConnect(ROOT, { user: 'fd_u', password: 'lama' }).catch(() => {})
await new Promise(r => setTimeout(r, 1000))
const f1 = fds()
for (let i = 0; i < 200; i++) { const c = await myConnect(ROOT, { user: 'fd_u', password: 'baru' }); await c.end() }
await new Promise(r => setTimeout(r, 1000))
const f2 = fds()
await root.query(`DROP USER 'fd_u'@'%'`)
await root.end()
console.log(`${driver} ${typeof Bun !== 'undefined' ? 'bun' : 'node'}: fd awal ${f0}, +200 login gagal ${f1}, +200 login sukses ${f2}`)
