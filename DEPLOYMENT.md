# Deployment DataDock

DataDock memakai pipeline standar lab (template Standard CI/CD), tetapi **hanya dengan satu environment: production**.

| Branch | CI (test, lint, secret scan, SAST) | Deploy | URL |
|---|---|---|---|
| `dev_*` | ya | tidak | - |
| `staging` | ya | tidak | - |
| `main` | ya | **manual** ke production | `https://db.iimlab.id` (`PROD_SUBDOMAIN_OVERRIDE: 'db'` di `.gitlab-ci.yml`) |

Job yang tetap sama dengan template: Secret scan (TruffleHog), SAST (Semgrep, Trivy FS) dan DAST (ZAP, hanya production) dengan toggle `SECURITY_SCAN_ENABLED`, SonarQube (dimatikan, toggle `SONAR_ENABLED`), scan image dengan Trivy, port 3001–3050, dan Cloudflare tunnel.

Deploy dev dan staging dimatikan. `deploy.sh`, `cleanup.sh` dan `TENANT_PREFIX` masih mendukungnya, jadi bisa dinyalakan lagi dengan mengembalikan job `deploy_dev`/`deploy_stage`/`cleanup_dev_env` dari riwayat git.

## Model: instance database bare-metal yang sudah ada

PostgreSQL, MariaDB dan MongoDB **sudah terpasang langsung di server** (bukan container), dan DataDock mendapat akun root/superuser-nya. Pipeline hanya men-deploy **control plane** sebagai container. Engine database tidak pernah di-deploy, di-restart, atau di-upgrade oleh pipeline.

```
                    server (bare-metal)
 ┌──────────────────────────────────────────────────────────────┐
 │  PostgreSQL :5432   MariaDB :3306   MongoDB :27017  (host)    │
 │        ▲                  ▲                ▲                  │
 │        └── host.docker.internal (host-gateway) ──┐            │
 │                                                  │            │
 │  container <env>_datadock  ── <env>_network ── cloudflared ───┼── https://<sub>.iimlab.id
 │   /data    → /opt/environments/<env>/data/<container>         │
 │   /backups → BACKUP_HOST_DIR/<container>                      │
 └──────────────────────────────────────────────────────────────┘
 aplikasi tenant → PUBLIC_*_HOST:port (alamat server)
```

## Yang berbeda dari template, dan alasannya

1. **Engine tidak di-deploy**
   - Control plane menjangkau instance di server lewat `host.docker.internal`; `deploy.sh` menambahkan `host-gateway`. Host dan port diatur di env file (`PG_HOST`, `PG_PORT`, dst.).
   - Aplikasi tenant memakai alamat publik server (`PUBLIC_*_HOST`), yang ditampilkan di UI dan CI variable.
2. **Akun admin hak minimum diselaraskan dengan akun root instance** (NFR-04)
   - Bila CI/CD variable `DATADOCK_ROOT_ENV_FILE` diisi, `bootstrap.ts` dijalankan di container sekali pakai untuk membuat atau menyelaraskan `dbaas_admin` di setiap instance yang diaktifkan (`ENGINES`).
   - File root dibaca langsung dari workspace job: **tidak disalin ke server** dan tidak pernah masuk ke container control plane.
   - Bila variable itu kosong, bootstrap dilewati dan akun admin dianggap sudah ada.
3. **Backup dengan tool klien di image control plane**
   - Dulu backup memakai `docker exec` ke container engine. Instance bare-metal tidak punya container, jadi image control plane kini membawa `pg_dump` 18, `mariadb-dump` 12.2 (dari repo resmi MariaDB) dan MongoDB Database Tools 100.14.
   - Versinya disamakan dengan server. Dump dijalankan lewat jaringan dengan akun admin, dengan password dikirim lewat environment, bukan argumen perintah.
   - File ditulis ke `BACKUP_HOST_DIR/<container>` di host. Control plane tidak lagi butuh Docker socket.
4. **Metadata SQLite di host**
   - Disimpan di `./data/<container>:/data`. Sebelum setiap deploy, metadata di-snapshot ke `data/<container>/predeploy/`; 5 snapshot terakhir disimpan.
   - Container berjalan sebagai user `bun` (uid 1000), bukan root.
5. **Rahasia tidak ditulis di `docker-compose.yml` bersama**
   - File compose itu dipakai banyak project. Konfigurasi control plane ada di env file `chmod 600` yang disalin dari CI/CD variable bertipe File.
   - Kalau env file tidak ada, deploy berhenti. Template membuat file kosong, tapi DataDock tidak bisa jalan tanpa konfigurasi.
