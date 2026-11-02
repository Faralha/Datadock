// Repro MY-12 di driver mariadb: login gagal (password salah) untuk user non-root
import { myConnect } from '../mydriver.ts'
const ROOT = process.env.MARIADB_ROOT_URL!
const root = await myConnect(ROOT)
await root.query(`DROP USER IF EXISTS 'rot_u'@'%'`)
await root.query(`CREATE USER 'rot_u'@'%' IDENTIFIED BY 'lama'`)
if (process.env.ALTER) await root.query(`ALTER USER 'rot_u'@'%' IDENTIFIED BY 'baru'`)
await myConnect(ROOT, { user: 'rot_u', password: process.env.ALTER ? 'lama' : 'salah' }).catch(e => console.log('rejected', e.code))
if (process.env.OKAFTER) { const k = await myConnect(ROOT, { user: 'rot_u', password: 'baru' }); await k.query('SELECT 1'); await k.end() }
await root.query(`DROP USER 'rot_u'@'%'`)
await root.end()
console.log('selesai')
