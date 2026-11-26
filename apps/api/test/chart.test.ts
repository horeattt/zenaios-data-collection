import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp, type AppConfig } from "../src/app.js";
import { openPglite, type Db } from "../src/db.js";
import { migrate } from "../src/migrate.js";

let dir = "";
let db: Db;
let app: FastifyInstance;
const config: AppConfig = {
  aiDataKey: randomBytes(32),
  provisionToken: "",
  cookieSecure: false,
  logs: [],
  openAccess: true
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "zenaios-chart-"));
  db = await openPglite(dir);
  await migrate(db);
  app = await buildApp(db, config);
});

afterAll(async () => {
  await app.close();
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("foaie clinică modulară", () => {
  it("asigură pacientul, salvează notă și citește chart", async () => {
    const open = await app.inject({ method: "POST", url: "/api/auth/open", payload: {} });
    expect(open.statusCode).toBe(200);
    const cookie = cookieOf(open);

    const building = await app.inject({ method: "POST", url: "/api/buildings", headers: { cookie }, payload: { name: "A" } });
    const department = await app.inject({
      method: "POST", url: "/api/departments", headers: { cookie },
      payload: { buildingId: (building.json() as { id: string }).id, name: "Clinic", kind: "clinical" }
    });
    const ward = await app.inject({
      method: "POST", url: "/api/wards", headers: { cookie },
      payload: { departmentId: (department.json() as { id: string }).id, name: "Cardiologie" }
    });
    const room = await app.inject({
      method: "POST", url: "/api/rooms", headers: { cookie },
      payload: { wardId: (ward.json() as { id: string }).id, name: "S1" }
    });
    await app.inject({
      method: "POST", url: "/api/beds", headers: { cookie },
      payload: { roomId: (room.json() as { id: string }).id, label: "Pat 1" }
    });

    const ensured = await app.inject({
      method: "POST", url: "/api/chart/ensure", headers: { cookie },
      payload: {
        wardId: (ward.json() as { id: string }).id,
        firstName: "Maria",
        lastName: "Ionescu",
        sex: "F",
        localKey: "ward:cardio:patient:demo-1",
        diagnosis: "I21.4 Infarct",
        pathway: "direct"
      }
    });
    expect(ensured.statusCode).toBe(200);
    const ids = ensured.json() as { patientId: string; encounterId: string; admissionId: string };

    const note = await app.inject({
      method: "POST", url: "/api/notes", headers: { cookie },
      payload: { encounterId: ids.encounterId, kind: "evolution", body: "Evoluție favorabilă." }
    });
    expect(note.statusCode).toBe(200);

    const chart = await app.inject({
      method: "GET", url: `/api/patients/${ids.patientId}/chart`, headers: { cookie }
    });
    expect(chart.statusCode).toBe(200);
    const body = chart.json() as { notes: { body: string }[]; diagnoses: { display: string }[]; admission: { id: string } };
    expect(body.admission.id).toBe(ids.admissionId);
    expect(body.notes.some((n) => n.body.includes("favorabilă"))).toBe(true);
    expect(body.diagnoses[0]?.display).toContain("Infarct");

    const again = await app.inject({
      method: "POST", url: "/api/chart/ensure", headers: { cookie },
      payload: {
        wardId: (ward.json() as { id: string }).id,
        firstName: "Maria",
        lastName: "Ionescu",
        localKey: "ward:cardio:patient:demo-1",
        pathway: "direct"
      }
    });
    expect(again.json()).toMatchObject({ patientId: ids.patientId, reused: true });
  });
});

function cookieOf(response: { headers: object }): string {
  const raw = (response.headers as { "set-cookie"?: string | string[] })["set-cookie"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) throw new Error("no cookie");
  return value.split(";")[0] ?? value;
}
