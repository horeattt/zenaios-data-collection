/** Nomenclatoare din Manual Administrare (Hospital Manager) + Modul Fișier (Hipocrate) — subset pilot. */

export const NOMENCLATOR_CATALOG = [
  { id: "statut_asigurat", label: "Statut asigurat", group: "Asigurări", cols: [["name", "Denumire"], ["drg", "Tip DRG"], ["defaultRo", "Default RO"], ["defaultStr", "Default străin"]] },
  { id: "tip_asigurare", label: "Tip asigurare", group: "Asigurări", cols: [["name", "Denumire"], ["drg", "Tip DRG"], ["statut", "Statut"]] },
  { id: "case_asigurari", label: "Case de asigurări", group: "Asigurări", cols: [["name", "Denumire"], ["code", "Cod"], ["judet", "Județ"]] },
  { id: "calitate_asigurat", label: "Calitate asigurat", group: "Asigurări", cols: [["name", "Denumire"], ["code", "Cod"]] },
  { id: "tip_venire", label: "Tip venire", group: "Internare", cols: [["name", "Denumire"]] },
  { id: "criteriu_internare", label: "Criteriu internare", group: "Internare", cols: [["name", "Denumire"]] },
  { id: "tip_internare", label: "Tip internare", group: "Internare", cols: [["name", "Denumire"], ["dayCare", "De zi"]] },
  { id: "regim_masa", label: "Regim masă", group: "Internare", cols: [["name", "Denumire"], ["code", "Cod"]] },
  { id: "tip_act", label: "Tip act identitate", group: "Pacient", cols: [["name", "Denumire"], ["code", "Cod"]] },
  { id: "judete", label: "Județe", group: "Pacient", cols: [["name", "Denumire"], ["code", "Cod SIRUTA"]] },
  { id: "unitati_trimitatoare", label: "Unități trimitătoare", group: "Internare", cols: [["name", "Denumire"], ["type", "Tip"]] },
  { id: "alte_servicii", label: "Alte servicii", group: "Servicii", cols: [["name", "Denumire"], ["price", "Preț"], ["editable", "Pret modificabil"]] },
  { id: "proceduri", label: "Proceduri", group: "Clinic", cols: [["name", "Denumire"], ["code", "Cod"], ["group", "Grupă"]] },
  { id: "grupe_dx_oms", label: "Grupe diagnostice OMS", group: "Clinic", cols: [["code", "Cod"], ["name", "Denumire"]] },
  { id: "icd10am", label: "ICD-10-AM (subset)", group: "Clinic", cols: [["code", "Cod"], ["name", "Denumire"]] },
  { id: "achi", label: "ACHI proceduri (subset)", group: "Clinic", cols: [["code", "Cod"], ["name", "Denumire"]] },
  { id: "dci_medicamente", label: "DCI medicamente (subset)", group: "Clinic", cols: [["dci", "DCI"], ["form", "Formă"], ["strength", "Concentrație"]] }
];

function rows(list) {
  return list.map((item, i) => ({ id: `n${i}_${Math.random().toString(36).slice(2, 6)}`, ...item }));
}