6. **Hanya production yang di-deploy**
   - Build, deploy, DAST dan `cleanup_images` hanya berjalan di `main`. Branch lain hanya menjalankan CI.
   - Dukungan dev/staging di `deploy.sh` tetap ada (prefiks nama database `TENANT_PREFIX`, `CI_VARIABLES_ENABLED=false`, `cleanup.sh`) bila suatu saat dinyalakan lagi.
7. **Test terhadap engine asli**
   - Job `test` berjalan di runner `build`. Job ini menyalakan engine sementara dengan versi yang sama dengan server ([deploy/test-engines.compose.yml](deploy/test-engines.compose.yml), container hanya untuk test), menjalankan 72 test, lalu menghapus semuanya di `after_script`.
   - **Tidak membuat network Docker baru.** Engine test dan container test memakai network `bridge` bawaan Docker; `deploy.sh` membaca IP tiap engine dengan `docker inspect` karena network bawaan tidak punya DNS nama container. Tanpa port host, password root acak per pipeline.
   - Konsekuensinya, selama test berjalan (beberapa menit) engine test bisa dijangkau container lain di `bridge` bawaan pada daemon yang sama. Job ini butuh komunikasi antar-container di `bridge` (`icc`, default Docker: aktif).
   - Coverage LCOV disiapkan untuk SonarQube.
8. **Lint diganti typecheck**
   - Template memakai ESLint. DataDock memakai TypeScript strict (`bun run typecheck`) untuk server, web UI dan test.
9. **Image lama tidak dihapus saat build**
   - Template menghapus semua image project saat build. DataDock menyimpannya supaya rollback ke tag sebelumnya tetap mungkin. Pembersihan dilakukan lewat job `cleanup_images`.
10. **Satu deploy per environment pada satu waktu** (`resource_group`).

## Prasyarat

### CI/CD variable yang wajib diisi di GitLab

Di **Settings → CI/CD → Variables**. Scope environment untuk file konfigurasi: `production` (atau `*`).

| Variable | Tipe | Scope | Wajib? | Isi |
|---|---|---|---|---|
| `SONAR_HOST_URL`, `SONAR_TOKEN` | Variable, Masked (token) | semua (`*`) | hanya bila `SONAR_ENABLED=true` (default mati) | dari tim DevOps, sama dengan template |
| `PROD_TUNNEL_ID` | Variable, Protected | semua (`*`) | **wajib** untuk deploy production | dari tim DevOps |
| `DATADOCK_ENV_FILE` | **File**, Protected | `production` | **wajib** (kecuali env file sudah ada di server) | konfigurasi control plane, lihat [deploy/app.env.example](deploy/app.env.example) |
| `DATADOCK_ROOT_ENV_FILE` | **File**, Protected | `production` | wajib pada deploy pertama, opsional sesudahnya | URL root tiap engine di `ENGINES` untuk membuat `dbaas_admin`, lihat [deploy/root.env.example](deploy/root.env.example) |
| `SECURITY_SCAN_ENABLED` | Variable | semua | opsional | `true` untuk menyalakan Semgrep, Trivy FS dan ZAP (default `false`) |

**Protected.** Variable Protected hanya diberikan ke job di branch protected. Pastikan `main` protected, lalu tandai Protected semua variable deploy, terutama `DATADOCK_ROOT_ENV_FILE` dan `GITLAB_BOT_TOKEN` di dalam `DATADOCK_ENV_FILE`.

**Masked.** Variable bertipe File tidak bisa di-mask oleh GitLab. Isinya tidak dicetak oleh `deploy.sh`, tapi akses ke pengaturan CI/CD project harus dibatasi ke Maintainer.

**Isi minimum `DATADOCK_ENV_FILE`** (control plane gagal start tanpa ini):

- `ENCRYPTION_KEY`: 32 byte base64 (`openssl rand -base64 32`). Buat sekali dan **jangan pernah diganti**.
- `GITLAB_URL`, `GITLAB_CLIENT_ID`, `GITLAB_CLIENT_SECRET`: OAuth application di GitLab lab.
- `GITLAB_BOT_TOKEN`: scope `api` pada group lab.
- `ENGINES`: engine yang dipakai, mis. `postgres` saja (default `postgres,mariadb,mongo`). Engine yang tidak disebut tidak butuh host, password admin, maupun root URL, dan tidak ditawarkan di UI. Menambah engine nanti cukup dengan menambah namanya, password admin dan root URL-nya, lalu deploy ulang.
- `PG_ADMIN_PASSWORD`, `MARIADB_ADMIN_PASSWORD`, `MONGO_ADMIN_PASSWORD`: password `dbaas_admin`, hanya untuk engine di `ENGINES`. Dibuat atau diselaraskan oleh bootstrap.
- `PG_HOST`/`PG_PORT`, `MARIADB_HOST`/`MARIADB_PORT`, `MONGO_HOST`/`MONGO_PORT`: default `host.docker.internal` dan port standar.
- `PUBLIC_*_HOST`: alamat server yang dipakai aplikasi tenant.
- `ADMIN_USERNAMES` dan/atau `ADMIN_GROUP`: admin platform (FR-02).

