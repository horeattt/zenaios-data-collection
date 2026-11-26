import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import ExcelJS from "exceljs";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import { assertWardInScope, canReadPatient, loadWardScopeIds, parsePage } from "./access.js";
import { newId, writeAudit } from "./audit.js";
import { listBedsForWard, listWardBoard } from "./board.js";
import { loadPatientChart } from "./chart.js";
import type { Db } from "./db.js";
import { assertSafeSpec, CODE_EXECUTION, interpretConfigure, specChecksum, type DeclarativeSpec } from "./extensions.js";
import { dispatchHeldLis } from "./lis.js";
import { runLogicalBackup, runPgDumpBackup } from "./ops.js";
import { resolveAppDirs, type AppDirs } from "./paths.js";
import { registerAppointmentRoutes } from "./appointments.js";
import { registerModuleConfigRoutes } from "./module-config.js";
import { registerPilotRoutes } from "./pilot.js";
import { provisionHospital } from "./provision.js";
import { assertAllowedHost, probeProvider, type ProviderName } from "./providers.js";
import { ADMISSIONS_REPORT, admissionsByWard, parseReportIntent, previousCalendarMonth } from "./reports.js";
import { decryptString, encryptString, hashPassword, newSecret, redact, safeEqual, sha256, verifyPassword } from "./security.js";
import { applyZenaAdminCommand } from "./zena-admin.js";

export type SessionUser = {
  id: string;
  hospitalId: string | null;
  username: string;
  displayName: string;
  mustChange: boolean;
  permissions: Set<string>;
  /** null = acces pe toate secțiile spitalului */
  wardScopeIds: string[] | null;
};

type Authed = FastifyRequest & { user: SessionUser | null };

export type AppConfig = {
  aiDataKey: Buffer | null;
  provisionToken: string;
  cookieSecure: boolean;
  logs: string[];
  now?: () => Date;
  https?: { key: Buffer; cert: Buffer };
  /** Doar dezvoltare: intrare fără parolă. Interzis în producție. */
  openAccess?: boolean;
  dirs?: AppDirs;
};

const openPaths = new Set([
  "/api/health",
  "/api/setup",
  "/api/auth/login",
  "/api/auth/open",
  "/api/openapi.json",
  "/api/platform/hospitals"
]);

