import { apiJson } from "./api.js";
import { resolveApiBedId } from "./sync.js";

function pathwayLabel(pathway) {
  if (pathway === "upu") return "Cale internare: UPU / urgență.";
  if (pathway === "ambulatory") return "Cale internare: ambulator / programat.";
  if (pathway === "direct") return "Cale internare: direct pe secție.";
  return null;
}

/** Asigură pacient+internare clinică pentru o foaie locală. Trimite doar câmpuri reale. */
export async function ensureAndLoadChart(ward, patient, opts = {}) {
  if (!ward?.apiId) throw new Error("Secția nu este sincronizată cu API.");
  const localKey = patient.clinical?.localKey || `ward:${ward.id}:patient:${patient.id}`;
  const birth = patient.birth || patient.birthDate || undefined;
  const bedId = opts.bedId || resolveApiBedId(ward, patient.bed) || undefined;
  const pathway = opts.pathway || patient.pathway;
  if (!pathway) throw new Error("Calea de internare este obligatorie (upu / ambulatory / direct).");
  const body = {
    wardId: ward.apiId,
    bedId,
    firstName: patient.first || patient.firstName || "",
    lastName: patient.last || patient.lastName || "",
    sex: patient.sex === "F" || patient.sex === "M" ? patient.sex : "necunoscut",
    birthDate: birth && /^\d{4}-\d{2}-\d{2}$/.test(birth) ? birth : undefined,
    localKey,
    diagnosis: patient.dx || undefined,
    pathway,
    cnp: patient.cnp && /^\d{13}$/.test(patient.cnp) ? patient.cnp : undefined,
    admissionCriterion: patient.criteriuInternare || undefined,
    referralNumber: patient.referralNumber || patient.idActNo || undefined,
    insuranceCategory: patient.casa || patient.tipAsigurare || undefined,
    attendingPhysician: patient.physician || undefined,
    allergies: patient.allergies || undefined,
    bloodGroup: patient.blood || undefined,
    address: patient.address || undefined,
    phone: patient.phone || undefined,
    kinName: patient.kinName || undefined,
    kinPhone: patient.kinPhone || undefined,
    bodyKg: patient.bodyKg || undefined,
    heightCm: patient.heightCm || undefined,
    reason: patient.reason || undefined,
    antecedents: patient.antecedents || undefined,
    consentAdmit: patient.consentAdmit === true,
    consentProc: patient.consentProc === true
  };
  if (!body.firstName || !body.lastName) throw new Error("Numele și prenumele sunt obligatorii.");
  const ensured = await apiJson("/api/chart/ensure", {
    method: "POST",
    body: JSON.stringify(body)
  });
  patient.clinical = {
    patientId: ensured.patientId,
    encounterId: ensured.encounterId,
    admissionId: ensured.admissionId,
    bedId: ensured.bedId || bedId,
    localKey,
    fileNo: ensured.fileNo || patient.fileNo
  };
  if (ensured.fileNo) patient.fileNo = ensured.fileNo;
  const chart = await apiJson(`/api/patients/${ensured.patientId}/chart`);
  mergeChartIntoPatient(patient, chart);
  return { ensured, chart };
}

export function mergeChartIntoPatient(patient, chart) {
  const apiNotes = (chart.notes || []).map((n) => ({
    id: n.id,
    at: n.created_at,
    author: n.author_name || n.author_display_name || "medic",
    text: n.body,
    kind: n.kind,
    clinical: true
  }));
  const local = (patient.notes || []).filter((n) => !n.clinical);
  const seen = new Set(apiNotes.map((n) => n.id));
  patient.notes = apiNotes.concat(local.filter((n) => !n.id || !seen.has(n.id)));
  patient.clinicalDiagnoses = chart.diagnoses || [];
  patient.clinicalAllergies = chart.allergies || [];
  patient.clinicalObservations = chart.observations || [];
  patient.clinicalDocuments = chart.documents || [];
  patient.clinicalVitals = chart.vitals || [];
  if (Array.isArray(chart.vitals) && chart.vitals.length) {
    const mapped = chart.vitals.map((v) => ({
      id: v.id,
      at: v.recorded_at,
      ta: v.ta,
      av: v.av,
      rr: v.rr,
      temp: v.temp,
      spo2: v.spo2,
      note: v.note || "",
      clinical: true
    }));
    const localV = (patient.vitals || []).filter((v) => !v.clinical);
    patient.vitals = mapped.concat(localV);
  }
  if (chart.diagnoses?.[0]?.display) patient.dx = chart.diagnoses[0].display;
  if (chart.admission?.file_no) patient.fileNo = chart.admission.file_no;
  if (chart.episodes) patient.clinicalEpisodes = chart.episodes;
}

