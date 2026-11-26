import { apiJson } from "./api.js";

function focusFromName(name) {
  const n = String(name || "").toLowerCase();
  if (/cardio|coronar/.test(n)) return "cardio";
  if (/chirur|orto|urolog|gineco|ogi/.test(n)) return "surg";
  if (/medicin|intern|pneumo|gastro|nefro|diabet|infect/.test(n)) return "med";
  return "general";
}

function bedOrdinal(label, fallback) {
  const m = String(label || "").match(/(\d+)/);
  return m ? Number(m[1]) : fallback;
}

/** Citește structura din bază pe id. Nu creează secții/paturi. */
export async function loadStructureFromApi(state, ui, helpers = {}) {
  const { persist } = helpers;
  const structure = await apiJson("/api/structure");
  const roomsByWard = new Map();
  for (const room of structure.rooms || []) {
    const list = roomsByWard.get(room.ward_id) || [];
    list.push(room);
    roomsByWard.set(room.ward_id, list);
  }
  const bedsByRoom = new Map();
  for (const bed of structure.beds || []) {
    const list = bedsByRoom.get(bed.room_id) || [];
    list.push(bed);
    bedsByRoom.set(bed.room_id, list);
  }

  const existingByApi = new Map((state.wards || []).filter((w) => w.apiId).map((w) => [w.apiId, w]));
  const next = [];
  for (const apiWard of structure.wards || []) {
    const rooms = roomsByWard.get(apiWard.id) || [];
    const apiBeds = [];
    rooms.forEach((room) => {
      (bedsByRoom.get(room.id) || []).forEach((bed) => {
        apiBeds.push({
          apiId: bed.id,
          roomId: room.id,
          roomName: room.name,
          label: bed.label,
          status: bed.status,
          localNo: bedOrdinal(bed.label, apiBeds.length + 1)
        });
      });
    });
    apiBeds.sort((a, b) => a.localNo - b.localNo || String(a.label).localeCompare(String(b.label)));
    apiBeds.forEach((b, i) => { b.localNo = i + 1; });

    const prev = existingByApi.get(apiWard.id);
    next.push({
      id: prev?.id || apiWard.id,
      apiId: apiWard.id,
      name: apiWard.name,
      specialty: apiWard.specialty || apiWard.name,
      chief: prev?.chief || "",
      nurse: prev?.nurse || "",
      physicians: Array.isArray(prev?.physicians) ? prev.physicians : [],
      focus: prev?.focus || focusFromName(apiWard.name),
      staff: Array.isArray(prev?.staff) ? prev.staff : [],
      duty: prev?.duty || { date: "", medic: "", asistenta: "", infirmiera: "", brancardier: "" },
      stock: Array.isArray(prev?.stock) ? prev.stock : [],
      meds: Array.isArray(prev?.meds) ? prev.meds : [],
      bedCount: apiBeds.length || prev?.bedCount || 0,
      closed: Array.isArray(prev?.closed) ? prev.closed : [],
      patients: Array.isArray(prev?.patients) ? prev.patients : [],
      discharged: Array.isArray(prev?.discharged) ? prev.discharged : [],
      apiBeds,
      departmentId: apiWard.department_id
    });
  }

  state.wards = next;
  if (structure.hospital) {
    state.hospital = state.hospital || {};
    state.hospital.name = structure.hospital.name || state.hospital.name;
    state.hospital.timezone = structure.hospital.timezone || state.hospital.timezone;
    state.hospital.code = state.hospital.code || structure.hospital.country_code || "";
  }
  ui.platformNote = `Structură din bază: ${next.length} secții. Softul nu creează secții la deschidere.`;
  if (persist) persist();
  return structure;
}

export async function hydrateBoardOccupancy(state, ui) {
  const board = await apiJson("/api/board/wards?limit=100&offset=0");
  ui.apiBoardTotal = board.total || 0;
  const byId = new Map((board.items || []).map((row) => [row.id, row]));
  for (const w of state.wards) {
    const row = w.apiId && byId.get(w.apiId);
    if (!row) continue;
    w.apiId = row.id;
    w.apiBedTotal = row.bed_total;
    w.apiOccupied = row.occupied;
    w.apiFree = row.free;
    if (row.bed_total > 0) w.bedCount = row.bed_total;
  }
  return board;
}

/** Legătură id pe secții existente. Nu creează wards/beds. */
export async function syncStructureToApi(state, ui, helpers) {
  await loadStructureFromApi(state, ui, helpers);
  await hydrateBoardOccupancy(state, ui);
  if (helpers?.persist) helpers.persist();
  ui.platformNote = "Structura este citită din baza clinică (id). Ocuparea vine din /api/board.";
}

export function resolveApiBedId(ward, localBedNo) {
  const beds = ward?.apiBeds || [];
  const hit = beds.find((b) => b.localNo === Number(localBedNo) || b.label === `Pat ${localBedNo}`);
  return hit?.apiId || null;
}
