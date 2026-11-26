# Zero inventare + foaia în baza clinică

## Regulă

Softul nu inventează date clinice. Câmp necompletat = gol. Rezultat = din laborator sau introdus manual cu autor.

## Ce s-a schimbat

1. Oprite: `priorEpisode`, auto-`kinOf`/`antecedentsOf`, `fillChart`/`fillProfiles`/`fillArchive` la boot, `finalizeStudy` cu `baseRows` / „în limite” / texte RX automate.
2. Seed pacienți doar cu `?demo=1` sau `window.__ALLOW_DEMO_SEED__ = true`.
3. Structură: `loadStructureFromApi` — citire pe id, fără `POST /api/wards` la boot.
4. Internare → `POST /api/chart/ensure` (CNP, pat UUID, pathway obligatoriu, criteriu, asigurare, medic, consimțăminte).
5. Transfer → `/api/admissions/:id/transfer`; externare → `/api/encounters/:id/discharge`.
6. Constante → `/api/encounters/:id/vitals`; medicație → `/api/medications/orders`; consimțăminte → `/api/consents`.
7. Medici pe secție → `GET /api/wards/:id/physicians`.
8. Documente → `POST /api/documents/generate` (text arhivat în `documents`).
9. Nomenclatoare: criterii Diagnostic/Tratament, calitate Student, regim Hidric, subset ICD-10-AM / ACHI / DCI.

## Migrare

`apps/api/migrations/0008_clinical_writes.sql`
