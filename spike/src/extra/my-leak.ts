// Repro: buka 20 koneksi tenant + 1 yang ditolak, tutup semua, ulangi; hitung sesi sisa di server
import { myConnect, driver } from '../mydriver.ts'
const ROOT = process.env.MARIADB_ROOT_URL!
const root = await myConnect(ROOT)
await root.query(`DROP USER IF EXISTS 'leak_u'@'%'`)
await root.query(`CREATE USER 'leak_u'@'%' IDENTIFIED BY 'x' WITH MAX_USER_CONNECTIONS 20`)
let leaks = 0
for (let round = 0; round < 40; round++) {
  const conns = []
  for (let i = 0; i < 20; i++) conns.push(await myConnect(ROOT, { user: 'leak_u', password: 'x' }))
  await myConnect(ROOT, { user: 'leak_u', password: 'x' }).then(c => conns.push(c), () => {})
  await Promise.all(conns.map(c => c.end()))
  await new Promise(r => setTimeout(r, 100))
  const [r] = await root.query(`SELECT count(*) AS n FROM information_schema.processlist WHERE user='leak_u'`)
  if (Number(r.n) > 0) { leaks++; console.log(`round ${round}: ${r.n} sesi sisa`); await root.query(`DROP USER 'leak_u'@'%'`); await root.query(`CREATE USER 'leak_u'@'%' IDENTIFIED BY 'x' WITH MAX_USER_CONNECTIONS 20`) }
}
await root.query(`DROP USER IF EXISTS 'leak_u'@'%'`)
await root.end()
console.log(`${driver} ${typeof Bun !== 'undefined' ? 'bun' : 'node'}: ${leaks}/40 ronde bocor`)
