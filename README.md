# DataDock

Platform **Database-as-a-Service** untuk Lab MCI. Anggota project GitLab lab bisa membuat database PostgreSQL, MariaDB, atau MongoDB sendiri dalam hitungan detik, tanpa menunggu admin.

Production: **https://db.iimlab.id**, login dengan akun GitLab lab.

## Fitur

- **Login GitLab.** Akses mengikuti role di project GitLab: Developer bisa membuat dan memakai database, Maintainer bisa juga menghapus dan merotasi password. Admin platform diatur lewat `ADMIN_USERNAMES` atau grup GitLab.
- **Database sekali klik** di instance PostgreSQL 18, MariaDB 12.2, dan MongoDB 8.0 milik server lab. Tiap database punya user sendiri dan terisolasi dari project lain.
- **Credential langsung ke pipeline.** Credential dipasang otomatis sebagai CI/CD variable project (`<NAMA>_DATABASE_URL`, `<NAMA>_DB_HOST`, `<NAMA>_DB_PASSWORD`, dll.) dengan scope environment GitLab. Diperbarui saat password dirotasi dan dihapus bersama database.
- **Console query dan penjelajah skema** di browser, dengan batas waktu, batas baris, dan konfirmasi untuk perintah destruktif.
- **Quota per project:** jumlah database, ukuran, dan koneksi. Database yang melewati quota otomatis jadi read-only atau diblokir, dan pulih sendiri setelah dikosongkan.
- **Backup harian** dengan `pg_dump`, `mariadb-dump`, dan `mongodump`, retensi 7 hari, plus backup akhir wajib sebelum database dihapus.
- **Audit log append-only** untuk semua aksi, termasuk akses yang ditolak.
- **Engine bisa dipilih:** `ENGINES=postgres` bila MariaDB dan MongoDB belum dipakai.

## Arsitektur

```
browser ── Cloudflare tunnel ── control plane (container) ── host.docker.internal ── PostgreSQL / MariaDB / MongoDB
                                  Bun + Elysia + SQLite                              (instance bare-metal di server)
                                  React web UI                    │
                                                                  └── GitLab (OAuth, anggota project, CI/CD variable)
```

- **Control plane:** satu container berisi API (Bun + Elysia), web UI (React + Vite + shadcn/ui), dan penjadwal job. Metadata di SQLite, password tenant dienkripsi AES-256-GCM.
- **Database:** pipeline tidak men-deploy engine. Control plane memakai akun `dbaas_admin` dengan hak minimum yang dibuat dari akun root sekali saat deploy.
- **Pemilihan Bun + Elysia** berdasarkan spike, lihat [spike/REPORT.md](spike/REPORT.md).

## Struktur repo

| Path | Isi |
|---|---|
| [control-plane/](control-plane/) | API, web UI (`web/`), test, Dockerfile. Detail fitur dan keputusan desain di [control-plane/README.md](control-plane/README.md). |
| [deploy.sh](deploy.sh), [.gitlab-ci.yml](.gitlab-ci.yml) | Pipeline CI/CD dan script deploy, diadaptasi dari template standar lab |
| [deploy/](deploy/) | Contoh env file production dan engine sementara untuk job test |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Cara deploy, CI/CD variable yang wajib, operasional, to-do infrastruktur |
| [compose.yml](compose.yml), [compose.dev.yml](compose.dev.yml) | Lingkungan pengembangan lokal |
| [spike/](spike/) | Spike Bun + Elysia dan laporannya |

## Menjalankan di lokal

Butuh Docker. Semua perintah dijalankan dari root repo.

```bash
cp .env.example .env
```

Isi semua password dan `ENCRYPTION_KEY` di `.env` (cara membuat kuncinya ada di file itu). Nyalakan engine, lalu buat akun admin hak minimum (cukup sekali):

```bash
docker compose up -d --wait postgres mariadb mongo
```

```bash
docker compose run --rm control-plane sh -c "bun install && bun run bootstrap"
```

Jalankan control plane dengan GitLab palsu, tanpa butuh GitLab lab:

```bash
docker compose -f compose.yml -f compose.dev.yml up -d
```

Buka http://localhost:3000, lalu pilih user di halaman login GitLab palsu: `dev` (Developer), `maintainer`, atau `ops` (admin platform).

## Test

Test berjalan terhadap engine asli (PostgreSQL, MariaDB, MongoDB dari `compose.yml`):

```bash
docker compose run --rm --no-deps control-plane bun run test
```

```bash
docker compose run --rm --no-deps control-plane bun run typecheck
```

Di CI, job `test` menyalakan engine sementara sendiri lewat `./deploy.sh test`.

## Deploy

Push ke `main` menjalankan test, lint, scan keamanan, dan build (SonarQube dimatikan, lihat `SONAR_ENABLED` di `.gitlab-ci.yml`). Deploy ke production dijalankan **manual** dari pipeline. Branch `dev_*` dan `staging` hanya menjalankan CI.

Sebelum deploy pertama, isi CI/CD variable `DATADOCK_ENV_FILE` dan `DATADOCK_ROOT_ENV_FILE` di GitLab. Daftar lengkap, isi minimum, dan pemecahan masalahnya ada di [DEPLOYMENT.md](DEPLOYMENT.md).

## Status

Fase 1 (layanan inti) dan fase 2 (CI/CD variable, console, skema) sudah berjalan. Yang belum dikerjakan, antara lain monitoring, restore dari UI, dan pengajuan quota, tercatat di [control-plane/README.md](control-plane/README.md#belum-dikerjakan). To-do infrastruktur ada di [DEPLOYMENT.md](DEPLOYMENT.md#to-do).
