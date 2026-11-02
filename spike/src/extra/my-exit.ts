// Bisect: kasus mana yang membuat proses tidak exit? CASE=badpass|baddb|timeout|ok
import { myConnect } from '../mydriver.ts'
const ROOT = process.env.MARIADB_ROOT_URL!
const c = process.env.CASE
if (c === 'badpass') await myConnect(ROOT, { password: 'salah' }).catch(e => console.log('rejected', e.code))
if (c === 'baddb') await myConnect(ROOT, { database: 'tidak_ada' }).catch(e => console.log('rejected', e.code))
if (c === 'timeout') {
  const k = await myConnect(ROOT)
  await k.query('SET SESSION max_statement_time=1')
  await k.query('SELECT SLEEP(3)').catch(e => console.log('rejected', e.code))
  await k.end()
}
if (c === 'ok') { const k = await myConnect(ROOT); await k.query('SELECT 1'); await k.end() }
console.log('selesai', c)