export async function saveClinicalNote(patient, text, kind = "evolution") {
  if (!patient?.clinical?.encounterId) throw new Error("Foaia nu este legată clinic.");
  const saved = await apiJson("/api/notes", {
    method: "POST",
    body: JSON.stringify({ encounterId: patient.clinical.encounterId, kind, body: text })
  });
  return saved;
}

export async function saveClinicalDiagnosis(patient, display, code) {
  if (!patient?.clinical?.encounterId) throw new Error("Foaia nu este legată clinic.");
  return apiJson("/api/diagnoses", {
    method: "POST",
    body: JSON.stringify({
      encounterId: patient.clinical.encounterId,
      display,
      code: code || undefined,
      rank: "principal"
    })
  });
}

export async function saveClinicalVital(patient, vital) {
  if (!patient?.clinical?.encounterId) throw new Error("Foaia nu este legată clinic.");
  return apiJson(`/api/encounters/${patient.clinical.encounterId}/vitals`, {
    method: "POST",
    body: JSON.stringify(vital)
  });
}

export async function saveClinicalTransfer(patient, payload) {
  if (!patient?.clinical?.admissionId) throw new Error("Internarea clinică lipsește.");
  return apiJson(`/api/admissions/${patient.clinical.admissionId}/transfer`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function saveClinicalDischarge(patient, fields) {
  if (!patient?.clinical?.encounterId) throw new Error("Foaia nu este legată clinic.");
  return apiJson(`/api/encounters/${patient.clinical.encounterId}/discharge`, {
    method: "POST",
    body: JSON.stringify({
      summary: fields.epicrisis,
      dischargeStatus: fields.dischargeStatus,
      dischargeType: fields.dischargeType === "deces" ? "deces" : fields.dischargeType,
      dxCode: fields.dxCode || undefined,
      dxDisplay: fields.dx,
      secondary: fields.secondary || undefined,
      recommendations: fields.recommendations
    })
  });
}

export async function saveClinicalMedication(patient, med) {
  if (!patient?.clinical?.encounterId) throw new Error("Foaia nu este legată clinic.");
  return apiJson("/api/medications/orders", {
    method: "POST",
    body: JSON.stringify({
      encounterId: patient.clinical.encounterId,
      medicationName: med.name,
      dose: med.dose || "nespecificat",
      route: med.route || undefined,
      schedule: med.schedule || undefined
    })
  });
}

export async function saveClinicalConsent(patient, purpose, granted) {
  if (!patient?.clinical?.patientId) throw new Error("Pacientul clinic lipsește.");
  return apiJson("/api/consents", {
    method: "POST",
    body: JSON.stringify({
      patientId: patient.clinical.patientId,
      purpose,
      status: granted ? "granted" : "refused"
    })
  });
}

export async function saveClinicalServiceRequest(patient, code, display) {
  if (!patient?.clinical?.encounterId) throw new Error("Foaia nu este legată clinic.");
  return apiJson("/api/service-requests", {
    method: "POST",
    body: JSON.stringify({
      encounterId: patient.clinical.encounterId,
      code,
      display
    })
  });
}

export async function loadWardPhysicians(wardApiId) {
  if (!wardApiId) return [];
  const rows = await apiJson(`/api/wards/${wardApiId}/physicians`);
  return rows.items || rows || [];
}

export async function loadWardEmployees(wardApiId) {
  if (!wardApiId) return [];
  const rows = await apiJson(`/api/hr/employees?wardId=${encodeURIComponent(wardApiId)}`);
  return rows.items || rows || [];
}

export async function requestDocumentPdf(patient, docType) {
  if (!patient?.clinical?.encounterId) throw new Error("Foaia nu este legată clinic.");
  return apiJson("/api/documents/generate", {
    method: "POST",
    body: JSON.stringify({
      encounterId: patient.clinical.encounterId,
      docType,
      title: docType === "discharge_letter" ? "Scrisoare medicală" : "Foaie de observație"
    })
  });
}

export { pathwayLabel };
