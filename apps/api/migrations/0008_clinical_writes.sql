-- Constante pe foaie + legături clinice fără inventare de date.

CREATE TABLE IF NOT EXISTS encounter_vitals (
  id uuid PRIMARY KEY,
  hospital_id uuid NOT NULL REFERENCES hospitals(id),
  patient_id uuid NOT NULL REFERENCES patients(id),
  encounter_id uuid NOT NULL REFERENCES encounters(id),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  ta text,
  av text,
  rr text,
  temp text,
  spo2 text,
  note text,
  author_user_id uuid REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS encounter_vitals_encounter_idx
  ON encounter_vitals (hospital_id, encounter_id, recorded_at DESC);

ALTER TABLE admissions
  ADD COLUMN IF NOT EXISTS attending_physician text,
  ADD COLUMN IF NOT EXISTS pathway text;

ALTER TABLE practitioners
  ADD COLUMN IF NOT EXISTS parafa text,
  ADD COLUMN IF NOT EXISTS grade text,
  ADD COLUMN IF NOT EXISTS ward_id uuid REFERENCES wards(id);

INSERT INTO permissions (code, description)
VALUES
  ('medication.write', 'Prescriere și administrare medicație'),
  ('consent.write', 'Înregistrare consimțăminte')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_code)
SELECT r.id, p.code
FROM roles r
CROSS JOIN permissions p
WHERE p.code IN ('medication.write', 'consent.write')
  AND (
    r.code = 'admin'
    OR (p.code = 'medication.write' AND r.code IN ('physician', 'nurse', 'ward_chief'))
    OR (p.code = 'consent.write' AND r.code IN ('physician', 'nurse', 'ward_chief'))
  )
ON CONFLICT DO NOTHING;
