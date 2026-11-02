#!/usr/bin/env bash
# EL-5: matikan MariaDB, pantau /health, nyalakan lagi, ukur waktu pulih. Dijalankan dari host.
set -u
health() { curl -s -m 5 -o /tmp/h.json -w '%{http_code}' localhost:3000/health; echo " $(cat /tmp/h.json)"; }
pid=$(docker exec spike-runner sh -c 'cat /tmp/elysia.pid')
echo "sebelum: $(health)"
docker stop spike-mariadb >/dev/null && echo "mariadb stopped $(date +%T)"
for i in 1 2 3; do echo "down #$i: $(health)"; sleep 2; done
docker start spike-mariadb >/dev/null && echo "mariadb started $(date +%T)"
t0=$(date +%s)
for i in $(seq 1 60); do
  r=$(health)
  case "$r" in 200*) echo "pulih setelah $(( $(date +%s) - t0 ))s: $r"; break;; esac
  sleep 1
done
docker exec spike-runner sh -c "test -d /proc/$pid && echo 'server masih hidup pid $pid' || echo 'SERVER MATI'; grep VmRSS /proc/$pid/status"
docker exec spike-runner sh -c 'grep -iE "error|uncaught" /tmp/elysia.log | head -5 || true'
