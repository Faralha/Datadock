// GitLab palsu untuk mencoba UI tanpa GitLab lab (HANYA dev). Dipakai lewat compose.dev.yml.
import { startFakeGitlab } from '../test/fake-gitlab.ts'

const g = startFakeGitlab(process.env.GITLAB_BOT_TOKEN ?? 'dev-bot-token', Number(process.env.FAKE_GITLAB_PORT ?? 8929))
g.addUser(1, 'dev'); g.addUser(2, 'maintainer'); g.addUser(3, 'ops'); g.addUser(4, 'reporter')
g.addProject(1001, 'demo-org/sample-app'); g.addProject(1002, 'demo-org/sample-iot')
g.setMember(1001, 1, 30); g.setMember(1001, 2, 40); g.setMember(1001, 4, 20); g.setMember(1002, 2, 50)
g.addGroupMember('demo-org/admins', 3)
// Banyak project di beberapa grup, untuk mencoba sidebar terlipat, pencarian, dan pagination dashboard
const SAMPLE: Record<string, string[]> = {
  'demo-org/research': ['deteksi-banjir', 'klasifikasi-citra', 'nlp-sentimen', 'smart-farming', 'prediksi-cuaca'],
  'praktikum/basis-data': ['kelompok-01', 'kelompok-02', 'kelompok-03', 'kelompok-04', 'kelompok-05', 'kelompok-06'],
  'ta-2026': ['sistem-antrian', 'marketplace-umkm', 'e-voting', 'monitoring-server', 'aplikasi-kos', 'chatbot-akademik', 'absensi-wajah'],
}
let sampleId = 2001
for (const [group, names] of Object.entries(SAMPLE)) for (const name of names) {
  g.addProject(sampleId, `${group}/${name}`)
  g.setMember(sampleId++, 1, 30)
}
console.log(`GitLab palsu di ${g.url} — user: dev (Developer), maintainer, ops (admin), reporter`)