export function seedNomenclatoare() {
  return {
    statut_asigurat: rows([
      { name: "Asigurat CNAS", drg: "A", defaultRo: "da", defaultStr: "nu" },
      { name: "Neasigurat", drg: "N", defaultRo: "nu", defaultStr: "nu" },
      { name: "Asigurare voluntară", drg: "V", defaultRo: "nu", defaultStr: "da" }
    ]),
    tip_asigurare: rows([
      { name: "Obligatorie CNAS", drg: "A", statut: "Asigurat CNAS" },
      { name: "Eurocard / EHIC", drg: "E", statut: "Asigurat CNAS" },
      { name: "Neasigurat", drg: "N", statut: "Neasigurat" }
    ]),
    case_asigurari: rows([
      { name: "CJAS Bihor", code: "BH", judet: "Bihor" },
      { name: "CJAS Cluj", code: "CJ", judet: "Cluj" },
      { name: "CNAS", code: "CNAS", judet: "—" }
    ]),
    calitate_asigurat: rows([
      { name: "Salariat", code: "S" },
      { name: "Pensionar", code: "P" },
      { name: "Copil", code: "C" },
      { name: "Student", code: "ST" },
      { name: "Fără ocupație", code: "F" }
    ]),
    tip_venire: rows([
      { name: "Prezentare directă" },
      { name: "Ambulanță" },
      { name: "Medic de familie" },
      { name: "Transfer alt spital" },
      { name: "UPU" }
    ]),
    criteriu_internare: rows([
      { name: "Nu necesită" },
      { name: "Criterii clinice" },
      { name: "Urgență medicală" },
      { name: "Programare" },
      { name: "Diagnostic" },
      { name: "Tratament" }
    ]),
    tip_internare: rows([
      { name: "Continuă", dayCare: "nu" },
      { name: "De zi", dayCare: "da" },
      { name: "Urgență", dayCare: "nu" },
      { name: "Programată", dayCare: "nu" }
    ]),
    regim_masa: rows([
      { name: "Nu necesită", code: "0" },
      { name: "Normal", code: "N" },
      { name: "Diabet", code: "D" },
      { name: "Hepatic", code: "H" },
      { name: "Hiposodat", code: "HS" },
      { name: "Hidric", code: "HY" }
    ]),
    tip_act: rows([
      { name: "C.I.", code: "CI" },
      { name: "B.I.", code: "BI" },
      { name: "Pașaport", code: "P" },
      { name: "Certificat de naștere", code: "CN" },
      { name: "Carte de rezidență", code: "CR" }
    ]),
    judete: rows([
      { name: "Bihor", code: "05" },
      { name: "Cluj", code: "12" },
      { name: "București", code: "40" },
      { name: "Timiș", code: "35" },
      { name: "Iași", code: "22" }
    ]),
    unitati_trimitatoare: rows([
      { name: "Ambulanță SAJ", type: "Ambulanță" },
      { name: "Cabinet medic familie", type: "MF" },
      { name: "Alt spital", type: "Transfer" },
      { name: "Prezentare directă", type: "Direct" }
    ]),
    alte_servicii: rows([
      { name: "Consultație specialitate", price: "150", editable: "da" },
      { name: "Pansament", price: "40", editable: "da" }
    ]),
    proceduri: rows([
      { name: "ECG", code: "ECG", group: "Cardiologie" },
      { name: "Ecografie cardiacă", code: "ECO-C", group: "Cardiologie" },
      { name: "Spirometrie", code: "SPIRO", group: "Pneumologie" }
    ]),
    grupe_dx_oms: rows([
      { code: "I00-I99", name: "Boli ale aparatului circulator" },
      { code: "J00-J99", name: "Boli ale aparatului respirator" },
      { code: "K00-K93", name: "Boli digestive" }
    ]),
    icd10am: rows([
      { code: "I21.4", name: "Infarct miocardic acut subendocardic" },
      { code: "I50.0", name: "Insuficiență cardiacă congestivă" },
      { code: "J18.9", name: "Pneumonie, nespecificată" },
      { code: "J44.1", name: "BPOC cu exacerbare acută" },
      { code: "K35.8", name: "Apendicită acută" }
    ]),
    achi: rows([
      { code: "92203-00", name: "ECG de repaus" },
      { code: "55113-00", name: "Ecografie cardiacă" },
      { code: "30520-00", name: "Apendicectomie" }
    ]),
    dci_medicamente: rows([
      { dci: "Bisoprolol", form: "comprimate", strength: "5 mg" },
      { dci: "Ceftriaxonă", form: "pulbere injectabilă", strength: "1 g" },
      { dci: "Enoxaparină", form: "seringă preumplută", strength: "40 mg/0,4 ml" },
      { dci: "Ser fiziologic", form: "soluție perfuzabilă", strength: "500 ml" }
    ])
  };
}

export function nomOptions(noms, id, valueKey = "name") {
  const list = (noms && noms[id]) || [];
  return list.map((r) => r[valueKey]).filter(Boolean);
}

export function catalogOf(id) {
  return NOMENCLATOR_CATALOG.find((c) => c.id === id) || NOMENCLATOR_CATALOG[0];
}
