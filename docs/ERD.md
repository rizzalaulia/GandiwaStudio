# Entity Relationship Diagram — Gandiwa Studio

**Versi:** 1.0  
**Cakupan:** Model data MVP single-user

## Prinsip Penyimpanan

Gandiwa memakai dua lapisan data:

1. **Filesystem pengguna** melalui File System Access API untuk source, hasil generasi, revisi, preview, export, dan manifest proyek.
2. **Database backend SQLite** untuk konfigurasi provider, model capability, job runtime, audit rules, dan catatan operasional.

API key tidak boleh masuk `gandiwa-project.json`, database dalam folder proyek, atau log. Secret disimpan melalui environment variables atau secret store backend.

## Diagram ERD

```mermaid
erDiagram
    PROJECT ||--o{ ASSET : contains
    PROJECT ||--o{ GENERATION_JOB : requests
    PROJECT ||--o{ PROMPT_TEMPLATE : uses
    PROJECT ||--o{ MODERATION_FEEDBACK : records

    CONTENT_TYPE ||--o{ ASSET : classifies
    CONTENT_TYPE ||--o{ GENERATION_JOB : constrains
    CONTENT_TYPE ||--o{ AUDIT_RULE : activates

    PROVIDER ||--o{ MODEL : exposes
    MODEL ||--o{ MODEL_CAPABILITY : has
    MODEL ||--o{ GENERATION_JOB : executes
    RULESET ||--o{ AUDIT_RULE : contains
    RULESET ||--o{ JOB_RULE_SNAPSHOT : snapshots
    GENERATION_JOB ||--|| JOB_RULE_SNAPSHOT : governed_by
    GENERATION_JOB }o--|| GENERATION_BATCH : belongs_to

    GENERATION_JOB ||--o{ ASSET : produces
    GENERATION_JOB ||--o{ JOB_EVENT : logs
    GENERATION_JOB }o--o| PROMPT_TEMPLATE : applies

    ASSET ||--o{ ASSET_REVISION : versions
    ASSET_REVISION ||--o{ AUDIT_RUN : inspected_by
    ASSET_REVISION ||--o{ APPROVAL : approved_by
    ASSET ||--o| STOCK_METADATA : described_by
    ASSET_REVISION ||--o{ EXPORT_VALIDATION : validates
    RULESET ||--o{ EXPORT_VALIDATION : governs
    ASSET ||--o{ MODERATION_FEEDBACK : receives
    ASSET }o--o| ASSET : derived_from

    AUDIT_RUN ||--o{ AUDIT_FINDING : contains
    AUDIT_RULE ||--o{ AUDIT_FINDING : triggers

    EXPORT_PACKAGE ||--|{ EXPORT_ITEM : contains
    ASSET ||--o{ EXPORT_ITEM : exported_as
    PROJECT ||--o{ EXPORT_PACKAGE : creates

    PROJECT {
      uuid id PK
      string name
      string schema_version
      string workspace_relative_path
      datetime created_at
      datetime updated_at
    }

    CONTENT_TYPE {
      string code PK
      string label
      json allowed_formats
      string description
    }

    PROVIDER {
      uuid id PK
      string kind
      string name
      string base_url
      string secret_ref
      boolean enabled
      datetime last_tested_at
      string health_status
    }

    MODEL {
      uuid id PK
      uuid provider_id FK
      string remote_model_id
      string display_name
      boolean enabled
      json default_parameters
    }

    MODEL_CAPABILITY {
      uuid id PK
      uuid model_id FK
      string capability
      json constraints
    }

    PROMPT_TEMPLATE {
      uuid id PK
      uuid project_id FK
      string role
      string name
      text system_prompt
      text user_template
      integer version
      datetime created_at
    }

    GENERATION_BATCH {
      uuid id PK
      uuid project_id FK
      string name
      datetime created_at
    }

    RULESET {
      string id PK
      string marketplace
      string version
      string source_url
      datetime source_retrieved_at
      datetime effective_from
      string status
    }

    JOB_RULE_SNAPSHOT {
      uuid id PK
      uuid generation_job_id FK
      string ruleset_id FK
      json immutable_constraints
      string snapshot_hash
      datetime created_at
    }

    GENERATION_JOB {
      uuid id PK
      uuid project_id FK
      uuid generation_batch_id FK
      string content_type_code FK
      string creation_method
      uuid model_id FK
      uuid prompt_template_id FK
      string generation_format
      string working_format
      string master_format
      string requested_submission_format
      json brief
      text resolved_prompt
      json parameters
      string adapter_version
      string model_revision
      string seed
      string status
      string error_code
      datetime started_at
      datetime completed_at
    }

    JOB_EVENT {
      uuid id PK
      uuid generation_job_id FK
      string level
      string event_type
      text redacted_message
      datetime created_at
    }

    ASSET {
      uuid id PK
      uuid project_id FK
      uuid generation_job_id FK
      string content_type_code FK
      uuid parent_asset_id FK
      string role
      string format
      string relative_path
      string sha256
      string workflow_status
      boolean is_master
      datetime created_at
    }

    ASSET_REVISION {
      uuid id PK
      uuid asset_id FK
      integer revision_number
      string relative_path
      string sha256
      json edit_operations
      datetime created_at
    }

    AUDIT_RULE {
      string id PK
      string content_type_code FK
      string category
      string evaluator_type
      string severity
      boolean blocks_export
      string version
    }

    AUDIT_RUN {
      uuid id PK
      uuid asset_id FK
      string status
      string ruleset_version
      uuid ai_model_id FK
      datetime started_at
      datetime completed_at
    }

    AUDIT_FINDING {
      uuid id PK
      uuid audit_run_id FK
      string audit_rule_id FK
      string verdict
      string severity
      text message
      json evidence
      boolean acknowledged
    }

    STOCK_METADATA {
      uuid id PK
      uuid asset_id FK
      string title
      json keywords
      string category
      boolean generated_with_ai
      string language
      datetime updated_at
    }

    EXPORT_PACKAGE {
      uuid id PK
      uuid project_id FK
      string relative_path
      string status
      datetime created_at
    }

    EXPORT_ITEM {
      uuid id PK
      uuid export_package_id FK
      uuid asset_id FK
      string file_role
      string relative_path
      string sha256
    }

    APPROVAL {
      uuid id PK
      uuid asset_revision_id FK
      uuid audit_run_id FK
      string ruleset_id FK
      string asset_checksum
      string status
      datetime approved_at
      datetime invalidated_at
    }

    EXPORT_VALIDATION {
      uuid id PK
      uuid asset_revision_id FK
      string ruleset_id FK
      string submission_format
      string asset_checksum
      string verdict
      json evidence
      datetime validated_at
    }

    MODERATION_FEEDBACK {
      uuid id PK
      uuid project_id FK
      uuid asset_id FK
      string outcome
      string reason_code
      text notes
      datetime submitted_at
      datetime decided_at
    }
```

