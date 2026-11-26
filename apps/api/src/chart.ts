import type { Db } from "./db.js";

export type ChartBundle = {
  patient: Record<string, unknown>;
  admission: Record<string, unknown> | null;
  encounter: Record<string, unknown> | null;
  notes: Record<string, unknown>[];
  diagnoses: Record<string, unknown>[];
  allergies: Record<string, unknown>[];
  observations: Record<string, unknown>[];
  documents: Record<string, unknown>[];
  vitals: Record<string, unknown>[];
  episodes: Record<string, unknown>[];
};

export async function loadPatientChart(db: Db, hospitalId: string, patientId: string): Promise<ChartBundle> {
  const patients = await db.query<Record<string, unknown>>(
    "SELECT * FROM patients WHERE id = $1 AND hospital_id = $2",
    [patientId, hospitalId]
  );
  if (!patients[0]) throw Object.assign(new Error("Pacientul nu există în acest spital."), { statusCode: 404 });
  const [admission] = await db.query<Record<string, unknown>>(
    `SELECT * FROM admissions WHERE hospital_id = $1 AND patient_id = $2 AND status = 'active'
     ORDER BY started_at DESC LIMIT 1`,
    [hospitalId, patientId]
  );
  let encounter: Record<string, unknown> | null = null;
  if (admission?.encounter_id) {
    const rows = await db.query<Record<string, unknown>>(
      "SELECT * FROM encounters WHERE id = $1 AND hospital_id = $2",
      [admission.encounter_id, hospitalId]
    );
    encounter = rows[0] ?? null;
  }
  const [notes, diagnoses, allergies, observations, documents, vitals, episodes] = await Promise.all([
    db.query<Record<string, unknown>>(
      `SELECT n.id, n.kind, n.body, n.author_user_id, n.created_at, u.display_name AS author_name
       FROM clinical_notes n
       LEFT JOIN users u ON u.id = n.author_user_id
       WHERE n.hospital_id = $1 AND n.patient_id = $2 ORDER BY n.created_at DESC LIMIT 200`,
      [hospitalId, patientId]
    ),
    db.query<Record<string, unknown>>(
      `SELECT id, code, display, rank, created_at FROM diagnoses
       WHERE hospital_id = $1 AND patient_id = $2 ORDER BY created_at DESC LIMIT 100`,
      [hospitalId, patientId]
    ),
    db.query<Record<string, unknown>>(
      `SELECT id, substance, criticality, noted_at FROM allergies
       WHERE hospital_id = $1 AND patient_id = $2 ORDER BY noted_at DESC LIMIT 50`,
      [hospitalId, patientId]
    ),
    db.query<Record<string, unknown>>(
      `SELECT id, code, display_name, value_numeric, value_text, unit, status, critical, created_at
       FROM observations WHERE hospital_id = $1 AND patient_id = $2
       ORDER BY created_at DESC LIMIT 200`,
      [hospitalId, patientId]
    ),
    db.query<Record<string, unknown>>(
      `SELECT id, doc_type, status, version, title, body, finalized_at, created_at
       FROM documents WHERE hospital_id = $1 AND patient_id = $2
       ORDER BY created_at DESC LIMIT 50`,
      [hospitalId, patientId]
    ),
    db.query<Record<string, unknown>>(
      `SELECT id, recorded_at, ta, av, rr, temp, spo2, note, author_user_id
       FROM encounter_vitals WHERE hospital_id = $1 AND patient_id = $2
       ORDER BY recorded_at DESC LIMIT 200`,
      [hospitalId, patientId]
    ),
    db.query<Record<string, unknown>>(
      `SELECT a.id, a.file_no, a.started_at AS admitted, a.ended_at AS discharged, a.status,
              a.attending_physician AS physician, w.name AS ward,
              e.discharge_dx_display AS dx, e.discharge_status, e.discharge_type
       FROM admissions a
       LEFT JOIN wards w ON w.id = a.current_ward_id
       LEFT JOIN encounters e ON e.id = a.encounter_id
       WHERE a.hospital_id = $1 AND a.patient_id = $2
       ORDER BY a.started_at DESC LIMIT 50`,
      [hospitalId, patientId]
    )
  ]);
  return {
    patient: patients[0],
    admission: admission ?? null,
    encounter,
    notes,
    diagnoses,
    allergies,
    observations,
    documents,
    vitals,
    episodes
  };
}
