# DataDock control plane

Backend fase 1 platform DBaaS Lab MCI (lihat dokumen "Draf Perancangan Platform DBaaS Lab MCI"). Dibangun di atas hasil spike di `../spike/REPORT.md`.

## Menjalankan

```bash
cp .env.example .env            # isi semua password, ENCRYPTION_KEY, dan kredensial GitLab
docker compose up -d --wait postgres mariadb mongo
docker compose run --rm control-plane sh -c "bun install && bun run bootstrap"   # sekali: buat akun admin hak minimum
docker compose up -d control-plane
docker compose run --rm --no-deps control-plane bun run test                    # test terhadap engine asli
docker compose run --rm --no-deps control-plane bun run typecheck
```

**Mencoba UI tanpa GitLab lab:** `docker compose -f compose.yml -f compose.dev.yml up -d`, lalu buka http://localhost:3000. Mode ini menjalankan GitLab palsu (`scripts/dev-gitlab.ts`) di port 8929. Di halaman login GitLab palsu, pilih user:

- `dev`: Developer
- `maintainer`: Maintainer
- `ops`: admin platform
- `reporter`: tanpa akses

Web UI (React + Vite + TanStack Query, `web/`) dibangun dengan `bun run build:web` dan disajikan control plane dari origin yang sama.

Control plane lokal berjalan di container image target `dev` (Bun + tool dump). Deploy ke server: lihat [DEPLOYMENT.md](../DEPLOYMENT.md).

## Yang sudah ada

| Kebutuhan | Implementasi |
|---|---|
| FR-01, FR-02 | `/auth/login` → GitLab OAuth2 + PKCE, sesi cookie httpOnly (hash di SQLite); admin dari `ADMIN_USERNAMES` atau `ADMIN_GROUP` |
| FR-03..05 | project dan role dari GitLab saat login; job `sync-memberships` tiap 15 menit dengan token bot |
| FR-06..08 | `POST /api/projects/:pid/databases`, idempoten, quota dicek dalam transaksi, login tenant diverifikasi, rollback bila gagal |
| FR-09 | `DELETE /api/databases/:id` (Maintainer, `confirm` = nama), backup akhir wajib sukses dulu |
| FR-11, FR-12 | password tersembunyi; `POST .../password/reveal` (diaudit), `POST .../password/rotate` (Maintainer) |
| FR-24 | quota jumlah saat create; job `enforce-quotas` tiap 5 menit → read-only / blocked dan pulih otomatis |
| FR-26 | job `backup-daily` 02.00 WIB dengan `pg_dump` 18 / `mariadb-dump` 12.2 / `mongodump` dari image control plane, retensi 7 hari (`backup-expire`), status di `GET .../backups` |
| FR-28, NFR-12 | `audit_events` append-only (trigger menolak UPDATE/DELETE), termasuk akses yang ditolak |
| NFR-01 | test isolasi per engine (`test/engines.test.ts`) |
| NFR-03 | AES-256-GCM, kunci dari env |
| NFR-04 | `src/bootstrap.ts`: PG CREATEDB CREATEROLE; MariaDB daftar hak minimum hasil spike + CONNECTION ADMIN |
| NFR-06, NFR-16 | Web UI: login, project, buat database (formulir langsung tampil saat project kosong), koneksi, console, tabel, backup, pengaturan, admin (quota, audit, job); header CSP/nosniff/frame-deny |
| FR-13..15 | CI/CD variable `<NAMA>_DATABASE_URL`, `<NAMA>_DB_HOST/PORT/NAME/USER/PASSWORD`, scope = environment. URL dan password di-mask. Diperbarui saat rotasi, dihapus bersama database, dicoba ulang tiap 15 menit bila GitLab gagal. Karena itu nama database unik per environment lintas engine. |
| FR-16..18, FR-29 | `POST /api/databases/:id/console` dengan user project. Timeout 30 detik per sesi, maks 1.000 baris (cursor PG, `sql_select_limit` MariaDB), satu perintah per eksekusi. Perintah destruktif butuh ketik ulang nama. Semua query diaudit. MongoDB memakai perintah JSON (EJSON). |
| FR-19 | `GET /api/databases/:id/schema`: tabel/koleksi, kolom, perkiraan baris, ukuran |

## Beda dari dokumen desain (keputusan dari spike)

- **Bun + Elysia + SQLite** (`bun:sqlite`) menggantikan NestJS + PostgreSQL metadata + pg-boss. Job berjalan di penjadwal in-process (`src/scheduler.ts`) yang mencatat jadwal di `job_runs`.
- **MariaDB 12.2.2** (bukan MySQL 8.4) dan **PostgreSQL 18.3** (bukan 17), mengikuti server produksi. Batas waktu query MariaDB memakai `MAX_STATEMENT_TIME`, bukan `max_execution_time`. Dump memakai `mariadb-dump` karena `mysqldump` tidak ada di image.
- **`mongodb@6.21.0` dipin**: versi 7 gagal di-load di Bun.
- **Read-only karena quota:**
  - PostgreSQL: `default_transaction_read_only` bisa di-bypass tenant, jadi di atas `PG_HARD_BLOCK_PERCENT` (default 120%) koneksi tenant diblokir total.
  - MariaDB: hanya hak yang menambah data yang dicabut. DELETE/DROP tetap boleh supaya tenant bisa turun di bawah quota. Setelah itu sesi lama diputus.
  - Mongo: `readWrite` dan `dbAdmin` diganti `read`.
- **Batas yang hanya default:** `statement_timeout` (PG) dan `max_statement_time` (MariaDB) bisa ditimpa tenant per sesi. Penegakan keras butuh pemantauan + cancel, yang belum ada.
- **Akun admin MariaDB dan Mongo de facto setara root** (spike ESC-MY/ESC-MG). Simpan kredensialnya seperti root.

## Belum dikerjakan

- PgBouncer + `auth_query`
- Monitoring/log (FR-21..23, fase 2): butuh VictoriaMetrics, exporter, dan Vector/VictoriaLogs di compose
- Ekspor hasil console ke CSV/JSON (FR-20, fase 3)
- Restore dan uji restore mingguan (fase 3)
- Pengajuan quota (fase 3)
- Notifikasi ke Maintainer saat quota penuh: saat ini hanya status database + audit log
- Perubahan `max_connections` di quota hanya berlaku untuk database baru