## Kamus Nilai Penting

### `CONTENT_TYPE.code`

| Nilai | Arti | Format generasi MVP |
|---|---|---|
| `photo` | Konten bergaya fotografi | `png`, `jpeg` |
| `illustration` | Ilustrasi raster atau native vector | `png`, `jpeg`, conditional `svg` |
| `vector` | Artwork vector native | `svg` |

### `GENERATION_JOB.status`

`queued`, `running`, `succeeded`, `failed`, `cancelled`.

### `ASSET.role`

`source`, `candidate`, `master`, `revision`, `preview`, `final`.

### `ASSET.workflow_status`

`generated`, `selected`, `editing`, `audit_failed`, `needs_review`, `approved`, `ready_for_export`, `exported`.

### `AUDIT_FINDING.verdict`

`pass`, `warning`, `fail`, `not_applicable`.

### `MODERATION_FEEDBACK.outcome`

`pending`, `accepted`, `rejected`, `removed`.

## Relasi dan Aturan Integritas

1. Satu asset memiliki tepat satu content type dan tidak boleh menggantinya setelah dibuat.
2. `creation_method` wajib dicatat terpisah dari content type.
3. Perubahan content type menghasilkan generation job dan asset baru.
4. Setiap job wajib memiliki immutable `JOB_RULE_SNAPSHOT` sebelum request dikirim.
5. Generation, working, master, dan submission format disimpan terpisah.
6. Hanya satu asset master aktif per generation batch; pergantian master dicatat.
7. Revision tidak menimpa source; nomor revision unik per asset.
8. Audit, approval, dan export validation terikat pada revision, ruleset, serta checksum tertentu.
9. Edit artwork atau metadata relevan membuat approval/export validation lama berstatus stale/invalid.
10. Asset hanya dapat menjadi `ADOBE_READY` jika blocking rules PASS, metadata/disclosure lengkap, dan approval terkini valid.
11. `secret_ref` hanya menunjuk secret server-side, bukan berisi key.
12. Penghapusan provider tidak menghapus riwayat job; provider dinonaktifkan atau disoft-delete.
13. Audit AI menyimpan model yang digunakan agar hasil dapat ditelusuri.
14. Hash digunakan untuk integritas dan deteksi duplikasi; bukan sebagai satu-satunya similarity metric.
15. Manifest proyek adalah source of truth portabel; SQLite backend hanya cache/index/runtime state dan dapat dibangun ulang dari manifest.
16. Implementasi ruleset dan fixture mengacu pada `ADOBE-RULESET.md`.

## Struktur Folder Proyek

```text
GandiwaProject/
├── gandiwa-project.json
├── sources/
├── generated/
│   ├── photo/
│   ├── illustration/
│   └── vector/
├── revisions/
├── previews/
├── metadata/
├── reports/
└── exports/
```

Manifest menyimpan ID, path relatif, content type, format, status, dan referensi metadata. Secret serta path absolut tidak disimpan agar proyek portabel.
