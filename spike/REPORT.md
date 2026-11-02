# Laporan Spike Bun + Elysia

Tanggal: 2026-10-27. Semua angka di bawah berasal dari run nyata; bukti mentah per test ada di `results/*.json`.

## Lingkungan

- **Host:** Windows 11 dengan Docker Desktop (backend WSL2)
- **Docker:** Engine 26.1.4, API 1.45, Compose v2.27.1
- **Runtime spike:** Bun **1.3.14** (Linux x64 baseline) di container `oven/bun:1.3-debian` (Debian 13), dengan `/var/run/docker.sock` di-mount. Lihat Masalah #3 untuk alasannya. Bun di host (1.1.44) tidak dipakai.
- **Runtime pembanding:** Node 24.22.1 (`node:24-slim`), dipakai untuk memastikan apakah sebuah kegagalan memang khas Bun.
- **Paket:** elysia 1.4.30, postgres 3.4.9, mysql2 3.24.6, mariadb 3.5.4, mongodb **6.21.0** (7.7.0 tidak bisa di-load di Bun tanpa shim, lihat Masalah #1)
- **Engine:** PostgreSQL 18.3 (Debian 18.3-1.pgdg13+1), MariaDB 12.2.2-MariaDB-ubu2404 (`mariadb:12.2.2-noble` tersedia), MongoDB 8.0.34

## Hasil

Akun admin: PG `dbaas_admin` (CREATEDB CREATEROLE, bukan superuser), MariaDB `GRANT ALL ON *.*` kecuali disebut lain, Mongo sesuai handoff. ID berakhiran huruf (mis. PG-8b) adalah pemeriksaan tambahan di luar matriks.

| ID | Status | Catatan |
|----|--------|---------|
| PG-1 | PASS | `current_user=dbaas_admin`, `rolsuper=false` |
| PG-2 | PASS | |
| PG-3 | PASS | `CREATE DATABASE ... OWNER` tanpa superuser (berkat `createrole_self_grant`) |
| PG-4 | PASS | |
| PG-5 | PASS | |
| PG-6 | PASS | tenant melihat `statement_timeout=30s` |
| PG-7 | PASS | |
| PG-8 | PASS | `permission denied for database "p2_dev_app"` |
| PG-8b | catatan | tenant **bisa** konek ke DB `postgres` (CONNECT default ke PUBLIC) dan melihat nama semua DB di `pg_database`; CREATE di sana ditolak |
| PG-9 | PASS | 100 baris |
| PG-10 | PASS | dibatalkan tepat 30,0 s (`canceling statement due to statement timeout`) |
| PG-10b | catatan | tenant bisa `SET statement_timeout = 0`, jadi batas ini hanya default |
| PG-11 | PASS | ~7,9 MB |
| PG-12 | PASS | `cannot execute INSERT in a read-only transaction` |
| PG-12b | catatan | **BYPASS:** tenant `SET default_transaction_read_only = off` lalu INSERT berhasil |
| PG-12c | PASS | alternatif: `ALTER ROLE ... CONNECTION LIMIT 0` menolak koneksi baru (`too many connections for role`) |
| PG-13 | PASS | password lama ditolak, password baru berhasil |
| PG-14 | PASS | `DROP DATABASE ... WITH (FORCE)` memutus sesi tenant yang masih aktif, tanpa superuser |
| MY-1 | PASS | mysql2 konek tanpa masalah plugin (semua akun `mysql_native_password`) |
| MY-2 | PASS | |
| MY-3 | PASS | |
| MY-4 | PASS | |
| MY-5 | PASS | |
| MY-6 | PASS | `Access denied ... to database 'p2_dev_app'`; SELECT lintas DB ditolak; `SHOW DATABASES` hanya `information_schema,p1_dev_app` |
| MY-7 | PASS | |
| MY-8 | PASS | `ALTER USER ... WITH MAX_STATEMENT_TIME 30` → `SLEEP(35)` dihentikan di 30,0 s (error 1969). **Namun** tenant bisa `SET SESSION max_statement_time = 0` |
| MY-9 | PASS | koneksi ke-21: `has exceeded the 'max_user_connections' resource` |
| MY-10 | PASS | 16384 bytes |
| MY-11 | PASS | koneksi baru ditolak; **koneksi lama yang sudah terbuka MASIH bisa INSERT** |
| MY-12 | PASS | |
| MY-13 | PASS | |
| MY-* (driver `mariadb`) | PASS 13/13 | hasil sama dengan mysql2 |
| MY-* (admin sempit versi handoff) | FAIL 6/13 | `GRANT ALL ON p1_dev_app.*` ditolak, lihat Masalah #8 |
| MY-* (admin sempit + hak data) | PASS 13/13 | daftar hak di Kesimpulan |
| MG-1 | PASS | |
| MG-2 | PASS | |
| MG-3 | PASS | |
| MG-4 | PASS | 100 dokumen |
| MG-5 | PASS | `not authorized on p2_dev_app`; `listDatabases` (authorizedDatabases) hanya `p1_dev_app` |
| MG-6 | PASS | `$where: 'sleep(100) \|\| true'` diizinkan di 8.0 → `operation exceeded time limit` (MaxTimeMSExpired) |
| MG-7 | PASS | `dataSize`, `storageSize` terbaca |
| MG-8 | PASS | |
| MG-9 | PASS | insert ditolak, **langsung berlaku juga untuk koneksi lama**. Catatan: `dbAdmin` masih melekat, jadi tenant tetap bisa `createCollection` dan `createIndex` |
| MG-10 | PASS | |
| MG-11 | PASS | |
| DX-1 | PASS | Docker 26.1.4, API 1.45 via `fetch(..., { unix })` |
| DX-2 | PASS | exit 0, 4,97 MB (1.000 baris + 200.000 baris), ~1 s |
| DX-3 | PASS | `t` 1000=1000, `big` 200000=200000 |
| DX-4 | PASS | exit 0, 44 KB; `mysqldump` memang tidak ada di image |
| DX-5 | PASS | 1000=1000 |
| DX-6 | PASS | exit 0 |
| DX-7 | PASS | 1000=1000 |
| DX-8 | PASS | exit 1, stderr terbaca setelah demux (`database "tidak_ada" does not exist`) |
| DX-9 | PASS | stream + demux inkremental ke file: **4.966.648 bytes, sama persis** dengan DX-2 |
| EL-1 | PASS | 200, ketiga engine `up` |
| EL-2 | PASS | provision → tenant login + CREATE/INSERT → deprovision berhasil untuk ketiga engine |
| EL-3 | PASS | 2.000 req, 0 error (lihat Angka) |
| EL-4 | PASS | RSS naik saat load lalu turun saat idle, tidak naik terus |
| EL-5 | PASS | PID sama sebelum dan sesudah; `/health` 503 dengan `mariadb: connect ETIMEDOUT` selama mati, kembali 200 **2 s** setelah container start, tidak ada error di log |
| ESC-PG-1..4 | PASS | admin PG **tidak bisa** mengubah password superuser, membuat superuser, grant `pg_read_all_data`, atau menjadikan dirinya superuser |
| ESC-MY-1 | **FAIL** | admin MariaDB (versi penuh maupun sempit) **bisa** `ALTER USER` akun lain yang punya ALL PRIVILEGES |
| ESC-MY-2 | PASS (sempit) / FAIL (penuh) | admin sempit tidak bisa grant SUPER |
| ESC-MY-3 | **FAIL** | admin bisa `DROP USER` akun lain mana pun |
| ESC-MG-1 | **FAIL** | `dbaas_admin` bisa `grantRolesToUser` **root** ke dirinya sendiri |
| ESC-MG-2 | **FAIL** | `dbaas_admin` bisa mengganti password user mana pun, termasuk root |

## Masalah dan workaround

**Runtime (khas Bun, sudah dibandingkan dengan Node 24.22.1):**

1. **`mongodb@7.7.0` gagal di-load di Bun.** Dependensinya `bson@7.3.x` memanggil `v8.startupSnapshot.isBuildingSnapshot()`, yang di Bun 1.3.14 melempar `NotImplementedError`. bson ≤ 7.2.0 tidak memanggilnya, tapi mongodb 7.7 mensyaratkan `bson ^7.3.2`. Di Node, versi yang sama jalan normal.
   Workaround (keduanya terbukti jalan): (a) pin `mongodb@^6` (6.21.0 + bson 6.10), dipakai di seluruh spike; atau (b) preload shim satu baris `v8.startupSnapshot.isBuildingSnapshot = () => false` lewat `bun --preload` (lihat `extra-m7/shim.ts`). Untuk sekarang direkomendasikan (a), lalu pantau dukungan di Bun.
2. **Proses Bun tidak exit setelah urutan MY-12** (rotasi password + login lama ditolak), dengan driver mysql2 maupun mariadb. Semua test tetap PASS dan hasil tersimpan, tapi event loop tidak selesai. Di Node, kedua driver exit normal. Repro terisolasi tidak memicunya. Uji 200 login gagal + 200 login sukses tidak menunjukkan kebocoran file descriptor (`/proc/self/fd` tetap 13).
   Dampak ke server jangka panjang: rendah. Workaround untuk skrip one-shot (CLI, job): panggil `process.exit()` di akhir. Catatan: di awal saya mengira ini khusus driver `mariadb`; pengukuran ulang menunjukkan kedua driver kena.
3. **Host Windows tidak punya unix socket Docker.** Docker Desktop memakai named pipe, dan `fetch({ unix })` Bun tidak bisa menjangkaunya. Ini bukan masalah di server produksi Linux. Untuk dev di Windows, jalankan control plane di container atau WSL (seperti service `runner` di `compose.yml`).

**Engine/desain (terjadi juga di Node; ini bukan masalah runtime):**

4. **Batas PG hanya default, tenant bisa menimpanya** (PG-10b, PG-12b). `statement_timeout` dan `default_transaction_read_only` dari `ALTER DATABASE` bisa di-`SET` ulang oleh tenant. Simulasi "quota penuh → read-only" lewat setelan ini **tidak aman**.
   Alternatif yang terbukti: `CONNECTION LIMIT 0` + putus sesi (PG-12c). Untuk timeout: control plane memantau `pg_stat_activity` lalu `pg_cancel_backend` (admin anggota role tenant; belum diuji).
5. **Tenant PG bisa konek ke DB `postgres`** dan melihat nama semua DB tenant lain (PG-8b). Mitigasi: sekali jalan sebagai root, `REVOKE CONNECT ON DATABASE postgres FROM PUBLIC`. Isi `pg_database` tetap terlihat dari DB tenant sendiri, jadi nama DB jangan memuat info sensitif.
6. **MariaDB `MAX_STATEMENT_TIME` per user juga hanya default** (MY-8): tenant bisa `SET SESSION max_statement_time = 0`. Penegakan nyata butuh pemantauan `processlist` + `KILL QUERY`. Untuk membunuh query user lain, admin butuh `CONNECTION ADMIN`, yang tidak ada di daftar hak sempit (belum diuji).
7. **REVOKE di MariaDB tidak berlaku untuk koneksi yang sudah terbuka** (MY-11). Setelah revoke, koneksi tenant harus di-`KILL` (juga butuh `CONNECTION ADMIN`). Di MongoDB perubahan role langsung berlaku (MG-9).
8. **Admin MariaDB versi sempit di handoff tidak cukup.** `GRANT ALL ON db.*` mensyaratkan pemberi grant memegang *semua* hak tingkat DB, termasuk `SHOW CREATE ROUTINE` yang baru ada sejak MariaDB 11.3. Daftar minimum yang terbukti lolos 13/13 ada di Kesimpulan. Hak global yang tetap dihindari: SUPER, FILE, SHUTDOWN, BINLOG/REPLICATION *, CONNECTION ADMIN, READ_ONLY ADMIN.
9. **Eskalasi hak di MariaDB dan MongoDB** (ESC-MY-1/3, ESC-MG-1/2).
   - MariaDB: hak global `CREATE USER` mengizinkan `ALTER USER`/`DROP USER` atas **semua** akun, termasuk akun setara root.
   - MongoDB: `userAdminAnyDatabase` setara root karena bisa grant `root` ke dirinya sendiri dan mengganti password siapa pun.
   - Akibatnya, kredensial admin di kedua engine ini harus diperlakukan **setara root** (secret store, audit log). Hanya PostgreSQL yang benar-benar memberi admin hak minimum.
   - Opsi desain yang belum diuji: MariaDB provisioning lewat stored procedure `SQL SECURITY DEFINER` milik root, dengan admin hanya mendapat `EXECUTE`.
   - Kejadian selama spike: versi pertama ESC-MG-2 menyasar akun `root` asli container spike dan benar-benar mengganti password-nya. Sudah dikembalikan ke `rootpass`, dan test diubah untuk menyasar akun dummy.
10. **Mode read-only Mongo masih menyisakan `dbAdmin`** (MG-9): tenant tetap bisa membuat koleksi dan index, yang menambah ukuran. Saat quota penuh, cabut juga `dbAdmin`.
11. **MongoDB tidak punya batas koneksi per user dan tidak punya timeout query per user.** `maxTimeMS` di MG-6 ditentukan klien. `defaultMaxTimeMS` (cluster parameter 8.0) bersifat global dan belum diuji.
12. **Restore PG mempertahankan owner tenant.** `pg_restore` ke `p1_restore` membuat objek milik `p1_dev_app_u`, sehingga `DROP ROLE` gagal sampai DB hasil restore di-drop. Deprovision harus men-drop semua DB milik tenant dulu, atau restore pakai `--no-owner`.
13. **Satu kali di awal, run mysql2 tidak exit dengan satu koneksi tenant tertinggal.** Tidak terulang dalam 3 run penuh + 40 ronde stress. Kemungkinan besar gejala yang sama dengan #2.

## Angka

- **EL-3 p95 latency:** 33,0 ms (klien sendiri: 2.000 req, konkurensi 20, ~955 req/s, p50 19,6 ms, p99 55,0 ms). Run `bunx autocannon -c 20 -a 2000`: p50 17 ms, p97,5 33 ms, p99 37 ms, ~1.000 req/s, 0 error. Setiap request `/health` mem-ping 3 engine. Load generator berjalan di container yang sama dengan server, jadi angka ini konservatif.
- **EL-4 RSS** (VmRSS):
  - Sebelum load: 106,8 MB
  - Setelah 2.000 req: 157,6 MB
  - Setelah 2.000 req tambahan (autocannon): 153,1 MB
  - +5 menit idle: **127,9 MB**
  - Setelah EL-5: 127,3 MB
- **DX:** `pg_dump -Fc` 4,97 MB ≈ 1,0 s; restore ≈ 0,6 s.

## Kesimpulan

- **Bun + Elysia layak untuk control plane.** Menurut kriteria keputusan: semua test PG (14), MY (13, kedua driver), MG (11), dan DX (9) lolos; RAM EL-4 stabil; EL-5 tidak crash dan pulih otomatis. Dua masalah khas Bun (#1, #2) punya workaround murah dan tidak menyentuh jalur kritis (Docker exec, driver PG/MariaDB, server HTTP).
  - Syarat: pin `mongodb@^6` (atau pakai shim), dan skrip one-shot diakhiri `process.exit()`.
  - Yang **perlu revisi desain** (masalah engine, bukan runtime): penegakan quota/timeout (#4, #6, #7, #10, #11) dan status akun admin MariaDB/Mongo yang de facto setara root (#9).
- **Driver MariaDB yang direkomendasikan:** **mysql2**. Hasil kedua driver identik (13/13) dan sama-sama kena #2, tapi mysql2 yang teruji di pool server (EL-1..EL-5, termasuk pemulihan setelah MariaDB mati). Masalah plugin autentikasi tidak muncul.
- **Hak minimum admin MariaDB yang terbukti cukup:**
  ```sql
  GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, INDEX, ALTER, CREATE TEMPORARY TABLES,
    LOCK TABLES, EXECUTE, CREATE VIEW, SHOW VIEW, CREATE ROUTINE, ALTER ROUTINE, EVENT, TRIGGER,
    REFERENCES, DELETE HISTORY, SHOW CREATE ROUTINE, CREATE USER, RELOAD, PROCESS
    ON *.* TO 'dbaas_admin'@'%' WITH GRANT OPTION;
  ```
  Tambahkan `CONNECTION ADMIN` bila control plane harus bisa `KILL` sesi tenant (#6, #7). Daftar ini tetap tidak mencegah eskalasi #9.

## Cara mengulang

```bash
docker compose --profile runner up -d --wait
docker exec spike-runner bun install
docker exec spike-runner bun src/00-setup.ts          # MARIADB_ADMIN_MODE=narrow|narrow-plus untuk varian sempit
docker exec spike-runner bun src/10-postgres.ts
docker exec spike-runner bun src/20-mariadb.ts        # MY_DRIVER=mariadb untuk driver mariadb
docker exec spike-runner bun src/30-mongo.ts
docker exec spike-runner bun src/40-docker-exec.ts
docker exec spike-runner bun src/60-privesc.ts
docker exec -d spike-runner sh -c 'bun src/50-elysia.ts > /tmp/elysia.log 2>&1'
docker exec spike-runner bun src/51-elysia-client.ts  # EL-1..3 (+RSS); PHASE=rss-late setelah 5 menit
bash el5.sh                                           # EL-5, dari host
```
