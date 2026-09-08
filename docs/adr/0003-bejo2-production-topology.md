# ADR-0003: Production pada bejo2-vnic

- **Status:** Accepted
- **Date:** 2026-09-08
- **Decision owner:** Master Peng

## Context

Development dilakukan pada workspace `bejo1-oracle`, tetapi target production yang ditetapkan adalah `bejo2-vnic`. Host production ARM64 memiliki 1 vCPU, 5.8 GiB RAM, Docker/Compose, dan host Nginx yang sudah melayani aplikasi lain pada 80/443 serta port 3000.

## Decision

- `bejo1-oracle` digunakan untuk development/review; `bejo2-vnic` untuk production.
- Frontend Vite dibangun menjadi static assets dan disajikan host Nginx.
- FastAPI dan worker berjalan sebagai dua service Docker Compose dari image aplikasi yang sama.
- API dipublikasikan hanya pada loopback `127.0.0.1:8010` dan diproxy Nginx melalui `/api/`.
- Worker concurrency tetap satu.
- SQLite dan temporary artifacts menggunakan persistent host volumes pada bejo2.
- Tidak ada Node production server, Redis/Celery, database server terpisah, atau local AI inference.
- Gandiwa menggunakan dedicated HTTPS hostname yang tidak mengganggu `komputermu.my.id`; hostname final ditentukan sebelum deployment.
- Deployment bersifat manual-gated setelah review, commit, PR/CI, dan approval. Push bukan deployment otomatis.

## Consequences

- Stack ringan dan sesuai resource single-user.
- Image/dependency harus mendukung `linux/arm64`.
- Nginx existing site harus diuji setelah setiap perubahan.
- 1 vCPU membatasi throughput; queue menjadi mekanisme backpressure.
- Swap, backup, secret file, hostname/TLS, and smoke tests are production prerequisites.

## Revisit Trigger

Pindah host, multi-host deployment, managed database, public multi-user service, atau kebutuhan lebih dari satu worker membutuhkan ADR baru.