Nilai lain punya default; lihat contoh. `PUBLIC_URL`, `TENANT_PREFIX` dan `CI_VARIABLES_ENABLED` diatur `deploy.sh`, jangan diisi.

### GitLab OAuth application

Redirect URI: `https://db.iimlab.id/auth/callback`

### Server

- **Instance database** harus menerima koneksi dari container Docker, bukan hanya dari localhost:
  - PostgreSQL: `listen_addresses` dan `pg_hba.conf` untuk subnet Docker.
  - MariaDB: `bind-address`.
  - MongoDB: `net.bindIp`.
- **Aplikasi tenant** harus bisa menjangkau port instance di `PUBLIC_*_HOST`. Jangan pakai `db.iimlab.id`: nama itu milik web UI dan lewat Cloudflare tunnel, yang hanya meneruskan HTTP.

## Operasional

- **Rollback**
  - Di server, ganti tag `image:` service `prod_datadock` (container production tetap bernama `prod_datadock`; subdomain tidak mengubah nama container) di `/opt/environments/prod/docker-compose.yml` ke tag sebelumnya, lalu `docker compose up -d prod_datadock`.
  - Bila migrasi metadata perlu dibatalkan, pulihkan snapshot dari `data/prod_datadock/predeploy/` saat container berhenti.
- **Upgrade versi engine di server** dilakukan tim DevOps di luar pipeline. Setelah itu, sesuaikan versi tool klien di [control-plane/Dockerfile](control-plane/Dockerfile) (`PG_MAJOR`, `MARIADB_SERIES`) dan image di `deploy/test-engines.compose.yml`, lalu deploy ulang. `pg_dump` harus berversi major yang sama atau lebih baru dari server.
- **`ENCRYPTION_KEY` tidak boleh hilang atau diganti.** Tanpa kunci itu, semua password database yang tersimpan tidak bisa dibaca.

## Keputusan infrastruktur (27 Okt 2026)

| Pertanyaan | Keputusan | Dampak |
|---|---|---|
| Engine database | Instance bare-metal yang sudah ada, dengan akun root | Pipeline tidak men-deploy engine. Backup memakai tool klien di image control plane; Docker socket tidak dibutuhkan. |
| Server | Berbagi `/opt/environments` dengan project lain | Sesuai rancangan `deploy.sh`. |
| Runner `build` dan `deploy` | Memakai Docker daemon yang sama | Tidak perlu registry; image hasil build langsung dipakai deploy, seperti template. |
| Lokasi backup | Ditunda | `BACKUP_HOST_DIR` sudah bisa diarahkan ke disk lain. Lihat to-do. |

## To-do

- [ ] **Lokasi backup.** Arahkan `BACKUP_HOST_DIR` ke disk terpisah dari data database, lalu tambahkan salinan ke lokasi kedua (MinIO/NAS lab, storage kampus, atau S3). Dokumen desain mewajibkan keduanya dan menyebut lokasi kedua sebagai pertanyaan terbuka.
- [ ] **Akses jaringan instance database.** Konfirmasi dengan tim DevOps:
  - Konfigurasi bind/`pg_hba` supaya container control plane (lewat `host-gateway`) dan aplikasi tenant bisa konek.
  - Allowlist firewall port database (NFR-02).
  - Nilai `PUBLIC_*_HOST` yang dipakai aplikasi.
- [ ] **Verifikasi versi instance di server.** Image control plane mengasumsikan PostgreSQL 18, MariaDB 12.2 dan MongoDB 8.0 (dari spike). Cek versi sebenarnya (`SELECT version()`, `db.version()`), terutama MongoDB yang di handoff spike masih tertulis "sesuaikan dengan server".
- [ ] **Akses database dari job GitLab CI.** Job yang memakai credential DataDock, mis. migrasi di pipeline project lain, harus bisa menjangkau `PUBLIC_*_HOST` dari runner.
- [ ] **Konfirmasi `icc` di Docker daemon runner `build`.** Job test butuh komunikasi antar-container di network `bridge` bawaan. Bila tim DevOps mematikannya (`"icc": false` di `daemon.json`), job test gagal.
- [ ] **Uji pipeline pertama di runner asli.** Job test dan deploy baru diuji di simulasi lokal: Docker Desktop dengan database di port host sebagai pengganti bare-metal, tunnel palsu, tanpa SonarQube.