export async function buildApp(db: Db, config: AppConfig): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    bodyLimit: 16 * 1024 * 1024,
    ...(config.https ? { https: config.https } : {})
  });
  await app.register(cookie);
  const registry: { method: string; url: string; permission?: string }[] = [];

  app.addHook("onRequest", async (request) => {
    (request as Authed).user = await loadUser(db, request.cookies.zenaios_session);
  });

  app.addHook("preHandler", async (request, reply) => {
    const url = request.url.split("?")[0];
    if (!url.startsWith("/api/") || openPaths.has(url)) return;
    const user = (request as Authed).user;
    if (!user) return reply.code(401).send({ error: "unauthenticated" });
    if (user.mustChange && !["/api/auth/change-password", "/api/auth/logout", "/api/auth/me"].includes(url)) {
      return reply.code(403).send({ error: "password_change_required" });
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    const named = error instanceof Error ? error.name : "";
    const explicit = (error as { statusCode?: number }).statusCode;
    const code = (error as { code?: string }).code;
    const pgCode = (error as { code?: string }).code;
    let status = explicit ?? (named === "ZodError" ? 422 : 500);
    let message = error instanceof Error ? error.message : "Eroare.";
    let errCode = code && !/^\d+$/.test(code) ? code : (status === 422 ? "invalid" : "error");
    // Concurență / unicitate PostgreSQL → mesaje de flux, nu 500
    if (pgCode === "23505") {
      status = 409;
      const detail = String((error as { detail?: string; constraint?: string }).constraint || (error as { detail?: string }).detail || "");
      if (/one_active_occupant_per_bed|bed/i.test(detail)) {
        errCode = "bed_occupied";
        message = "Patul este ocupat.";
      } else if (/patient_identifier|cnp/i.test(detail)) {
        errCode = "cnp_exists";
        message = "CNP-ul există deja în dosar.";
      } else if (/admissions_file_no/i.test(detail)) {
        errCode = "file_no_exists";
        message = "Numărul de foaie există deja.";
      } else {
        errCode = "conflict";
        message = "Înregistrarea există deja.";
      }
    }
    log(config, status >= 500 ? "server_error" : "request_error", { status, message: redact(message), errCode });
    reply.code(status).send({
      error: errCode,
      code: errCode,
      message: status >= 500 ? "Eroare internă." : named === "ZodError" ? "Date invalide." : message
    });
  });

  const route = (method: "get" | "post" | "put" | "delete", url: string, permission: string | undefined, handler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) => {
    registry.push({ method: method.toUpperCase(), url, permission });
    app[method](url, async (request, reply) => {
      if (permission) {
        const user = (request as Authed).user;
        if (!user?.permissions.has(permission)) return reply.code(403).send({ error: "forbidden", permission });
      }
      return handler(request, reply);
    });
  };

  route("get", "/api/health", undefined, async () => {
    const dbOk = await db.query("SELECT 1 AS ok");
    return { ok: true, database: dbOk.length === 1, ai: config.aiDataKey ? "key_present" : "disabled", syntheticDataInProduction: false };
  });

  const dirs = config.dirs ?? resolveAppDirs();

  route("get", "/api/openapi.json", undefined, async () => ({
    openapi: "3.0.3",
    info: { title: "ZenAIOS Hospital OS", version: "0.4.0-pilot" },
    paths: Object.fromEntries(registry.map((item) => {
      const path = item.url.replace(/:([A-Za-z]+)/g, "{$1}");
      return [path, { [item.method.toLowerCase()]: { summary: item.permission ?? "public", responses: { "200": { description: "Răspuns" } } } }];
    }))
  }));

  route("post", "/api/setup", undefined, async (request) => {
    const count = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM hospitals");
    if (Number(count[0]?.n) > 0) fail(409, "Instalarea este deja inițializată.");
    const body = z.object({
      hospitalName: z.string().min(2).max(160),
      adminUsername: z.string().min(3).max(60),
      adminDisplayName: z.string().min(2).max(120),
      timezone: z.string().min(1).max(80).optional()
    }).parse(request.body);
    const created = await provisionHospital(db, {
      name: body.hospitalName,
      adminUsername: body.adminUsername,
      adminDisplayName: body.adminDisplayName,
      timezone: body.timezone
    });
    return { hospitalId: created.hospitalId, username: created.username, oneTimePassword: created.password, passwordChangeRequired: true };
  });

  route("post", "/api/platform/hospitals", undefined, async (request) => {
    if (!config.provisionToken) fail(503, "PROVISION_TOKEN nu este configurat.");
    const header = String(request.headers["x-provision-token"] ?? "");
    if (!safeEqual(header, config.provisionToken)) fail(403, "Provizionare refuzată.");
    const body = z.object({
      hospitalName: z.string().min(2).max(160),
      adminUsername: z.string().min(3).max(60),
      adminDisplayName: z.string().min(2).max(120),
      timezone: z.string().min(1).max(80).optional()
    }).parse(request.body);
    const created = await provisionHospital(db, {
      name: body.hospitalName,
      adminUsername: body.adminUsername,
      adminDisplayName: body.adminDisplayName,
      timezone: body.timezone
    });
    log(config, "hospital_provisioned", { hospitalId: created.hospitalId });
    return { hospitalId: created.hospitalId, username: created.username, oneTimePassword: created.password, passwordChangeRequired: true };
  });

  route("post", "/api/auth/open", undefined, async (request, reply) => {
    if (!config.openAccess) fail(403, "Accesul deschis este oprit.");
    let hospitals = await db.query<{ id: string }>("SELECT id FROM hospitals ORDER BY created_at LIMIT 1");
    if (!hospitals[0]) {
      await provisionHospital(db, {
        name: "Spital demonstrație",
        adminUsername: "demo",
        adminDisplayName: "Demo ZenAIOS",
        synthetic: true
      });
      hospitals = await db.query<{ id: string }>("SELECT id FROM hospitals ORDER BY created_at LIMIT 1");
    }
    const hospitalId = hospitals[0]!.id;
    let users = await db.query<{ id: string }>(
      `SELECT u.id FROM users u
       JOIN user_roles ur ON ur.user_id = u.id
       JOIN roles r ON r.id = ur.role_id
       WHERE u.hospital_id = $1 AND u.active AND r.code = 'admin'
       ORDER BY u.created_at LIMIT 1`,
      [hospitalId]
    );
    if (!users[0]) {
      users = await db.query<{ id: string }>(
        "SELECT id FROM users WHERE hospital_id = $1 AND active ORDER BY created_at LIMIT 1",
        [hospitalId]
      );
    }
    if (!users[0]) fail(500, "Nu există utilizator pentru acces deschis.");
    await db.query("UPDATE users SET password_must_change = false WHERE id = $1", [users[0].id]);
    const wardCount = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM wards WHERE hospital_id = $1", [hospitalId]);
    if (Number(wardCount[0]?.n ?? 0) === 0) {
      const buildingId = newId();
      const departmentId = newId();
      const wardId = newId();
      const roomId = newId();
      await db.query("INSERT INTO buildings (id, hospital_id, name) VALUES ($1, $2, $3)", [buildingId, hospitalId, "Pavilion A"]);
      await db.query(
        "INSERT INTO departments (id, hospital_id, building_id, name, kind) VALUES ($1, $2, $3, $4, 'clinical')",
        [departmentId, hospitalId, buildingId, "Medical"]
      );
      await db.query(
        "INSERT INTO wards (id, hospital_id, department_id, name, specialty) VALUES ($1, $2, $3, $4, $5)",
        [wardId, hospitalId, departmentId, "Medicină internă", "Internă"]
      );
      await db.query("INSERT INTO rooms (id, hospital_id, ward_id, name) VALUES ($1, $2, $3, $4)", [roomId, hospitalId, wardId, "Salon 1"]);
      for (let i = 1; i <= 8; i++) {
        await db.query("INSERT INTO beds (id, hospital_id, room_id, label) VALUES ($1, $2, $3, $4)", [newId(), hospitalId, roomId, `Pat ${i}`]);
      }
    }
    const token = newSecret(32);
    const sessionId = newId();
    await db.query(
      "INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, now() + interval '12 hours')",
      [sessionId, users[0].id, sha256(token)]
    );
    reply.setCookie("zenaios_session", token, { httpOnly: true, sameSite: "lax", path: "/", secure: config.cookieSecure });
    await db.tx((q) => writeAudit(q, {
      hospitalId,
      actorUserId: users[0]!.id,
      action: "open_access",
      entityType: "session",
      entityId: sessionId,
      summary: "Intrare fără parolă (mod demonstrație)."
    }));
    const user = await loadUser(db, token);
    if (!user) fail(500, "Sesiunea deschisă nu a putut fi încărcată.");
    return publicUser(user);
  });

  route("post", "/api/auth/login", undefined, async (request, reply) => {
    const body = z.object({ username: z.string(), password: z.string(), hospitalId: z.string().uuid().optional() }).parse(request.body);
    const params: unknown[] = [body.username];
    let where = "lower(username) = lower($1) AND active";
    if (body.hospitalId) {
      params.push(body.hospitalId);
      where += ` AND hospital_id = $2`;
    }
    const users = await db.query<{ id: string; hospital_id: string | null; password_hash: string }>(
      `SELECT id, hospital_id, password_hash FROM users WHERE ${where}`,
      params
    );
    const user = users[0];
    const valid = user ? await verifyPassword(body.password, user.password_hash) : false;
    if (!user || !valid) {
      await db.tx((q) => writeAudit(q, { hospitalId: body.hospitalId ?? null, actorUserId: null, action: "login_failed", entityType: "session", summary: "Autentificare eșuată." }));
      fail(401, "Utilizator sau parolă incorectă.");
    }
    const token = newSecret(32);
    const sessionId = newId();
    await db.query(
      "INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, now() + interval '12 hours')",
      [sessionId, user.id, sha256(token)]
    );
    reply.setCookie("zenaios_session", token, { httpOnly: true, sameSite: "lax", path: "/", secure: config.cookieSecure });
    await db.tx((q) => writeAudit(q, { hospitalId: user.hospital_id, actorUserId: user.id, action: "login", entityType: "session", entityId: sessionId, summary: "Autentificare reușită." }));
    return { ok: true };
  });

  route("post", "/api/auth/logout", undefined, async (request, reply) => {
    const token = request.cookies.zenaios_session;
    if (token) await db.query("DELETE FROM sessions WHERE token_hash = $1", [sha256(token)]);
    reply.clearCookie("zenaios_session", { path: "/" });
    return { ok: true };
  });

  route("get", "/api/auth/me", undefined, async (request) => {
    const user = (request as Authed).user;
    if (!user) fail(401, "Neautentificat.");
    return publicUser(user);
  });

  route("post", "/api/auth/change-password", undefined, async (request) => {
    const user = requireUser(request);
    const body = z.object({ password: z.string().min(12).max(200) }).parse(request.body);
    const passwordHash = await hashPassword(body.password);
    await db.query("UPDATE users SET password_hash = $2, password_must_change = false WHERE id = $1", [user.id, passwordHash]);
    await db.tx((q) => writeAudit(q, { hospitalId: user.hospitalId, actorUserId: user.id, action: "password_change", entityType: "user", entityId: user.id, summary: "Parola a fost schimbată." }));
    return { ok: true };
  });

  route("get", "/api/structure", "structure.read", async (request) => {
    const hospitalId = requireHospital(request);
    const [hospital, buildings, departments, wards, rooms, beds] = await Promise.all([
      db.query("SELECT id, name, timezone, country_code FROM hospitals WHERE id = $1", [hospitalId]),
      db.query("SELECT id, name FROM buildings WHERE hospital_id = $1 ORDER BY name", [hospitalId]),
      db.query("SELECT id, building_id, name, kind FROM departments WHERE hospital_id = $1 ORDER BY name", [hospitalId]),
      db.query("SELECT id, department_id, name, specialty FROM wards WHERE hospital_id = $1 ORDER BY name", [hospitalId]),
      db.query("SELECT id, ward_id, name FROM rooms WHERE hospital_id = $1 ORDER BY name", [hospitalId]),
      db.query("SELECT id, room_id, label, status FROM beds WHERE hospital_id = $1 ORDER BY label", [hospitalId])
    ]);
    return { hospital: hospital[0], buildings, departments, wards, rooms, beds };
  });

  route("post", "/api/buildings", "structure.write", async (request) => {
    const hospitalId = requireHospital(request);
    const body = z.object({ name: z.string().min(1).max(120) }).parse(request.body);
    const id = newId();
    await db.query("INSERT INTO buildings (id, hospital_id, name) VALUES ($1, $2, $3)", [id, hospitalId, body.name]);
    return { id };
  });

  route("post", "/api/departments", "structure.write", async (request) => {
    const hospitalId = requireHospital(request);
    const body = z.object({ buildingId: z.string().uuid(), name: z.string().min(1), kind: z.enum(["clinical", "support"]) }).parse(request.body);
    await mustOwn(db, "buildings", body.buildingId, hospitalId);
    const id = newId();
    await db.query("INSERT INTO departments (id, hospital_id, building_id, name, kind) VALUES ($1, $2, $3, $4, $5)", [id, hospitalId, body.buildingId, body.name, body.kind]);
    return { id };
  });

  route("post", "/api/wards", "structure.write", async (request) => {
    const hospitalId = requireHospital(request);
    const body = z.object({ departmentId: z.string().uuid(), name: z.string().min(1), specialty: z.string().max(120).optional() }).parse(request.body);
    await mustOwn(db, "departments", body.departmentId, hospitalId);
    const id = newId();
    await db.query("INSERT INTO wards (id, hospital_id, department_id, name, specialty) VALUES ($1, $2, $3, $4, $5)", [id, hospitalId, body.departmentId, body.name, body.specialty ?? null]);
    return { id };
  });

  route("post", "/api/rooms", "structure.write", async (request) => {
    const hospitalId = requireHospital(request);
    const body = z.object({ wardId: z.string().uuid(), name: z.string().min(1) }).parse(request.body);
    await mustOwn(db, "wards", body.wardId, hospitalId);
    const id = newId();
    await db.query("INSERT INTO rooms (id, hospital_id, ward_id, name) VALUES ($1, $2, $3, $4)", [id, hospitalId, body.wardId, body.name]);
    return { id };
  });

  route("post", "/api/beds", "structure.write", async (request) => {
    const hospitalId = requireHospital(request);
    const body = z.object({ roomId: z.string().uuid(), label: z.string().min(1) }).parse(request.body);
    await mustOwn(db, "rooms", body.roomId, hospitalId);
    const id = newId();
    await db.query("INSERT INTO beds (id, hospital_id, room_id, label) VALUES ($1, $2, $3, $4)", [id, hospitalId, body.roomId, body.label]);
    return { id };
  });

  route("post", "/api/users", "user.admin", async (request) => {
    const actor = requireUser(request);
    const hospitalId = requireHospital(request);
    const body = z.object({
      username: z.string().min(3),
      displayName: z.string().min(2),
      roleCode: z.enum(["physician", "nurse", "lab", "ward_chief", "hr", "auditor", "admin"])
    }).parse(request.body);
    const roles = await db.query<{ id: string }>("SELECT id FROM roles WHERE hospital_id = $1 AND code = $2", [hospitalId, body.roleCode]);
    if (!roles[0]) fail(404, "Rolul nu există în acest spital.");
    const password = newSecret();
    const id = newId();
    await db.query(
      `INSERT INTO users (id, hospital_id, username, password_hash, password_must_change, display_name)
       VALUES ($1, $2, $3, $4, true, $5)`,
      [id, hospitalId, body.username, await hashPassword(password), body.displayName]
    );
    await db.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)", [id, roles[0].id]);
    await db.tx((q) => writeAudit(q, { hospitalId, actorUserId: actor.id, action: "create", entityType: "user", entityId: id, summary: `Utilizator creat cu rolul ${body.roleCode}.` }));
    return { id, username: body.username, oneTimePassword: password, passwordChangeRequired: true };
  });

  route("post", "/api/upu/presentations", "encounter.write", async (request) => {
    const actor = requireUser(request);
    const hospitalId = requireHospital(request);
    const body = z.object({
      unidentified: z.boolean().default(false),
      patientId: z.string().uuid().optional(),
      firstName: z.string().min(1).optional(),
      lastName: z.string().min(1).optional(),
      birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      sex: z.enum(["F", "M", "necunoscut"]).optional(),
      triageCode: z.enum(["rosu", "galben", "verde", "albastru"]),
      location: z.string().min(1).max(80)
    }).parse(request.body);
    return db.tx(async (q) => {
      let patientId = body.patientId;
      if (patientId) await mustOwn(q, "patients", patientId, hospitalId);
      else {
        patientId = newId();
        await q.query(
          `INSERT INTO patients (id, hospital_id, first_name, last_name, birth_date, sex, identified)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [patientId, hospitalId, body.firstName ?? "Necunoscut", body.lastName ?? "Necunoscut", body.birthDate ?? null, body.sex ?? "necunoscut", !body.unidentified && Boolean(body.firstName)]
        );
        if (body.unidentified || !body.firstName) {
          await q.query(
            "INSERT INTO patient_identifiers (id, hospital_id, patient_id, system, value) VALUES ($1, $2, $3, 'urn:zenaios:temp', $4)",
            [newId(), hospitalId, patientId, newSecret(8)]
          );
        }
      }
      const encounterId = newId();
      await q.query(
        `INSERT INTO encounters (id, hospital_id, patient_id, class, status, started_at)
         VALUES ($1, $2, $3, 'emergency', 'in_progress', now())`,
        [encounterId, hospitalId, patientId]
      );
      await q.query(
        `INSERT INTO clinical_notes (id, hospital_id, patient_id, encounter_id, kind, body, author_user_id)
         VALUES ($1, $2, $3, $4, 'triage', $5, $6)`,
        [newId(), hospitalId, patientId, encounterId, `Triaj ${body.triageCode}. Locație: ${body.location}.`, actor.id]
      );
      const upuId = newId();
      await q.query(
        `INSERT INTO upu_presentations (id, hospital_id, patient_id, encounter_id, triage_code, location, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'waiting')`,
        [upuId, hospitalId, patientId, encounterId, body.triageCode, body.location]
      );
      await writeAudit(q, { hospitalId, actorUserId: actor.id, action: "create", entityType: "encounter", entityId: encounterId, summary: "Prezentare UPU înregistrată." });
      return { patientId, encounterId, upuId };
    });
  });

  route("post", "/api/patients", "patient.write", async (request) => {
    const actor = requireUser(request);
    const hospitalId = requireHospital(request);
    const body = z.object({
      firstName: z.string().min(1),
      lastName: z.string().min(1),
      birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      sex: z.enum(["F", "M", "necunoscut"]).optional(),
      identified: z.boolean().default(true),
      cnp: z.string().regex(/^\d{13}$/).optional()
    }).parse(request.body);
    const id = newId();
    await db.tx(async (q) => {
      await q.query(
        `INSERT INTO patients (id, hospital_id, first_name, last_name, birth_date, sex, identified)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, hospitalId, body.firstName, body.lastName, body.birthDate ?? null, body.sex ?? null, body.identified]
      );
      if (body.cnp) {
        await q.query(
          "INSERT INTO patient_identifiers (id, hospital_id, patient_id, system, value) VALUES ($1, $2, $3, 'urn:cnas:cnp', $4)",
          [newId(), hospitalId, id, body.cnp]
        );
      }
      await writeAudit(q, { hospitalId, actorUserId: actor.id, action: "create", entityType: "patient", entityId: id, summary: body.identified ? "Pacient identificat creat." : "Pacient neidentificat creat." });
    });
    return { id };
  });

  route("get", "/api/patients", "patient.read", async (request) => {
    const hospitalId = requireHospital(request);
    const query = request.query as { q?: string };
    const term = (query.q ?? "").trim();
    if (!term) return db.query("SELECT id, first_name, last_name, birth_date, sex, identified FROM patients WHERE hospital_id = $1 ORDER BY last_name, first_name LIMIT 50", [hospitalId]);
    return db.query(
      `SELECT id, first_name, last_name, birth_date, sex, identified FROM patients p
       WHERE hospital_id = $1 AND (
         position(lower($2) in lower(last_name)) > 0 OR position(lower($2) in lower(first_name)) > 0
         OR EXISTS (SELECT 1 FROM patient_identifiers i WHERE i.patient_id = p.id AND i.hospital_id = p.hospital_id AND i.value = $2)
       )
       ORDER BY last_name LIMIT 50`,
      [hospitalId, term]
    );
  });

  route("get", "/api/patients/candidates", "patient.read", async (request) => {
    const hospitalId = requireHospital(request);
    const query = z.object({ lastName: z.string().min(1), birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(request.query);
    return db.query(
      `SELECT id, first_name, last_name, birth_date FROM patients
       WHERE hospital_id = $1 AND lower(last_name) = lower($2) AND birth_date = $3`,
      [hospitalId, query.lastName, query.birthDate]
    );
  });

  route("get", "/api/patients/:id", "patient.read", async (request) => {
    const actor = requireUser(request);
    const hospitalId = requireHospital(request);
    const id = param(request, "id");
    const access = await canReadPatient(db, hospitalId, actor.id, id, actor.permissions);
    if (!access.allowed) {
      if (!actor.permissions.has("care.break_glass")) fail(403, "Pacientul nu este în domeniul sau echipa ta.");
      const reason = z.object({ reason: z.string().min(8).max(400) }).safeParse(request.query);
      if (!reason.success) fail(403, "Acces de urgență: trimite ?reason=... (min. 8 caractere).");
      await db.query(
        "INSERT INTO emergency_access_events (id, hospital_id, actor_user_id, patient_id, reason) VALUES ($1,$2,$3,$4,$5)",
        [newId(), hospitalId, actor.id, id, reason.data.reason]
      );
      await db.tx((q) => writeAudit(q, {
        hospitalId, actorUserId: actor.id, action: "break_glass", entityType: "patient", entityId: id,
        summary: "Acces de urgență auditat în afara echipei/secției."
      }));
    }
    const patient = await one<Record<string, unknown>>(db, "SELECT * FROM patients WHERE id = $1 AND hospital_id = $2", [id, hospitalId]);
    const identifiers = await db.query("SELECT system, value FROM patient_identifiers WHERE patient_id = $1 AND hospital_id = $2", [id, hospitalId]);
    await db.tx((q) => writeAudit(q, { hospitalId, actorUserId: actor.id, action: "read", entityType: "patient", entityId: id, summary: `Dosar deschis (${access.via}).` }));
    return { ...patient, identifiers, accessVia: access.allowed ? access.via : "break_glass" };
  });

  route("post", "/api/patients/:id/identify", "patient.write", async (request) => {
    const actor = requireUser(request);
    const hospitalId = requireHospital(request);
    const id = param(request, "id");
    const body = z.object({
      firstName: z.string().min(1),
      lastName: z.string().min(1),
      birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      cnp: z.string().regex(/^\d{13}$/).optional()
    }).parse(request.body);
    await mustOwn(db, "patients", id, hospitalId);
    await db.tx(async (q) => {
      await q.query(
        "UPDATE patients SET first_name = $3, last_name = $4, birth_date = COALESCE($5, birth_date), identified = true WHERE id = $1 AND hospital_id = $2",
        [id, hospitalId, body.firstName, body.lastName, body.birthDate ?? null]
      );
      if (body.cnp) {
        await q.query(
          "INSERT INTO patient_identifiers (id, hospital_id, patient_id, system, value) VALUES ($1, $2, $3, 'urn:cnas:cnp', $4)",
          [newId(), hospitalId, id, body.cnp]
        );
      }
      await writeAudit(q, { hospitalId, actorUserId: actor.id, action: "update", entityType: "patient", entityId: id, summary: "Pacient identificat ulterior. Identificatorul intern a rămas același." });
    });
    return { id };
  });

  route("get", "/fhir/R4/Patient/:id", "patient.read", async (request) => {
    const hospitalId = requireHospital(request);
    const id = param(request, "id");
    const patient = await one<{ id: string; first_name: string; last_name: string; birth_date: string | null; sex: string | null }>(
      db, "SELECT id, first_name, last_name, birth_date, sex FROM patients WHERE id = $1 AND hospital_id = $2", [id, hospitalId]
    );
    const identifiers = await db.query<{ system: string; value: string }>("SELECT system, value FROM patient_identifiers WHERE patient_id = $1 AND hospital_id = $2", [id, hospitalId]);
    return {
      resourceType: "Patient",
      id: patient.id,
      identifier: identifiers.map((item) => ({ system: item.system, value: item.value })),
      name: [{ family: patient.last_name, given: [patient.first_name] }],
      birthDate: patient.birth_date,
      gender: patient.sex === "F" ? "female" : patient.sex === "M" ? "male" : "unknown"
    };
  });

  route("post", "/api/encounters/:id/admit", "encounter.write", async (request) => {
    const actor = requireUser(request);
    const hospitalId = requireHospital(request);
    const sourceId = param(request, "id");
    const body = z.object({ wardId: z.string().uuid(), bedId: z.string().uuid() }).parse(request.body);
    return db.tx(async (q) => {
      const source = await one<{ id: string; patient_id: string; class: string; status: string }>(
        q, "SELECT id, patient_id, class, status FROM encounters WHERE id = $1 AND hospital_id = $2", [sourceId, hospitalId]
      );
      if (source.class !== "emergency" || source.status !== "in_progress") fail(409, "Doar o prezentare UPU deschisă poate fi internată.");
      await mustOwn(q, "wards", body.wardId, hospitalId);
      const bed = await one<{ id: string }>(
        q,
        `SELECT b.id FROM beds b
         JOIN rooms r ON r.id = b.room_id
         LEFT JOIN admissions a ON a.bed_id = b.id AND a.hospital_id = b.hospital_id AND a.status = 'active'
         WHERE b.id = $1 AND b.hospital_id = $2 AND r.ward_id = $3 AND b.status = 'open' AND a.id IS NULL`,
        [body.bedId, hospitalId, body.wardId]
      );
      const encounterId = newId();
      const admissionId = newId();
      await q.query("UPDATE encounters SET status = 'finished', ended_at = now() WHERE id = $1 AND hospital_id = $2", [sourceId, hospitalId]);
      await q.query(
        `INSERT INTO encounters (id, hospital_id, patient_id, part_of_id, class, status, started_at)
         VALUES ($1, $2, $3, $4, 'inpatient', 'in_progress', now())`,
        [encounterId, hospitalId, source.patient_id, sourceId]
      );
      await q.query(
        `INSERT INTO admissions (id, hospital_id, encounter_id, patient_id, admitting_ward_id, current_ward_id, bed_id, started_at, status)
         VALUES ($1, $2, $3, $4, $5, $5, $6, now(), 'active')`,
        [admissionId, hospitalId, encounterId, source.patient_id, body.wardId, body.bedId]
      );
      await q.query(
        `UPDATE upu_presentations SET status = 'admitted', updated_at = now()
         WHERE encounter_id = $1 AND hospital_id = $2 AND status IN ('waiting', 'in_care')`,
        [sourceId, hospitalId]
      );
      await writeAudit(q, { hospitalId, actorUserId: actor.id, action: "create", entityType: "admission", entityId: admissionId, summary: "Internare din UPU pentru același pacient." });
      return { patientId: source.patient_id, encounterId, admissionId, pathway: "upu" };
    });
  });

  route("post", "/api/admissions/:id/transfer", "encounter.write", async (request) => {
    const actor = requireUser(request);
    const hospitalId = requireHospital(request);
    const admissionId = param(request, "id");
    const body = z.object({
      wardId: z.string().uuid(),
      bedId: z.string().uuid(),
      note: z.string().min(8).max(2000)
    }).parse(request.body);
    return db.tx(async (q) => {
      const admission = await one<{ id: string; patient_id: string; current_ward_id: string; status: string }>(
        q, "SELECT id, patient_id, current_ward_id, status FROM admissions WHERE id = $1 AND hospital_id = $2", [admissionId, hospitalId]
      );
      if (admission.status !== "active") fail(409, "Internarea nu este activă.");
      await mustOwn(q, "wards", body.wardId, hospitalId);
      await one(q, "SELECT b.id FROM beds b JOIN rooms r ON r.id = b.room_id WHERE b.id = $1 AND b.hospital_id = $2 AND r.ward_id = $3", [body.bedId, hospitalId, body.wardId]);
      const occupied = await q.query(
        `SELECT a.id FROM admissions a
         WHERE a.hospital_id = $1 AND a.bed_id = $2 AND a.status = 'active' AND a.id <> $3
         LIMIT 1`,
        [hospitalId, body.bedId, admissionId]
      );
      if (occupied.length) {
        throw Object.assign(new Error("Patul este ocupat."), { statusCode: 409, code: "bed_occupied" });
      }
      await q.query("UPDATE admissions SET current_ward_id = $3, bed_id = $4 WHERE id = $1 AND hospital_id = $2", [admissionId, hospitalId, body.wardId, body.bedId]);
      const transferId = newId();
      await q.query(
        `INSERT INTO transfers (id, hospital_id, admission_id, patient_id, from_ward_id, to_ward_id, to_bed_id, moved_at, actor_user_id, note, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now(), $8, $9, 'completed')`,
        [transferId, hospitalId, admissionId, admission.patient_id, admission.current_ward_id, body.wardId, body.bedId, actor.id, body.note]
      );
      await q.query(
        `INSERT INTO clinical_notes (id, hospital_id, patient_id, encounter_id, kind, body, author_user_id)
         SELECT $1, $2, $3, a.encounter_id, 'transfer', $4, $5
         FROM admissions a WHERE a.id = $6 AND a.hospital_id = $2`,
        [newId(), hospitalId, admission.patient_id, `Transfer: ${body.note}`, actor.id, admissionId]
      );
      await writeAudit(q, { hospitalId, actorUserId: actor.id, action: "update", entityType: "admission", entityId: admissionId, summary: "Transfer între secții. Internarea inițială rămâne aceeași." });
      return { transferId, patientId: admission.patient_id, code: "ok" };
    });
  });

  route("post", "/api/service-requests", "lab.write", async (request) => {
    const actor = requireUser(request);
    const hospitalId = requireHospital(request);
    const body = z.object({
      encounterId: z.string().uuid(),
      code: z.string().min(1),
      display: z.string().min(1),
      idempotencyKey: z.string().min(4).max(80).optional()
    }).parse(request.body);
    return db.tx(async (q) => {
      if (body.idempotencyKey) {
        const existing = await q.query<{ id: string }>("SELECT id FROM service_requests WHERE hospital_id = $1 AND idempotency_key = $2", [hospitalId, body.idempotencyKey]);
        if (existing[0]) return { id: existing[0].id, idempotent: true };
      }
      const encounter = await one<{ patient_id: string }>(q, "SELECT patient_id FROM encounters WHERE id = $1 AND hospital_id = $2", [body.encounterId, hospitalId]);
      const id = newId();
      await q.query(
        `INSERT INTO service_requests (id, hospital_id, patient_id, encounter_id, category, code, display, status, requester_user_id, idempotency_key)
         VALUES ($1, $2, $3, $4, 'laboratory', $5, $6, 'requested', $7, $8)`,
        [id, hospitalId, encounter.patient_id, body.encounterId, body.code, body.display, actor.id, body.idempotencyKey ?? null]
      );
      await q.query(
        `INSERT INTO integration_outbox (id, hospital_id, idempotency_key, destination, payload, status)
         VALUES ($1, $2, $3, 'lis', $4::jsonb, 'held')`,
        [newId(), hospitalId, body.idempotencyKey ?? id, JSON.stringify({ serviceRequestId: id })]
      );
      await writeAudit(q, { hospitalId, actorUserId: actor.id, action: "create", entityType: "service_request", entityId: id, summary: "Cerere de laborator. Livrarea către LIS este reținută: nu există conector." });
      return { id, patientId: encounter.patient_id, outbox: "held" };
    });
  });

  route("post", "/api/specimens", "lab.write", async (request) => {
    const hospitalId = requireHospital(request);
    const body = z.object({ serviceRequestId: z.string().uuid(), specimenType: z.string().min(1) }).parse(request.body);
    const requestRow = await one<{ patient_id: string }>(db, "SELECT patient_id FROM service_requests WHERE id = $1 AND hospital_id = $2", [body.serviceRequestId, hospitalId]);
    const id = newId();
    await db.query(
      `INSERT INTO specimens (id, hospital_id, patient_id, service_request_id, specimen_type, collected_at, status)
       VALUES ($1, $2, $3, $4, $5, now(), 'collected')`,
      [id, hospitalId, requestRow.patient_id, body.serviceRequestId, body.specimenType]
    );
    await db.query("UPDATE service_requests SET status = 'collected' WHERE id = $1 AND hospital_id = $2 AND status = 'requested'", [body.serviceRequestId, hospitalId]);
    return { id };
  });

  route("post", "/api/observations", "lab.write", async (request) => {
    const actor = requireUser(request);
    const hospitalId = requireHospital(request);
    const body = z.object({
      serviceRequestId: z.string().uuid(),
      specimenId: z.string().uuid(),
      code: z.string().min(1),
      displayName: z.string().min(1),
      valueNumeric: z.number(),
      unit: z.string().min(1),
      referenceLow: z.number(),
      referenceHigh: z.number(),
      method: z.string().max(120).optional(),
      critical: z.boolean().default(false)
    }).parse(request.body);
    const requestRow = await one<{ patient_id: string; encounter_id: string }>(db, "SELECT patient_id, encounter_id FROM service_requests WHERE id = $1 AND hospital_id = $2", [body.serviceRequestId, hospitalId]);
    await mustOwn(db, "specimens", body.specimenId, hospitalId);
    const id = newId();
    await db.query(
      `INSERT INTO observations
        (id, hospital_id, patient_id, encounter_id, service_request_id, specimen_id, code, display_name, value_numeric, unit, reference_low, reference_high, method, status, critical, entered_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'preliminary',$14,$15)`,
      [id, hospitalId, requestRow.patient_id, requestRow.encounter_id, body.serviceRequestId, body.specimenId, body.code, body.displayName, body.valueNumeric, body.unit, body.referenceLow, body.referenceHigh, body.method ?? null, body.critical, actor.id]
    );
    return { id, status: "preliminary" };
  });

  route("post", "/api/observations/:id/validate", "lab.validate", async (request) => {
    const actor = requireUser(request);
    const hospitalId = requireHospital(request);
    const id = param(request, "id");
    return db.tx(async (q) => {
      const observation = await one<{ id: string; patient_id: string; encounter_id: string; service_request_id: string; status: string; critical: boolean; display_name: string }>(
        q, "SELECT id, patient_id, encounter_id, service_request_id, status, critical, display_name FROM observations WHERE id = $1 AND hospital_id = $2", [id, hospitalId]
      );
      if (observation.status !== "preliminary") fail(409, "Doar un rezultat preliminar poate fi validat.");
      await q.query("UPDATE observations SET status = 'final', validated_by = $3, validated_at = now() WHERE id = $1 AND hospital_id = $2", [id, hospitalId, actor.id]);
      const reportId = newId();
      await q.query(
        `INSERT INTO diagnostic_reports (id, hospital_id, patient_id, encounter_id, service_request_id, status, conclusion, author_user_id)
         VALUES ($1, $2, $3, $4, $5, 'final', $6, $7)`,
        [reportId, hospitalId, observation.patient_id, observation.encounter_id, observation.service_request_id, `Rezultat validat: ${observation.display_name}.`, actor.id]
      );
      await q.query("UPDATE service_requests SET status = 'resulted' WHERE id = $1 AND hospital_id = $2", [observation.service_request_id, hospitalId]);
      if (observation.critical) {
        await q.query(
          "INSERT INTO critical_notifications (id, hospital_id, observation_id, status) VALUES ($1, $2, $3, 'open')",
          [newId(), hospitalId, id]
        );
      }
      await writeAudit(q, { hospitalId, actorUserId: actor.id, action: "validate", entityType: "observation", entityId: id, summary: observation.critical ? "Rezultat validat. Valoare critică de notificat." : "Rezultat validat." });
      return { id, reportId, patientId: observation.patient_id };
    });
  });

  route("post", "/api/observations/:id/correct", "lab.validate", async (request) => {
    const actor = requireUser(request);
    const hospitalId = requireHospital(request);
    const id = param(request, "id");
    const body = z.object({ valueNumeric: z.number(), reason: z.string().min(3) }).parse(request.body);
    return db.tx(async (q) => {
      const current = await one<Record<string, unknown>>(q, "SELECT * FROM observations WHERE id = $1 AND hospital_id = $2", [id, hospitalId]);
      const correctedId = newId();
      await q.query(
        `INSERT INTO observations
          (id, hospital_id, patient_id, encounter_id, service_request_id, specimen_id, supersedes_id, code, display_name, value_numeric, unit, reference_low, reference_high, method, status, critical, correction_reason, entered_by, validated_by, validated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'corrected',$15,$16,$17,$17, now())`,
        [correctedId, hospitalId, current.patient_id, current.encounter_id, current.service_request_id, current.specimen_id, id, current.code, current.display_name, body.valueNumeric, current.unit, current.reference_low, current.reference_high, current.method, current.critical, body.reason, actor.id]
      );
      await writeAudit(q, { hospitalId, actorUserId: actor.id, action: "correct", entityType: "observation", entityId: correctedId, summary: "Corecție de rezultat. Valoarea anterioară a rămas." });
      return { id: correctedId, supersedesId: id };
    });
  });

  route("post", "/api/critical-notifications/:id/acknowledge", "lab.read", async (request) => {
    const actor = requireUser(request);
    const hospitalId = requireHospital(request);
    const id = param(request, "id");
    const updated = await db.query(
      "UPDATE critical_notifications SET status = 'acknowledged', acknowledged_by = $3, acknowledged_at = now() WHERE id = $1 AND hospital_id = $2 AND status = 'open' RETURNING id",
      [id, hospitalId, actor.id]
    );
    if (!updated.length) fail(404, "Notificarea nu este deschisă.");
    return { id };
  });

  route("post", "/api/notes", "chart.write", async (request) => {
    const actor = requireUser(request);
    const hospitalId = requireHospital(request);
    const body = z.object({ encounterId: z.string().uuid(), kind: z.string().min(1).max(40), body: z.string().min(1).max(8000) }).parse(request.body);
    const encounter = await one<{ patient_id: string }>(db, "SELECT patient_id FROM encounters WHERE id = $1 AND hospital_id = $2", [body.encounterId, hospitalId]);
    const id = newId();
    await db.query(
      "INSERT INTO clinical_notes (id, hospital_id, patient_id, encounter_id, kind, body, author_user_id) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [id, hospitalId, encounter.patient_id, body.encounterId, body.kind, body.body, actor.id]
    );
    return { id, patientId: encounter.patient_id };
  });

  route("get", "/api/patients/:id/chart", "chart.read", async (request) => {
    const actor = requireUser(request);
    const hospitalId = requireHospital(request);
    const id = param(request, "id");
    const access = await canReadPatient(db, hospitalId, actor.id, id, actor.permissions);
    if (!access.allowed && !actor.permissions.has("care.break_glass")) fail(403, "Pacientul nu este în domeniul sau echipa ta.");
    return loadPatientChart(db, hospitalId, id);
  });

  route("post", "/api/diagnoses", "chart.write", async (request) => {
    const actor = requireUser(request);
    const hospitalId = requireHospital(request);
    const body = z.object({
      encounterId: z.string().uuid(),
      display: z.string().min(1).max(240),
      code: z.string().max(40).optional(),
      rank: z.enum(["principal", "secondary"]).default("principal")
    }).parse(request.body);
    const encounter = await one<{ patient_id: string }>(db, "SELECT patient_id FROM encounters WHERE id = $1 AND hospital_id = $2", [body.encounterId, hospitalId]);
    const id = newId();
    await db.query(
      `INSERT INTO diagnoses (id, hospital_id, patient_id, encounter_id, code, display, rank, author_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, hospitalId, encounter.patient_id, body.encounterId, body.code ?? null, body.display, body.rank, actor.id]
    );
    return { id, patientId: encounter.patient_id };
  });

  route("post", "/api/allergies", "chart.write", async (request) => {
    const actor = requireUser(request);
    const hospitalId = requireHospital(request);
    const body = z.object({
      patientId: z.string().uuid(),
      substance: z.string().min(1).max(160),
      criticality: z.enum(["low", "high", "unable"]).default("unable")
    }).parse(request.body);
    await mustOwn(db, "patients", body.patientId, hospitalId);
    const id = newId();
    await db.query(
      `INSERT INTO allergies (id, hospital_id, patient_id, substance, criticality, author_user_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, hospitalId, body.patientId, body.substance, body.criticality, actor.id]
    );
    return { id };
  });

  route("post", "/api/chart/ensure", "encounter.write", async (request) => {
    const actor = requireUser(request);
    const hospitalId = requireHospital(request);
    const body = z.object({
      wardId: z.string().uuid(),
      bedId: z.string().uuid().optional(),
      firstName: z.string().min(1).max(80),
      lastName: z.string().min(1).max(80),
      sex: z.enum(["F", "M", "necunoscut"]).optional(),
      birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      localKey: z.string().min(1).max(80).optional(),
      diagnosis: z.string().max(240).optional(),
      /** Obligatoriu — softul nu presupune ambulator. */
      pathway: z.enum(["ambulatory", "direct", "upu"]),
      cnp: z.string().regex(/^\d{13}$/).optional(),
      admissionCriterion: z.string().max(120).optional(),
      referralNumber: z.string().max(80).optional(),
      insuranceCategory: z.string().max(120).optional(),
      attendingPhysician: z.string().max(120).optional(),
      allergies: z.string().max(400).optional(),
      bloodGroup: z.string().max(40).optional(),
      address: z.string().max(240).optional(),
      phone: z.string().max(40).optional(),
      kinName: z.string().max(120).optional(),
      kinPhone: z.string().max(40).optional(),
      bodyKg: z.number().positive().max(400).optional(),
      heightCm: z.number().positive().max(300).optional(),
      reason: z.string().max(2000).optional(),
      antecedents: z.string().max(4000).optional(),
      consentAdmit: z.boolean().optional(),
      consentProc: z.boolean().optional()
    }).parse(request.body);
    await mustOwn(db, "wards", body.wardId, hospitalId);
    assertWardInScope(body.wardId, actor.wardScopeIds);
    return db.tx(async (q) => {
      if (body.localKey) {
        const existing = await q.query<{ patient_id: string; admission_id: string; encounter_id: string }>(
          `SELECT i.patient_id, a.id AS admission_id, a.encounter_id
           FROM patient_identifiers i
           JOIN admissions a ON a.patient_id = i.patient_id AND a.hospital_id = i.hospital_id AND a.status = 'active'
           WHERE i.hospital_id = $1 AND i.system = 'urn:zenaios:local' AND i.value = $2
           LIMIT 1`,
          [hospitalId, body.localKey]
        );
        if (existing[0]) {
          return {
            patientId: existing[0].patient_id,
            encounterId: existing[0].encounter_id,
            admissionId: existing[0].admission_id,
            reused: true
          };
        }
      }
      if (body.cnp) {
        const dup = await q.query<{ patient_id: string }>(
          `SELECT patient_id FROM patient_identifiers
           WHERE hospital_id = $1 AND system = 'urn:cnas:cnp' AND value = $2 LIMIT 1`,
          [hospitalId, body.cnp]
        );
        if (dup[0]) {
          throw Object.assign(new Error("CNP-ul există deja. Deschideți dosarul existent."), {
            statusCode: 409,
            code: "cnp_exists"
          });
        }
      }
      let bedId = body.bedId;
      if (bedId) {
        await one(q, "SELECT b.id FROM beds b JOIN rooms r ON r.id = b.room_id WHERE b.id = $1 AND b.hospital_id = $2 AND r.ward_id = $3 AND b.status = 'open'", [bedId, hospitalId, body.wardId]);
        const taken = await q.query(
          `SELECT a.id FROM admissions a WHERE a.hospital_id = $1 AND a.bed_id = $2 AND a.status = 'active' LIMIT 1`,
          [hospitalId, bedId]
        );
        if (taken.length) {
          throw Object.assign(new Error("Patul este ocupat."), { statusCode: 409, code: "bed_occupied" });
        }
      } else {
        const free = await q.query<{ id: string }>(
          `SELECT b.id FROM beds b
           JOIN rooms r ON r.id = b.room_id
           LEFT JOIN admissions a ON a.bed_id = b.id AND a.status = 'active'
           WHERE b.hospital_id = $1 AND r.ward_id = $2 AND b.status = 'open' AND a.id IS NULL
           ORDER BY b.label LIMIT 1`,
          [hospitalId, body.wardId]
        );
        bedId = free[0]?.id;
        if (!bedId) {
          throw Object.assign(new Error("Nu există pat liber pe această secție."), { statusCode: 409, code: "no_free_bed" });
        }
      }
      const year = new Date().getFullYear();
      const seqKey = `fo_${year}`;
      await q.query(
        `INSERT INTO hospital_sequences (hospital_id, seq_key, last_value)
         VALUES ($1, $2, 1)
         ON CONFLICT (hospital_id, seq_key) DO UPDATE SET last_value = hospital_sequences.last_value + 1`,
        [hospitalId, seqKey]
      );
      const seqRows = await q.query<{ last_value: number }>(
        "SELECT last_value FROM hospital_sequences WHERE hospital_id = $1 AND seq_key = $2",
        [hospitalId, seqKey]
      );
      const fileNo = `FO-${year}-${String(seqRows[0]?.last_value || 1).padStart(6, "0")}`;
      const patientId = newId();
      const encounterId = newId();
      const admissionId = newId();
      await q.query(
        `INSERT INTO patients (id, hospital_id, first_name, last_name, birth_date, sex, identified)
         VALUES ($1, $2, $3, $4, $5, $6, true)`,
        [patientId, hospitalId, body.firstName, body.lastName, body.birthDate ?? null, body.sex ?? "necunoscut"]
      );
      if (body.localKey) {
        await q.query(
          "INSERT INTO patient_identifiers (id, hospital_id, patient_id, system, value) VALUES ($1, $2, $3, 'urn:zenaios:local', $4)",
          [newId(), hospitalId, patientId, body.localKey]
        );
      }
      if (body.cnp) {
        await q.query(
          "INSERT INTO patient_identifiers (id, hospital_id, patient_id, system, value) VALUES ($1, $2, $3, 'urn:cnas:cnp', $4)",
          [newId(), hospitalId, patientId, body.cnp]
        );
      }
      await q.query(
        `INSERT INTO encounters (id, hospital_id, patient_id, class, status, started_at)
         VALUES ($1, $2, $3, 'inpatient', 'in_progress', now())`,
        [encounterId, hospitalId, patientId]
      );
      await q.query(
        `INSERT INTO admissions (id, hospital_id, encounter_id, patient_id, admitting_ward_id, current_ward_id, bed_id, started_at, status, file_no, admission_criterion, referral_number, insurance_category, attending_physician, pathway)
         VALUES ($1, $2, $3, $4, $5, $5, $6, now(), 'active', $7, $8, $9, $10, $11, $12)`,
        [
          admissionId, hospitalId, encounterId, patientId, body.wardId, bedId, fileNo,
          body.admissionCriterion ?? null, body.referralNumber ?? null, body.insuranceCategory ?? null,
          body.attendingPhysician ?? null, body.pathway
        ]
      );
      if (body.diagnosis) {
        await q.query(
          `INSERT INTO diagnoses (id, hospital_id, patient_id, encounter_id, display, rank, author_user_id)
           VALUES ($1, $2, $3, $4, $5, 'principal', $6)`,
          [newId(), hospitalId, patientId, encounterId, body.diagnosis, actor.id]
        );
      }
      if (body.allergies && body.allergies.trim()) {
        await q.query(
          `INSERT INTO allergies (id, hospital_id, patient_id, substance, criticality, author_user_id)
           VALUES ($1, $2, $3, $4, 'unable', $5)`,
          [newId(), hospitalId, patientId, body.allergies.trim(), actor.id]
        );
      }
      const pathwayText =
        body.pathway === "upu" ? "Cale internare: UPU / urgență."
          : body.pathway === "ambulatory" ? "Cale internare: ambulator / programat."
            : "Cale internare: direct pe secție.";
      await q.query(
        `INSERT INTO clinical_notes (id, hospital_id, patient_id, encounter_id, kind, body, author_user_id)
         VALUES ($1, $2, $3, $4, 'admission_pathway', $5, $6)`,
        [newId(), hospitalId, patientId, encounterId, pathwayText, actor.id]
      );
      if (body.reason || body.antecedents || body.kinName || body.bloodGroup || body.address || body.phone) {
        const meta = [
          body.reason ? `Motiv: ${body.reason}` : "",
          body.antecedents ? `Antecedente: ${body.antecedents}` : "",
          body.kinName ? `Aparținător: ${body.kinName}${body.kinPhone ? ` (${body.kinPhone})` : ""}` : "",
          body.bloodGroup ? `Grupa: ${body.bloodGroup}` : "",
          body.address ? `Adresă: ${body.address}` : "",
          body.phone ? `Telefon: ${body.phone}` : "",
          body.bodyKg != null ? `Greutate: ${body.bodyKg} kg` : "",
          body.heightCm != null ? `Înălțime: ${body.heightCm} cm` : ""
        ].filter(Boolean).join("\n");
        if (meta) {
          await q.query(
            `INSERT INTO clinical_notes (id, hospital_id, patient_id, encounter_id, kind, body, author_user_id)
             VALUES ($1, $2, $3, $4, 'admission_data', $5, $6)`,
            [newId(), hospitalId, patientId, encounterId, meta, actor.id]
          );
        }
      }
      if (body.consentAdmit === true || body.consentAdmit === false) {
        await q.query(
          `INSERT INTO consents (id, hospital_id, patient_id, purpose, status, recorded_by)
           VALUES ($1, $2, $3, 'admission', $4, $5)`,
          [newId(), hospitalId, patientId, body.consentAdmit ? "granted" : "refused", actor.id]
        );
      }
      if (body.consentProc === true || body.consentProc === false) {
        await q.query(
          `INSERT INTO consents (id, hospital_id, patient_id, purpose, status, recorded_by)
           VALUES ($1, $2, $3, 'procedure', $4, $5)`,
          [newId(), hospitalId, patientId, body.consentProc ? "granted" : "refused", actor.id]
        );
      }
      await writeAudit(q, {
        hospitalId, actorUserId: actor.id, action: "chart_ensure", entityType: "admission", entityId: admissionId,
        summary: `Internare ${body.pathway} pe foaia clinică.`
      });
      return { patientId, encounterId, admissionId, bedId, reused: false, pathway: body.pathway, fileNo };
    });
  });

  route("post", "/api/encounters/:id/discharge", "encounter.write", async (request) => {
    const actor = requireUser(request);
    const hospitalId = requireHospital(request);
    const encounterId = param(request, "id");
    const body = z.object({
      summary: z.string().min(50).max(8000),
      dischargeStatus: z.enum(["vindecat", "ameliorat", "stationar", "agravat", "decedat"]),
      dischargeType: z.enum(["externat", "la_cerere", "transfer_interspitalicesc", "deces"]),
      dxCode: z.string().max(40).optional(),
      dxDisplay: z.string().min(3).max(240),
      secondary: z.string().max(800).optional(),
      recommendations: z.string().min(10).max(4000)
    }).parse(request.body);
    return db.tx(async (q) => {
      const encounter = await one<{ patient_id: string; status: string; class: string }>(
        q, "SELECT patient_id, status, class FROM encounters WHERE id = $1 AND hospital_id = $2", [encounterId, hospitalId]
      );
      if (encounter.status !== "in_progress" || encounter.class !== "inpatient") fail(409, "Doar o internare deschisă poate fi externată.");
      await q.query(
        `UPDATE encounters SET status = 'finished', ended_at = now(),
         discharge_status = $3, discharge_type = $4, discharge_dx_code = $5, discharge_dx_display = $6
         WHERE id = $1 AND hospital_id = $2`,
        [encounterId, hospitalId, body.dischargeStatus, body.dischargeType, body.dxCode ?? null, body.dxDisplay]
      );
      await q.query("UPDATE admissions SET status = 'ended', ended_at = now() WHERE encounter_id = $1 AND hospital_id = $2", [encounterId, hospitalId]);
      const letterBody = [
        `Diagnostic: ${body.dxDisplay}${body.dxCode ? ` (${body.dxCode})` : ""}`,
        body.secondary ? `Secundare: ${body.secondary}` : "",
        `Stare: ${body.dischargeStatus}`,
        `Tip: ${body.dischargeType}`,
        "",
        "Epicriză:",
        body.summary,
        "",
        "Recomandări:",
        body.recommendations
      ].filter(Boolean).join("\n");
      const documentId = newId();
      await q.query(
        `INSERT INTO documents (id, hospital_id, patient_id, encounter_id, doc_type, status, version, title, body, source, author_user_id, finalized_at)
         VALUES ($1, $2, $3, $4, 'discharge_letter', 'final', 1, 'Scrisoare medicală', $5, 'clinical_record', $6, now())`,
        [documentId, hospitalId, encounter.patient_id, encounterId, letterBody, actor.id]
      );
      await writeAudit(q, { hospitalId, actorUserId: actor.id, action: "discharge", entityType: "encounter", entityId: encounterId, summary: "Externare și scrisoare finală." });
      return { patientId: encounter.patient_id, documentId, code: "ok" };
    });
  });

  route("post", "/api/encounters/:id/vitals", "chart.write", async (request) => {
    const actor = requireUser(request);
    const hospitalId = requireHospital(request);
    const encounterId = param(request, "id");
    const body = z.object({
      ta: z.string().min(1).max(20),
      av: z.string().min(1).max(10),
      rr: z.string().min(1).max(10),
      temp: z.string().min(1).max(10),
      spo2: z.string().min(1).max(10),
      note: z.string().max(500).optional()
    }).parse(request.body);
    const encounter = await one<{ patient_id: string; status: string }>(
      db, "SELECT patient_id, status FROM encounters WHERE id = $1 AND hospital_id = $2", [encounterId, hospitalId]
    );
    if (encounter.status !== "in_progress") fail(409, "Constantele se înregistrează doar pe o internare deschisă.");
    const id = newId();
    await db.query(
      `INSERT INTO encounter_vitals (id, hospital_id, patient_id, encounter_id, ta, av, rr, temp, spo2, note, author_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [id, hospitalId, encounter.patient_id, encounterId, body.ta, body.av, body.rr, body.temp, body.spo2, body.note ?? null, actor.id]
    );
    return { id, patientId: encounter.patient_id };
  });

  route("post", "/api/medications/orders", "medication.write", async (request) => {
    const actor = requireUser(request);
    const hospitalId = requireHospital(request);
    const body = z.object({
      encounterId: z.string().uuid(),
      medicationName: z.string().min(1).max(160),
      dose: z.string().min(1).max(80),
      route: z.string().max(40).optional(),
      schedule: z.string().max(80).optional()
    }).parse(request.body);
    const encounter = await one<{ patient_id: string }>(
      db, "SELECT patient_id FROM encounters WHERE id = $1 AND hospital_id = $2", [body.encounterId, hospitalId]
    );
    const id = newId();
    await db.query(
      `INSERT INTO medication_orders (id, hospital_id, patient_id, encounter_id, medication_name, dose, route, status, prescriber_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8)`,
      [id, hospitalId, encounter.patient_id, body.encounterId, body.medicationName, body.dose, body.route ?? null, actor.id]
    );
    if (body.schedule) {
      await db.query(
        `INSERT INTO clinical_notes (id, hospital_id, patient_id, encounter_id, kind, body, author_user_id)
         VALUES ($1, $2, $3, $4, 'medication', $5, $6)`,
        [newId(), hospitalId, encounter.patient_id, body.encounterId, `Prescriere: ${body.medicationName} ${body.dose}${body.route ? ` · ${body.route}` : ""} · ${body.schedule}`, actor.id]
      );
    }
    return { id, patientId: encounter.patient_id };
  });

  route("post", "/api/consents", "consent.write", async (request) => {
    const actor = requireUser(request);
    const hospitalId = requireHospital(request);
    const body = z.object({
      patientId: z.string().uuid(),
      purpose: z.string().min(1).max(80),
      status: z.enum(["granted", "refused", "withdrawn"])
    }).parse(request.body);
    await mustOwn(db, "patients", body.patientId, hospitalId);
    const id = newId();
    await db.query(
      `INSERT INTO consents (id, hospital_id, patient_id, purpose, status, recorded_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, hospitalId, body.patientId, body.purpose, body.status, actor.id]
    );
    return { id };
  });

  route("get", "/api/wards/:id/physicians", "structure.read", async (request) => {
    const hospitalId = requireHospital(request);
    const wardId = param(request, "id");
    await mustOwn(db, "wards", wardId, hospitalId);
    const fromPractitioners = await db.query<{ id: string; first_name: string; last_name: string; specialty: string | null; parafa: string | null; grade: string | null; user_id: string | null }>(
      `SELECT id, first_name, last_name, specialty, parafa, grade, user_id
       FROM practitioners
       WHERE hospital_id = $1 AND (ward_id = $2 OR ward_id IS NULL)
       ORDER BY last_name, first_name`,
      [hospitalId, wardId]
    );
    const fromEmployees = await db.query<{ id: string; first_name: string; last_name: string; job_title: string | null; user_id: string | null }>(
      `SELECT id, first_name, last_name, job_title, user_id
       FROM employees
       WHERE hospital_id = $1 AND active = true AND ward_id = $2
         AND (job_title ILIKE '%medic%' OR job_title ILIKE '%physician%' OR job_title ILIKE '%doctor%')
       ORDER BY last_name, first_name`,
      [hospitalId, wardId]
    );
    const fromUsers = await db.query<{ id: string; display_name: string; username: string }>(
      `SELECT u.id, u.display_name, u.username
       FROM users u
       JOIN user_roles ur ON ur.user_id = u.id
       JOIN roles r ON r.id = ur.role_id
       LEFT JOIN user_ward_scopes s ON s.user_id = u.id
       WHERE u.hospital_id = $1 AND r.code IN ('physician', 'ward_chief')
         AND (s.ward_id IS NULL OR s.ward_id = $2)
       ORDER BY u.display_name`,
      [hospitalId, wardId]
    );
    const items = [
      ...fromPractitioners.map((p) => ({
        id: p.id,
        name: `${p.last_name} ${p.first_name}`.trim(),
        parafa: p.parafa || null,
        grade: p.grade || null,
        specialty: p.specialty || null,
        userId: p.user_id,
        source: "practitioner"
      })),
      ...fromEmployees.map((e) => ({
        id: e.id,
        name: `${e.last_name} ${e.first_name}`.trim(),
        parafa: null,
        grade: e.job_title || null,
        specialty: null,
        userId: e.user_id,
        source: "employee"
      })),
      ...fromUsers.map((u) => ({
        id: u.id,
        name: u.display_name || u.username,
        parafa: null,
        grade: null,
        specialty: null,
        userId: u.id,
        source: "user"
      }))
    ];
    const seen = new Set<string>();
    const unique = items.filter((item) => {
      const key = item.name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return { items: unique };
  });

  route("get", "/api/hr/employees", "hr.read", async (request) => {
    const hospitalId = requireHospital(request);
    const q = request.query as { wardId?: string };
    const rows = q.wardId
      ? await db.query(
        `SELECT id, ward_id, first_name, last_name, job_title, user_id, active
         FROM employees WHERE hospital_id = $1 AND ward_id = $2 ORDER BY last_name, first_name`,
        [hospitalId, q.wardId]
      )
      : await db.query(
        `SELECT id, ward_id, first_name, last_name, job_title, user_id, active
         FROM employees WHERE hospital_id = $1 ORDER BY last_name, first_name LIMIT 500`,
        [hospitalId]
      );
    return { items: rows };
  });

  route("post", "/api/documents/generate", "chart.write", async (request) => {
    const actor = requireUser(request);
    const hospitalId = requireHospital(request);
    const body = z.object({
      encounterId: z.string().uuid(),
      docType: z.enum(["discharge_letter", "focg", "observation_sheet"]),
      title: z.string().min(1).max(160)
    }).parse(request.body);
    const encounter = await one<{ patient_id: string }>(
      db, "SELECT patient_id FROM encounters WHERE id = $1 AND hospital_id = $2", [body.encounterId, hospitalId]
    );
    const hospital = await one<{ name: string; timezone: string; country_code: string }>(
      db, "SELECT name, timezone, country_code FROM hospitals WHERE id = $1", [hospitalId]
    );
    const patient = await one<{ first_name: string; last_name: string; birth_date: string | null; sex: string | null }>(
      db, "SELECT first_name, last_name, birth_date, sex FROM patients WHERE id = $1 AND hospital_id = $2", [encounter.patient_id, hospitalId]
    );
    const admission = await db.query<{ file_no: string | null; attending_physician: string | null; started_at: string }>(
      `SELECT file_no, attending_physician, started_at FROM admissions
       WHERE encounter_id = $1 AND hospital_id = $2 ORDER BY started_at DESC LIMIT 1`,
      [body.encounterId, hospitalId]
    );
    const year = new Date().getFullYear();
    const seqKey = body.docType === "discharge_letter" ? `sm_${year}` : `doc_${body.docType}_${year}`;
    await db.query(
      `INSERT INTO hospital_sequences (hospital_id, seq_key, last_value)
       VALUES ($1, $2, 1)
       ON CONFLICT (hospital_id, seq_key) DO UPDATE SET last_value = hospital_sequences.last_value + 1`,
      [hospitalId, seqKey]
    );
    const seqRows = await db.query<{ last_value: number }>(
      "SELECT last_value FROM hospital_sequences WHERE hospital_id = $1 AND seq_key = $2",
      [hospitalId, seqKey]
    );
    const number = `${body.docType === "discharge_letter" ? "SM" : "DOC"}-${year}-${String(seqRows[0]?.last_value || 1).padStart(6, "0")}`;
    const textBody = [
      hospital.name,
      `Cod țară: ${hospital.country_code || "—"}`,
      `Document: ${body.title}`,
      `Număr: ${number}`,
      `FO: ${admission[0]?.file_no || "—"}`,
      `Pacient: ${patient.last_name} ${patient.first_name}`,
      `Sex: ${patient.sex || "—"} · Naștere: ${patient.birth_date || "—"}`,
      `Medic curant: ${admission[0]?.attending_physician || actor.displayName}`,
      `Emis: ${new Date().toISOString()}`,
      "",
      "Conținutul clinic este cel din baza spitalului la momentul generării. Softul nu completează automat rezultate."
    ].join("\n");
    const documentId = newId();
    await db.query(
      `INSERT INTO documents (id, hospital_id, patient_id, encounter_id, doc_type, status, version, title, body, source, author_user_id, finalized_at)
       VALUES ($1, $2, $3, $4, $5, 'final', 1, $6, $7, 'server_generate', $8, now())`,
      [documentId, hospitalId, encounter.patient_id, body.encounterId, body.docType, `${body.title} ${number}`, textBody, actor.id]
    );
    return { id: documentId, number, body: textBody, contentType: "text/plain; charset=utf-8" };
  });

  route("get", "/api/documents/:id", "chart.read", async (request) => {
    const hospitalId = requireHospital(request);
    const id = param(request, "id");
    const doc = await one<{
      id: string; patient_id: string; encounter_id: string; doc_type: string; status: string;
      version: number; title: string; body: string; source: string; finalized_at: string | null; created_at: string;
    }>(
      db,
      `SELECT id, patient_id, encounter_id, doc_type, status, version, title, body, source, finalized_at, created_at
       FROM documents WHERE id = $1 AND hospital_id = $2`,
      [id, hospitalId]
    );
    return doc;
  });

  route("post", "/api/documents/:id/correct", "chart.write", async (request) => {
    const actor = requireUser(request);
    const hospitalId = requireHospital(request);
    const id = param(request, "id");
    const body = z.object({ body: z.string().min(1), reason: z.string().min(3) }).parse(request.body);
    return db.tx(async (q) => {
      const current = await one<{ patient_id: string; encounter_id: string; version: number; title: string; status: string }>(
        q, "SELECT patient_id, encounter_id, version, title, status FROM documents WHERE id = $1 AND hospital_id = $2", [id, hospitalId]
      );
      if (current.status !== "final") fail(409, "Doar un document final se corectează prin versiune nouă.");
      const nextId = newId();
      await q.query(
        `INSERT INTO documents (id, hospital_id, patient_id, encounter_id, doc_type, status, version, supersedes_id, title, body, source, correction_reason, author_user_id, finalized_at)
         VALUES ($1, $2, $3, $4, 'discharge_letter', 'final', $5, $6, $7, $8, 'correction', $9, $10, now())`,
        [nextId, hospitalId, current.patient_id, current.encounter_id, Number(current.version) + 1, id, current.title, body.body, body.reason, actor.id]
      );
      return { id: nextId, supersedesId: id };
    });
  });

  route("get", "/api/reports/admissions", "report.read", async (request) => {
    const hospitalId = requireHospital(request);
    const hospital = await one<{ timezone: string }>(db, "SELECT timezone FROM hospitals WHERE id = $1", [hospitalId]);
    const window = previousCalendarMonth(hospital.timezone, config.now?.() ?? new Date());
    const rows = await admissionsByWard(db, hospitalId, window);
    return { report: ADMISSIONS_REPORT, period: window, rows, updatedAt: new Date().toISOString() };
  });

  route("post", "/api/reports/admissions/export", "report.export", async (request) => {
    const actor = requireUser(request);
    const hospitalId = requireHospital(request);
    const hospital = await one<{ timezone: string }>(db, "SELECT timezone FROM hospitals WHERE id = $1", [hospitalId]);
    const window = previousCalendarMonth(hospital.timezone, config.now?.() ?? new Date());
    const rows = await admissionsByWard(db, hospitalId, window);
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Internări");
    sheet.addRow(["Secție", "Internări", "Durata medie (zile)", "Încă internați"]);
    for (const row of rows) sheet.addRow([row.ward, row.admissions, row.meanStayDays, row.stillOpen]);
    sheet.addRow([]);
    sheet.addRow([ADMISSIONS_REPORT.formula]);
    const buffer = await workbook.xlsx.writeBuffer();
    const id = newId();
    await db.query(
      `INSERT INTO report_exports (id, hospital_id, actor_user_id, report_key, filename, content_base64, media_type)
       VALUES ($1, $2, $3, 'admissions_by_ward', $4, $5, $6)`,
      [id, hospitalId, actor.id, `internari-${window.label}.xlsx`, Buffer.from(buffer).toString("base64"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"]
    );
    await db.tx((q) => writeAudit(q, { hospitalId, actorUserId: actor.id, action: "export", entityType: "report", entityId: id, summary: "Export Excel internări pe secții." }));
    return { exportId: id, rows, period: window };
  });

  route("get", "/api/reports/exports/:id", "report.export", async (request, reply) => {
    const hospitalId = requireHospital(request);
    const id = param(request, "id");
    const row = await one<{ filename: string; content_base64: string; media_type: string }>(
      db, "SELECT filename, content_base64, media_type FROM report_exports WHERE id = $1 AND hospital_id = $2", [id, hospitalId]
    );
    reply.header("content-type", row.media_type);
    reply.header("content-disposition", `attachment; filename="${row.filename}"`);
    return reply.send(Buffer.from(row.content_base64, "base64"));
  });

  route("post", "/api/admin/ai-providers", "ai.admin", async (request) => {
    const actor = requireUser(request);
    const hospitalId = requireHospital(request);
    if (!config.aiDataKey) fail(503, "AI_DATA_KEY lipsește. Datele clinice rămân disponibile, furnizorul nu poate fi salvat.");
    const body = z.object({
      provider: z.enum(["openai", "anthropic", "xai", "google"]),
      model: z.string().min(1).max(120),
      apiKey: z.string().min(8).max(400),
      endpointHost: z.string().min(3).max(200),
      organization: z.string().max(80).optional(),
      projectId: z.string().max(80).optional(),
      timeoutMs: z.number().int().min(1000).max(60000).optional()
    }).parse(request.body);
    assertAllowedHost(body.provider, body.endpointHost);
    const ciphertext = encryptString(body.apiKey, config.aiDataKey);
    const last4 = body.apiKey.slice(-4);
    await db.query(
      `INSERT INTO ai_provider_configs
        (id, hospital_id, provider, endpoint_host, model, api_key_ciphertext, api_key_last4, organization, project_id, enabled, allow_identifiable, timeout_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, false, false, $10)
       ON CONFLICT (hospital_id, provider) DO UPDATE SET
         endpoint_host = EXCLUDED.endpoint_host, model = EXCLUDED.model, api_key_ciphertext = EXCLUDED.api_key_ciphertext,
         api_key_last4 = EXCLUDED.api_key_last4, organization = EXCLUDED.organization, project_id = EXCLUDED.project_id,
         timeout_ms = EXCLUDED.timeout_ms, updated_at = now()`,
      [newId(), hospitalId, body.provider, body.endpointHost.trim().toLowerCase(), body.model, ciphertext, last4, body.organization ?? null, body.projectId ?? null, body.timeoutMs ?? 20000]
    );
    log(config, "ai_provider_saved", { provider: body.provider, last4 });
    await db.tx((q) => writeAudit(q, { hospitalId, actorUserId: actor.id, action: "update", entityType: "ai_provider", summary: `Furnizor ${body.provider} salvat. Datele identificabile rămân blocate.` }));
    return { provider: body.provider, last4, allowIdentifiable: false, enabled: false };
  });

  route("get", "/api/admin/ai-providers", "ai.admin", async (request) => {
    const hospitalId = requireHospital(request);
    return db.query(
      `SELECT provider, endpoint_host, model, api_key_last4, enabled, allow_identifiable, timeout_ms, organization, project_id
       FROM ai_provider_configs WHERE hospital_id = $1 ORDER BY provider`,
      [hospitalId]
    );
  });

  route("post", "/api/admin/ai-providers/:provider/test", "ai.admin", async (request) => {
    const hospitalId = requireHospital(request);
    const provider = param(request, "provider") as ProviderName;
    if (!config.aiDataKey) fail(503, "AI_DATA_KEY lipsește.");
    const row = await one<{ api_key_ciphertext: string; organization: string | null; project_id: string | null; timeout_ms: number; endpoint_host: string }>(
      db, "SELECT api_key_ciphertext, organization, project_id, timeout_ms, endpoint_host FROM ai_provider_configs WHERE hospital_id = $1 AND provider = $2",
      [hospitalId, provider]
    );
    assertAllowedHost(provider, row.endpoint_host);
    const apiKey = decryptString(row.api_key_ciphertext, config.aiDataKey);
    const result = await probeProvider({ provider, apiKey, organization: row.organization, projectId: row.project_id, timeoutMs: row.timeout_ms });
    log(config, "ai_provider_test", { provider, status: result.status, ok: result.ok });
    return result;
  });

  route("post", "/api/zena/converse", undefined, async (request) => {
    const actor = requireUser(request);
    const hospitalId = requireHospital(request);
    const body = z.object({
      mode: z.enum(["help", "report", "configure", "develop", "diagnose", "admin"]),
      message: z.string().min(1).max(4000)
    }).parse(request.body);
    if (body.mode === "admin") {
      if (!actor.permissions.has("zena.admin")) fail(403, "Zena admin necesită autorizare de administrator.");
      const applied = await applyZenaAdminCommand(db, { hospitalId, actorUserId: actor.id, message: body.message });
      await db.query(
        `INSERT INTO zena_requests (id, hospital_id, actor_user_id, mode, tool, outcome, redacted_message)
         VALUES ($1, $2, $3, 'admin', 'zena.admin', $4, $5)`,
        [newId(), hospitalId, actor.id, applied.action, redact(body.message)]
      );
      return { mode: "admin", ...applied, aiUsed: false, instant: true };
    }
    const permission = `zena.${body.mode === "help" ? "help" : body.mode === "report" ? "report" : body.mode === "configure" ? "configure" : body.mode === "develop" ? "develop" : "diagnose"}`;
    if (!actor.permissions.has(permission)) fail(403, "Unealta Zena nu este permisă pentru acest rol.");
    const outcome = await runZena(db, config, actor, hospitalId, body.mode, body.message);
    await db.query(
      `INSERT INTO zena_requests (id, hospital_id, actor_user_id, mode, tool, outcome, redacted_message)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [newId(), hospitalId, actor.id, body.mode, outcome.tool, outcome.outcome, redact(body.message)]
    );
    await db.tx((q) => writeAudit(q, { hospitalId, actorUserId: actor.id, action: "zena", entityType: "zena", summary: `${body.mode}: ${outcome.outcome}` }));
    return outcome.body;
  });

  route("post", "/api/extensions", "extension.propose", async (request) => {
    const actor = requireUser(request);
    const hospitalId = requireHospital(request);
    const body = z.object({ spec: z.unknown() }).parse(request.body);
    const spec = assertSafeSpec(body.spec);
    const id = await storeProposal(db, hospitalId, actor.id, spec, "draft");
    return { id, status: "draft" };
  });

  route("post", "/api/extensions/:id/preview", "extension.propose", async (request) => {
    const hospitalId = requireHospital(request);
    const id = param(request, "id");
    const row = await one<{ status: string; spec: DeclarativeSpec }>(db, "SELECT status, spec FROM change_proposals WHERE id = $1 AND hospital_id = $2 AND kind = 'declarative'", [id, hospitalId]);
    if (row.status !== "draft" && row.status !== "preview") fail(409, "Propunerea nu poate fi previzualizată.");
    await db.query("UPDATE change_proposals SET status = 'preview', updated_at = now() WHERE id = $1", [id]);
    return {
      id,
      status: "preview",
      synthetic: true,
      rows: [{ employee: "Popescu Ana (sintetic)", startDate: "2026-12-01", endDate: "2026-12-05", status: "submitted" }]
    };
  });

  route("post", "/api/extensions/:id/approve", "extension.approve", async (request) => {
    const actor = requireUser(request);
    const hospitalId = requireHospital(request);
    const id = param(request, "id");
    const updated = await db.query(
      "UPDATE change_proposals SET status = 'approved', approver_user_id = $3, updated_at = now() WHERE id = $1 AND hospital_id = $2 AND status = 'preview' RETURNING id",
      [id, hospitalId, actor.id]
    );
    if (!updated.length) fail(409, "Doar o previzualizare poate fi aprobată.");
    return { id, status: "approved" };
  });

  route("post", "/api/extensions/:id/activate", "extension.approve", async (request) => {
    const actor = requireUser(request);
    const hospitalId = requireHospital(request);
    const id = param(request, "id");
    return db.tx(async (q) => {
      const row = await one<{ status: string; spec: DeclarativeSpec; checksum: string; module_key: string }>(
        q, "SELECT status, spec, checksum, module_key FROM change_proposals WHERE id = $1 AND hospital_id = $2 AND kind = 'declarative'", [id, hospitalId]
      );
      if (row.status !== "approved") fail(409, "O propunere neaprobată nu poate fi activată.");
      const versionRows = await q.query<{ version: number }>("SELECT COALESCE(max(version), 0)::int AS version FROM extension_versions WHERE hospital_id = $1 AND module_key = $2", [hospitalId, row.module_key]);
      const version = Number(versionRows[0]?.version ?? 0) + 1;
      await q.query("UPDATE extension_versions SET active = false WHERE hospital_id = $1 AND module_key = $2", [hospitalId, row.module_key]);
      await q.query(
        `INSERT INTO extension_versions (id, hospital_id, proposal_id, module_key, version, manifest, checksum, author_user_id, approver_user_id, active)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $8, true)`,
        [newId(), hospitalId, id, row.module_key, version, JSON.stringify(row.spec), row.checksum, actor.id]
      );
      await q.query("UPDATE change_proposals SET status = 'active', updated_at = now() WHERE id = $1", [id]);
      await writeAudit(q, { hospitalId, actorUserId: actor.id, action: "activate", entityType: "extension", entityId: id, summary: `Extensie declarativă ${row.module_key} activată.` });
      return { id, status: "active", version, moduleKey: row.module_key };
    });
  });

  route("post", "/api/extensions/code", "zena.develop", async (request) => {
    const actor = requireUser(request);
    const hospitalId = requireHospital(request);
    const body = z.object({ summary: z.string().min(1).max(500) }).parse(request.body);
    const id = newId();
    const spec = { summary: body.summary, execution: CODE_EXECUTION };
    await db.query(
      `INSERT INTO change_proposals (id, hospital_id, kind, module_key, status, spec, checksum, author_user_id, executable)
       VALUES ($1, $2, 'code', 'code.proposal', 'stored', $3::jsonb, $4, $5, false)`,
      [id, hospitalId, JSON.stringify(spec), sha256(JSON.stringify(spec)), actor.id]
    );
    return { id, ...CODE_EXECUTION };
  });

  route("post", "/api/extensions/code/:id/publish", "extension.approve", async (request) => {
    const hospitalId = requireHospital(request);
    await mustOwn(db, "change_proposals", param(request, "id"), hospitalId);
    fail(501, CODE_EXECUTION.reason);
  });

  route("get", "/api/extensions", "extension.propose", async (request) => {
    const hospitalId = requireHospital(request);
    return db.query("SELECT id, kind, module_key, status, executable, checksum, created_at FROM change_proposals WHERE hospital_id = $1 ORDER BY created_at", [hospitalId]);
  });

  route("post", "/api/hr/employees", "hr.write", async (request) => {
    const hospitalId = requireHospital(request);
    const body = z.object({ firstName: z.string().min(1), lastName: z.string().min(1), jobTitle: z.string().min(1), wardId: z.string().uuid().optional() }).parse(request.body);
    if (body.wardId) await mustOwn(db, "wards", body.wardId, hospitalId);
    const id = newId();
    await db.query(
      "INSERT INTO employees (id, hospital_id, ward_id, first_name, last_name, job_title) VALUES ($1, $2, $3, $4, $5, $6)",
      [id, hospitalId, body.wardId ?? null, body.firstName, body.lastName, body.jobTitle]
    );
    return { id };
  });

  route("post", "/api/hr/leave-requests", "hr.write", async (request) => {
    const hospitalId = requireHospital(request);
    if (!(await extensionActive(db, hospitalId, "hr.leave"))) fail(409, "Modulul de concedii nu este activ.");
    const body = z.object({
      employeeId: z.string().uuid(),
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      reason: z.string().min(1)
    }).parse(request.body);
    await mustOwn(db, "employees", body.employeeId, hospitalId);
    const id = newId();
    const employee = await one<{ ward_id: string | null }>(db, "SELECT ward_id FROM employees WHERE id = $1 AND hospital_id = $2", [body.employeeId, hospitalId]);
    await db.query(
      `INSERT INTO leave_requests (id, hospital_id, employee_id, ward_id, start_date, end_date, reason, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'submitted')`,
      [id, hospitalId, body.employeeId, employee.ward_id, body.startDate, body.endDate, body.reason]
    );
    return { id, status: "submitted" };
  });

  route("post", "/api/hr/leave-requests/:id/decision", "hr.approve", async (request) => {
    const actor = requireUser(request);
    const hospitalId = requireHospital(request);
    const id = param(request, "id");
    const body = z.object({ decision: z.enum(["approve", "reject"]), note: z.string().max(500).optional() }).parse(request.body);
    const status = body.decision === "approve" ? "approved" : "rejected";
    const updated = await db.query(
      `UPDATE leave_requests SET status = $3, approver_user_id = $4, decision_note = $5, decided_at = now()
       WHERE id = $1 AND hospital_id = $2 AND status = 'submitted' RETURNING id`,
      [id, hospitalId, status, actor.id, body.note ?? null]
    );
    if (!updated.length) fail(409, "Cererea nu este în așteptare.");
    return { id, status };
  });

  route("get", "/api/hr/leave-report", "hr.read", async (request) => {
    const hospitalId = requireHospital(request);
    const month = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/) }).parse(request.query).month;
    const rows = await db.query(
      `SELECT status, count(*)::int AS total FROM leave_requests
       WHERE hospital_id = $1 AND to_char(start_date, 'YYYY-MM') = $2 GROUP BY status ORDER BY status`,
      [hospitalId, month]
    );
    return { month, population: "Cereri de concediu ale angajaților acestui spital, după luna datei de început.", rows, synthetic: false };
  });

  route("get", "/api/integrations", "structure.read", async () => {
    return db.query("SELECT code, name, status FROM integration_catalog ORDER BY code");
  });

  route("get", "/api/board/wards", "structure.read", async (request) => {
    const actor = requireUser(request);
    const hospitalId = requireHospital(request);
    const page = parsePage(request.query as Record<string, unknown>);
    const board = await listWardBoard(db, hospitalId, actor.wardScopeIds, page);
    return { ...board, limit: page.limit, offset: page.offset };
  });

  route("get", "/api/board/wards/:id/beds", "encounter.read", async (request) => {
    const actor = requireUser(request);
    const hospitalId = requireHospital(request);
    const wardId = param(request, "id");
    await mustOwn(db, "wards", wardId, hospitalId);
    assertWardInScope(wardId, actor.wardScopeIds);
    const page = parsePage(request.query as Record<string, unknown>, 200);
    const beds = await listBedsForWard(db, hospitalId, wardId, page);
    return { wardId, ...beds, limit: page.limit, offset: page.offset };
  });

  route("put", "/api/users/:id/ward-scopes", "ward.scope.admin", async (request) => {
    const actor = requireUser(request);
    const hospitalId = requireHospital(request);
    const userId = param(request, "id");
    await mustOwn(db, "users", userId, hospitalId);
    const body = z.object({ wardIds: z.array(z.string().uuid()).max(200) }).parse(request.body);
    for (const wardId of body.wardIds) await mustOwn(db, "wards", wardId, hospitalId);
    await db.tx(async (q) => {
      await q.query("DELETE FROM user_ward_scopes WHERE hospital_id = $1 AND user_id = $2", [hospitalId, userId]);
      for (const wardId of body.wardIds) {
        await q.query(
          "INSERT INTO user_ward_scopes (user_id, ward_id, hospital_id) VALUES ($1, $2, $3)",
          [userId, wardId, hospitalId]
        );
      }
      await writeAudit(q, {
        hospitalId, actorUserId: actor.id, action: "ward_scope", entityType: "user", entityId: userId,
        summary: body.wardIds.length ? `Domeniu: ${body.wardIds.length} secții.` : "Domeniu golit (acces pe tot spitalul)."
      });
    });
    return { userId, wardIds: body.wardIds };
  });

  route("post", "/api/patients/:id/care-team", "encounter.write", async (request) => {
    const actor = requireUser(request);
    const hospitalId = requireHospital(request);
    const patientId = param(request, "id");
    await mustOwn(db, "patients", patientId, hospitalId);
    const body = z.object({
      userId: z.string().uuid(),
      role: z.enum(["attending", "member", "consult"]).default("member")
    }).parse(request.body);
    await mustOwn(db, "users", body.userId, hospitalId);
    const id = newId();
    await db.query(
      `INSERT INTO care_team (id, hospital_id, patient_id, user_id, role, active)
       VALUES ($1, $2, $3, $4, $5, true)
       ON CONFLICT (hospital_id, patient_id, user_id) DO UPDATE SET role = EXCLUDED.role, active = true`,
      [id, hospitalId, patientId, body.userId, body.role]
    );
    await db.tx((q) => writeAudit(q, {
      hospitalId, actorUserId: actor.id, action: "care_team", entityType: "patient", entityId: patientId,
      summary: "Membru adăugat în echipa de îngrijire."
    }));
    return { ok: true };
  });

  route("post", "/api/integrations/lis/dispatch", "integration.lis", async (request) => {
    const actor = requireUser(request);
    const hospitalId = requireHospital(request);
    const body = z.object({ limit: z.number().int().min(1).max(100).optional() }).parse(request.body ?? {});
    const results = await dispatchHeldLis(db, hospitalId, actor.id, body.limit ?? 20);
    await db.tx((q) => writeAudit(q, {
      hospitalId, actorUserId: actor.id, action: "lis_dispatch", entityType: "integration", entityId: hospitalId,
      summary: `LIS simulator: ${results.length} mesaje procesate.`
    }));
    return { dispatched: results.length, results };
  });

  route("get", "/api/integrations/lis/messages", "integration.lis", async (request) => {
    const hospitalId = requireHospital(request);
    const page = parsePage(request.query as Record<string, unknown>);
    const rows = await db.query(
      `SELECT id, direction, message_type, control_id, ack_code, status, created_at
       FROM lis_messages WHERE hospital_id = $1
       ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [hospitalId, page.limit, page.offset]
    );
    return { items: rows, limit: page.limit, offset: page.offset };
  });

  route("post", "/api/ops/backup", "ops.backup", async (request) => {
    const actor = requireUser(request);
    const hospitalId = requireHospital(request);
    const body = z.object({ kind: z.enum(["logical", "pg_dump"]).default("logical") }).parse(request.body ?? {});
    if (body.kind === "pg_dump") {
      const databaseUrl = process.env.DATABASE_URL;
      if (!databaseUrl) fail(503, "pg_dump necesită DATABASE_URL (PostgreSQL).");
      const result = await runPgDumpBackup(db, { databaseUrl, hospitalId, dir: dirs.backups });
      return result;
    }
    if (!config.aiDataKey) fail(503, "AI_DATA_KEY este necesară pentru copia logică criptată.");
    const result = await runLogicalBackup(db, config.aiDataKey, { hospitalId, dir: dirs.backups });
    await db.tx((q) => writeAudit(q, {
      hospitalId, actorUserId: actor.id, action: "backup", entityType: "backup_run", entityId: result.id,
      summary: "Copie logică criptată creată pe disc (data/backups)."
    }));
    return result;
  });

  route("get", "/api/ops/backup-runs", "ops.backup", async (request) => {
    requireHospital(request);
    const page = parsePage(request.query as Record<string, unknown>);
    return db.query(
      "SELECT id, kind, status, path, bytes, detail, created_at FROM backup_runs ORDER BY created_at DESC LIMIT $1 OFFSET $2",
      [page.limit, page.offset]
    );
  });

  await registerPilotRoutes(app, {
    db,
    dirs,
    route,
    requireUser,
    requireHospital,
    mustOwn,
    one,
    fail,
    param
  });

  await registerAppointmentRoutes(app, {
    db,
    route,
    requireUser,
    requireHospital,
    mustOwn,
    one,
    fail,
    param
  });

  await registerModuleConfigRoutes(app, {
    db,
    route,
    requireUser,
    requireHospital,
    one,
    fail,
    param
  });

  const collectionDocument = z.object({
    wards: z.array(z.unknown()).max(80),
    people: z.array(z.unknown()).max(5000).optional(),
    departments: z.array(z.unknown()).max(200).optional(),
    gestTypes: z.array(z.unknown()).max(100).optional(),
    nomenclatoare: z.record(z.array(z.unknown())).optional(),
    hospital: z.unknown().optional(),
    integrations: z.unknown().optional(),
    synthetic: z.boolean().optional(),
    expectedVersion: z.number().int().positive().optional()
  });

  route("get", "/api/collection", undefined, async (request) => {
    const user = requireUser(request);
    if (!user.permissions.has("chart.read") && !user.permissions.has("structure.read")) fail(403, "Acces refuzat.");
    const hospitalId = requireHospital(request);
    const rows = await db.query<{ document: unknown; synthetic: boolean; updated_at: string; version: number }>(
      "SELECT document, synthetic, updated_at, COALESCE(version, 1) AS version FROM collection_workspaces WHERE hospital_id = $1",
      [hospitalId]
    );
    const row = rows[0];
    if (!row) return { document: null, synthetic: true, updatedAt: null, version: 0 };
    return { document: row.document, synthetic: row.synthetic, updatedAt: row.updated_at, version: Number(row.version) || 1 };
  });

  route("put", "/api/collection", undefined, async (request) => {
    const user = requireUser(request);
    if (!user.permissions.has("chart.write") && !user.permissions.has("structure.write")) fail(403, "Acces refuzat.");
    const hospitalId = requireHospital(request);
    const body = collectionDocument.parse(request.body);
    const synthetic = body.synthetic !== false;
    const expected = body.expectedVersion;
    const current = await db.query<{ version: number }>(
      "SELECT COALESCE(version, 1) AS version FROM collection_workspaces WHERE hospital_id = $1",
      [hospitalId]
    );
    if (expected != null && current[0] && Number(current[0].version) !== expected) {
      throw Object.assign(new Error("Alt utilizator a salvat între timp. Reîncărcați și aplicați din nou modificările."), {
        statusCode: 409,
        code: "stale_version"
      });
    }
    const nextVersion = current[0] ? Number(current[0].version) + 1 : 1;
    const payload = { ...body };
    delete (payload as { expectedVersion?: number }).expectedVersion;
    await db.query(
      `INSERT INTO collection_workspaces (hospital_id, document, synthetic, updated_by, updated_at, version)
       VALUES ($1, $2::jsonb, $3, $4, now(), $5)
       ON CONFLICT (hospital_id) DO UPDATE
       SET document = EXCLUDED.document, synthetic = EXCLUDED.synthetic, updated_by = EXCLUDED.updated_by,
           updated_at = now(), version = EXCLUDED.version`,
      [hospitalId, JSON.stringify(payload), synthetic, user.id, nextVersion]
    );
    await db.tx((q) => writeAudit(q, {
      hospitalId,
      actorUserId: user.id,
      action: "collection_save",
      entityType: "collection_workspace",
      entityId: hospitalId,
      summary: synthetic ? "Spațiul de colectare a fost salvat. Conține date de exercițiu." : `Spațiul de colectare salvat (v${nextVersion}).`
    }));
    return { ok: true, synthetic, version: nextVersion };
  });

  route("delete", "/api/collection", undefined, async (request) => {
    const user = requireUser(request);
    if (!user.permissions.has("structure.write")) fail(403, "Acces refuzat.");
    const hospitalId = requireHospital(request);
    await db.query("DELETE FROM collection_workspaces WHERE hospital_id = $1", [hospitalId]);
    await db.tx((q) => writeAudit(q, {
      hospitalId,
      actorUserId: user.id,
      action: "collection_reset",
      entityType: "collection_workspace",
      entityId: hospitalId,
      summary: "Spațiul de colectare a fost golit."
    }));
    return { ok: true };
  });

  route("get", "/api/audit", "audit.read", async (request) => {
    const hospitalId = requireHospital(request);
    return db.query(
      "SELECT id::text, action, entity_type, entity_id, summary, created_at FROM audit_events WHERE hospital_id = $1 ORDER BY id DESC LIMIT 100",
      [hospitalId]
    );
  });

  const webDist = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "dist");
  if (await exists(webDist)) {
    await app.register(fastifyStatic, { root: webDist });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/") || request.url.startsWith("/fhir/")) return reply.code(404).send({ error: "not_found" });
      return reply.sendFile("index.html");
    });
  }

  return app;
}

async function runZena(db: Db, config: AppConfig, actor: SessionUser, hospitalId: string, mode: string, message: string) {
  if (mode === "help") {
    return { tool: "help", outcome: "explained", body: { mode, answer: helpText(), source: "local_help", aiUsed: false } };
  }
  if (mode === "diagnose") {
    const dbOk = await db.query("SELECT 1 AS ok");
    return { tool: "diagnose", outcome: "reported", body: { mode, database: dbOk.length === 1, ai: config.aiDataKey ? "key_present" : "disabled", integrations: "neconfigurat", aiUsed: false } };
  }
  if (mode === "develop") {
    const id = newId();
    const spec = { summary: redact(message), execution: CODE_EXECUTION };
    await db.query(
      `INSERT INTO change_proposals (id, hospital_id, kind, module_key, status, spec, checksum, author_user_id, executable)
       VALUES ($1, $2, 'code', 'code.proposal', 'stored', $3::jsonb, $4, $5, false)`,
      [id, hospitalId, JSON.stringify(spec), sha256(JSON.stringify(spec)), actor.id]
    );
    return { tool: "develop", outcome: "stored_unavailable", body: { mode, proposalId: id, ...CODE_EXECUTION, aiUsed: false } };
  }
  if (mode === "configure") {
    const interpreted = interpretConfigure(message);
    if ("questions" in interpreted) return { tool: "configure", outcome: "clarify", body: { mode, questions: interpreted.questions, aiUsed: false } };
    const id = await storeProposal(db, hospitalId, actor.id, interpreted.spec, "draft");
    return { tool: "configure", outcome: "proposed", body: { mode, proposalId: id, spec: interpreted.spec, status: "draft", source: "declarative_builder", aiUsed: false } };
  }
  const intent = parseReportIntent(message);
  if (intent === "clarify") {
    return { tool: "report", outcome: "clarify", body: { mode, questions: ["Spune indicatorul, perioada și dacă vrei export. Exemplu: internările pe secții luna trecută, durata medie, Excel."], aiUsed: false } };
  }
  const hospital = await one<{ timezone: string }>(db, "SELECT timezone FROM hospitals WHERE id = $1", [hospitalId]);
  const window = previousCalendarMonth(hospital.timezone, config.now?.() ?? new Date());
  const rows = await admissionsByWard(db, hospitalId, window);
  let exportId: string | undefined;
  if (message.toLowerCase().includes("excel")) {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Internări");
    sheet.addRow(["Secție", "Internări", "Durata medie (zile)", "Încă internați"]);
    for (const row of rows) sheet.addRow([row.ward, row.admissions, row.meanStayDays, row.stillOpen]);
    const buffer = await workbook.xlsx.writeBuffer();
    exportId = newId();
    await db.query(
      `INSERT INTO report_exports (id, hospital_id, actor_user_id, report_key, filename, content_base64, media_type)
       VALUES ($1, $2, $3, 'admissions_by_ward', $4, $5, $6)`,
      [exportId, hospitalId, actor.id, `internari-${window.label}.xlsx`, Buffer.from(buffer).toString("base64"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"]
    );
  }
  return {
    tool: "report",
    outcome: "reported",
    body: { mode, source: "catalog:admissions_by_ward", report: ADMISSIONS_REPORT, period: window, rows, exportId, aiUsed: false }
  };
}

async function storeProposal(db: Db, hospitalId: string, userId: string, spec: DeclarativeSpec, status: "draft"): Promise<string> {
  const id = newId();
  const checksum = specChecksum(spec);
  await db.query(
    `INSERT INTO change_proposals (id, hospital_id, kind, module_key, status, spec, checksum, author_user_id, executable)
     VALUES ($1, $2, 'declarative', $3, $4, $5::jsonb, $6, $7, false)`,
    [id, hospitalId, spec.moduleKey, status, JSON.stringify(spec), checksum, userId]
  );
  return id;
}

function helpText(): string {
  return [
    "Zena explică aplicația din textele locale. Nu este nevoie de un furnizor AI pentru lucru clinic.",
    "Pacientul are un identificator intern. CNP-ul este opțional. Un pacient neidentificat din UPU păstrează același identificator după ce este identificat.",
    "Internarea pornește din prezentarea UPU. Transferul mută patul, dar nu creează o a doua internare.",
    "Rezultatul de laborator rămâne preliminar până la validare. O corecție adaugă o versiune nouă.",
    "Scrisoarea de externare finală nu se suprascrie. Corecția creează versiunea următoare.",
    "Modulul de concedii apare după o propunere, o previzualizare cu date sintetice, aprobare și activare."
  ].join(" ");
}

async function extensionActive(db: Db, hospitalId: string, moduleKey: string): Promise<boolean> {
  const rows = await db.query("SELECT id FROM extension_versions WHERE hospital_id = $1 AND module_key = $2 AND active", [hospitalId, moduleKey]);
  return rows.length > 0;
}

async function loadUser(db: Db, token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null;
  const rows = await db.query<{ id: string; hospital_id: string | null; username: string; display_name: string; password_must_change: boolean }>(
    `SELECT u.id, u.hospital_id, u.username, u.display_name, u.password_must_change
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now() AND u.active`,
    [sha256(token)]
  );
  const user = rows[0];
  if (!user) return null;
  const permissions = await db.query<{ permission_code: string }>(
    `SELECT rp.permission_code FROM user_roles ur
     JOIN role_permissions rp ON rp.role_id = ur.role_id
     JOIN roles r ON r.id = ur.role_id
     WHERE ur.user_id = $1 AND r.hospital_id IS NOT DISTINCT FROM $2`,
    [user.id, user.hospital_id]
  );
  const permissionSet = new Set(permissions.map((item) => item.permission_code));
  const wardScopeIds = user.hospital_id
    ? await loadWardScopeIds(db, user.hospital_id, user.id, permissionSet.has("user.admin"))
    : null;
  return {
    id: user.id,
    hospitalId: user.hospital_id,
    username: user.username,
    displayName: user.display_name,
    mustChange: user.password_must_change,
    permissions: permissionSet,
    wardScopeIds
  };
}

function requireUser(request: FastifyRequest): SessionUser {
  const user = (request as Authed).user;
  if (!user) fail(401, "Neautentificat.");
  return user;
}

function requireHospital(request: FastifyRequest): string {
  const user = requireUser(request);
  if (!user.hospitalId) fail(403, "Contul nu este legat de un spital.");
  return user.hospitalId;
}

function publicUser(user: SessionUser) {
  return {
    id: user.id,
    hospitalId: user.hospitalId,
    username: user.username,
    displayName: user.displayName,
    passwordChangeRequired: user.mustChange,
    permissions: [...user.permissions].sort(),
    wardScopeIds: user.wardScopeIds,
    hospitalWideAccess: user.wardScopeIds === null
  };
}

function param(request: FastifyRequest, name: string): string {
  const value = (request.params as Record<string, string>)[name];
  if (!value || !/^[0-9a-f-]{36}$/i.test(value) && name !== "provider") {
    if (name === "provider" && /^(openai|anthropic|xai|google)$/.test(value ?? "")) return value;
    fail(422, "Identificator invalid.");
  }
  return value;
}

async function mustOwn(q: { query: Db["query"] }, table: string, id: string, hospitalId: string): Promise<void> {
  if (!/^[a-z_]+$/.test(table)) fail(500, "Tabel neașteptat.");
  const rows = await q.query(`SELECT id FROM ${table} WHERE id = $1 AND hospital_id = $2`, [id, hospitalId]);
  if (!rows.length) fail(404, "Înregistrarea nu există în acest spital.");
}

async function one<T>(q: { query: Db["query"] }, text: string, params: unknown[]): Promise<T> {
  const rows = await q.query<T>(text, params);
  if (!rows[0]) fail(404, "Înregistrarea nu există în acest spital.");
  return rows[0];
}

function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), { statusCode: status });
}

function log(config: AppConfig, message: string, fields: Record<string, unknown> = {}): void {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (/key|secret|password|token|authorization|ciphertext/i.test(key)) continue;
    clean[key] = typeof value === "string" ? redact(value) : value;
  }
  config.logs.push(redact(`${message} ${JSON.stringify(clean)}`));
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(join(path, "index.html"));
    return true;
  } catch {
    return false;
  }
}
