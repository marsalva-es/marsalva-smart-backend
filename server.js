// server.js (COMPLETO) — Citas + Login Admin + Bloqueos + Fix Timezone/Duración
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const jwt = require("jsonwebtoken");

// NOTA: En Node 18+ (Render) 'fetch' es nativo. No hace falta node-fetch.

// =============== INICIALIZACIÓN FIREBASE ===============
if (!admin.apps.length) {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const rawPrivateKey = process.env.FIREBASE_PRIVATE_KEY;

  console.log("🚀 Marsalva Smart Backend V4 (Citas + Admin Blocks) arrancando...");

  if (!projectId || !clientEmail || !rawPrivateKey) {
    console.error("❌ ERROR CRÍTICO: Faltan variables de entorno de Firebase.");
    process.exit(1);
  }

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId,
      clientEmail,
      privateKey: rawPrivateKey.replace(/\\n/g, "\n"),
    }),
  });
}

const db = admin.firestore();

// =============== CONFIGURACIÓN DEL NEGOCIO (TUS REGLAS) ===============

// Tu Base: Algeciras
const HOME_ALGECIRAS = { lat: 36.1408, lng: -5.4562 };

// ⏰ HORARIOS EXACTOS
const SCHEDULE = {
  morning: { startHour: 9, startMinute: 30, endHour: 14, endMinute: 0 },
  afternoon: { startHour: 17, startMinute: 0, endHour: 19, endMinute: 0 },
};

// ⏱️ TIEMPOS Y REGLAS DE VIAJE
const SLOT_INTERVAL = 30; // huecos cada 30 min
const SERVICE_DEFAULT_MIN = 60; // duración mínima
const TRAVEL_MARGIN_MINUTES = 15; // colchón
const MAX_TRAVEL_ALLOWED_BETWEEN_JOBS = 30; // anti-zigzag

// Google API
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || "";

// Admin login (para WP Config)
const ADMIN_USER = process.env.ADMIN_USER || "";
const ADMIN_PASS = process.env.ADMIN_PASS || "";
const ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || "";

// Puerto
const PORT = process.env.PORT || 10000;

const app = express();

// ✅ CORS con Authorization (NO rompe nada de citas)
app.use(
  cors({
    origin: true,
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.json());

// Cachés
const geocodeCache = new Map();
const distanceCache = new Map();

// =============== UTILIDADES FECHA (EUROPE/MADRID) ===============

// Convierte una fecha a “representación Madrid” (Date en runtime, pero calculada con TZ Europe/Madrid)
function toSpainDate(dateInput = new Date()) {
  const d = new Date(dateInput);
  const spainString = d.toLocaleString("en-US", { timeZone: "Europe/Madrid" });
  return new Date(spainString);
}

function getSpainNow() {
  return toSpainDate(new Date());
}

function spainDayStart(dateInput) {
  const d = toSpainDate(dateInput);
  d.setHours(0, 0, 0, 0);
  return d;
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60000);
}

function addDays(date, days) {
  return addMinutes(date, days * 24 * 60);
}

function setTime(baseDate, hour, minute) {
  const d = new Date(baseDate);
  d.setHours(hour, minute, 0, 0);
  return d;
}

function formatTime(date) {
  const h = date.getHours().toString().padStart(2, "0");
  const m = date.getMinutes().toString().padStart(2, "0");
  return `${h}:${m}`;
}

function normalizeBlock(block) {
  const b = (block || "").toString().toLowerCase();
  if (b.includes("tard") || b.includes("after")) return "afternoon";
  return "morning";
}

function isWeekendES(dateInput) {
  const d = toSpainDate(dateInput);
  const dayNum = d.getDay(); // 0 domingo, 6 sábado
  return dayNum === 0 || dayNum === 6;
}

// =============== DURACIÓN ROBUSTA (evita solapes falsos) ===============
function parseDurationMinutes(value) {
  if (value == null) return SERVICE_DEFAULT_MIN;

  // numérico
  if (typeof value === "number" && isFinite(value)) {
    // heurística: si viene en segundos (muy grande), lo convertimos
    if (value > 1000) return Math.max(15, Math.round(value / 60));
    return Math.max(15, Math.round(value));
  }

  // string
  if (typeof value === "string") {
    const s = value.trim();
    if (!s) return SERVICE_DEFAULT_MIN;

    // "HH:mm"
    const hm = s.match(/^(\d{1,2})\s*:\s*(\d{1,2})$/);
    if (hm) {
      const hh = parseInt(hm[1], 10);
      const mm = parseInt(hm[2], 10);
      const mins = hh * 60 + mm;
      return mins > 0 ? mins : SERVICE_DEFAULT_MIN;
    }

    // "90"
    const n = Number(s);
    if (!isNaN(n) && isFinite(n)) {
      if (n > 1000) return Math.max(15, Math.round(n / 60));
      return Math.max(15, Math.round(n));
    }
  }

  return SERVICE_DEFAULT_MIN;
}

// =============== GOOGLE MAPS ===============
async function geocodeAddress(fullAddress) {
  if (!fullAddress) throw new Error("Dirección vacía");
  if (geocodeCache.has(fullAddress)) return geocodeCache.get(fullAddress);

  if (!GOOGLE_MAPS_API_KEY) return HOME_ALGECIRAS;

  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(
    fullAddress
  )}&key=${GOOGLE_MAPS_API_KEY}`;

  try {
    const resp = await fetch(url);
    const data = await resp.json();

    if (data.status !== "OK" || !data.results.length) return HOME_ALGECIRAS;

    const loc = data.results[0].geometry.location;
    const result = { lat: loc.lat, lng: loc.lng };
    geocodeCache.set(fullAddress, result);
    return result;
  } catch (e) {
    console.error("Error Geocoding:", e.message);
    return HOME_ALGECIRAS;
  }
}

async function getTravelTimeMinutes(origin, destination) {
  if (
    Math.abs(origin.lat - destination.lat) < 0.001 &&
    Math.abs(origin.lng - destination.lng) < 0.001
  ) {
    return 0;
  }

  const cacheKey = `${origin.lat},${origin.lng}_${destination.lat},${destination.lng}`;
  if (distanceCache.has(cacheKey)) return distanceCache.get(cacheKey);

  // Fallback razonable si no hay API Key
  if (!GOOGLE_MAPS_API_KEY) return 20;

  const url = `https://maps.googleapis.com/maps/api/distancematrix/json?units=metric&origins=${origin.lat},${origin.lng}&destinations=${destination.lat},${destination.lng}&key=${GOOGLE_MAPS_API_KEY}`;

  try {
    const resp = await fetch(url);
    const data = await resp.json();

    if (data.status === "OK" && data.rows?.[0]?.elements?.[0]?.status === "OK") {
      const seconds = data.rows[0].elements[0].duration.value;
      const minutes = Math.ceil(seconds / 60);
      distanceCache.set(cacheKey, minutes);
      return minutes;
    }
  } catch (e) {
    console.error("Error Matrix:", e.message);
  }

  // fallback seguro
  return 20;
}

// =============== GENERADOR DE HUECOS ===============
function generateSlotsForDayAndBlock(dayBaseES, rawBlock) {
  const block = normalizeBlock(rawBlock);
  const config = SCHEDULE[block];

  const slots = [];
  let current = setTime(dayBaseES, config.startHour, config.startMinute);
  const endLimit = setTime(dayBaseES, config.endHour, config.endMinute);

  while (current < endLimit) {
    slots.push(new Date(current));
    current = addMinutes(current, SLOT_INTERVAL);
  }
  return slots;
}

// =============== BLOQUEOS (CALENDAR BLOCKS) ===============
function toDayKeyES(dateInput) {
  const d = toSpainDate(dateInput);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${da}`;
}

function buildDayKeysBetween(startDate, endDate) {
  const keys = [];
  const start = toSpainDate(startDate);
  const end = toSpainDate(endDate);

  const cursor = new Date(start);
  cursor.setHours(0, 0, 0, 0);

  const endDay = new Date(end);
  endDay.setHours(0, 0, 0, 0);

  while (cursor <= endDay) {
    keys.push(toDayKeyES(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return Array.from(new Set(keys));
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && aEnd > bStart;
}

async function getBlocksForDay(dayKey, clientCity = "") {
  const snap = await db
    .collection("calendarBlocks")
    .where("dayKeys", "array-contains", dayKey)
    .get();

  const cityNorm = (clientCity || "").trim().toLowerCase();

  return snap.docs
    .map((d) => {
      const data = d.data();
      return {
        id: d.id,
        start: data.start?.toDate ? data.start.toDate() : null,
        end: data.end?.toDate ? data.end.toDate() : null,
        allDay: !!data.allDay,
        reason: data.reason || "",
        city: (data.city || "").trim(),
      };
    })
    .filter((b) => {
      const bc = (b.city || "").trim().toLowerCase();
      if (!bc) return true; // global
      return bc === cityNorm;
    });
}

// =============== 🧠 VALIDADOR DE RUTA + SOLAPES ===============
async function isSlotFeasible(slotStart, newLocation, newDuration, rawBlock, existingAppointments) {
  const block = normalizeBlock(rawBlock);
  const config = SCHEDULE[block];
  const dayBase = spainDayStart(slotStart);

  const blockEndTime = setTime(dayBase, config.endHour, config.endMinute);

  const newAppt = {
    id: "NEW",
    start: new Date(slotStart),
    end: addMinutes(slotStart, newDuration),
    location: newLocation,
    duration: newDuration,
  };

  // debe terminar dentro del bloque
  if (newAppt.end > blockEndTime) return false;

  // Ordenar por hora
  const dailyRoute = [...existingAppointments, newAppt].sort((a, b) => a.start - b.start);

  // 1) Solapes por tiempo (lo más importante)
  for (let i = 0; i < dailyRoute.length - 1; i++) {
    const current = dailyRoute[i];
    const next = dailyRoute[i + 1];
    if (current.end > next.start) return false;
  }

  // 2) Simulación de viaje (con anti-zigzag)
  let currentLocation = HOME_ALGECIRAS;
  let simulatedTime = setTime(dayBase, 8, 0); // sales 08:00

  for (let i = 0; i < dailyRoute.length; i++) {
    const appt = dailyRoute[i];

    const travelMinutes = await getTravelTimeMinutes(currentLocation, appt.location);

    if (i > 0 && travelMinutes > MAX_TRAVEL_ALLOWED_BETWEEN_JOBS) {
      return false;
    }

    const arrivalTime = addMinutes(simulatedTime, travelMinutes + TRAVEL_MARGIN_MINUTES);

    // si llegas tarde: fuera
    if (arrivalTime > appt.start) return false;

    simulatedTime = appt.end;
    currentLocation = appt.location;
  }

  return true;
}

// =============== FIRESTORE FETCH ===============
async function getServiceByToken(token) {
  const doc = await db.collection("appointments").doc(token).get();
  if (!doc.exists) return null;

  const d = doc.data() || {};

  let originalDate = null;
  if (d.date && typeof d.date.toDate === "function") {
    originalDate = d.date.toDate();
  }

  return {
    token,
    serviceId: doc.id,
    address: d.address || "",
    city: d.city || "",
    zip: d.zip || "",
    name: d.clientName || "Cliente",
    phone: d.phone || d.phoneNumber || "",
    // duracion robusta (si viene como string/num)
    duration: parseDurationMinutes(d.estimatedDuration ?? d.duration ?? d.realDuration ?? SERVICE_DEFAULT_MIN),
    originalDate,
  };
}

async function getAppointmentsForDay(dayBaseES, block) {
  // rangos del día en hora Madrid
  const startES = spainDayStart(dayBaseES);
  const endES = addDays(startES, 1);

  const startTs = admin.firestore.Timestamp.fromDate(startES);
  const endTs = admin.firestore.Timestamp.fromDate(endES);

  const snap = await db
    .collection("appointments")
    .where("date", ">=", startTs)
    .where("date", "<", endTs)
    .get();

  const appts = [];

  for (const doc of snap.docs) {
    const data = doc.data() || {};
    if (!data.date || typeof data.date.toDate !== "function") continue;

    // ✅ convertir a “hora Madrid” para hour/minutes correctos
    const apptDateReal = data.date.toDate();
    const apptDateES = toSpainDate(apptDateReal);

    // Filtrado por bloque real (mañana/tarde) según horario
    const hour = apptDateES.getHours();
    const isMorning = hour < 15;

    if (normalizeBlock(block) === "morning" && !isMorning) continue;
    if (normalizeBlock(block) === "afternoon" && isMorning) continue;

    // ubicación
    let loc = HOME_ALGECIRAS;
    const addr = (data.address || "").trim();
    const city = (data.city || "").trim();

    if (addr) {
      try {
        const full = addr + (city ? ", " + city : "");
        loc = await geocodeAddress(full);
      } catch (_) {}
    }

    // ✅ duración robusta
    const realDuration = parseDurationMinutes(
      data.duration ?? data.estimatedDuration ?? data.realDuration ?? SERVICE_DEFAULT_MIN
    );

    // ✅ usar apptDateES para start/end (mismo “marco horario” que los slots)
    const start = apptDateES;
    const end = addMinutes(start, realDuration);

    appts.push({
      id: doc.id,
      start,
      end,
      location: loc,
      duration: realDuration,
    });
  }

  return appts;
}

// =============== HELPER: CREAR CAMBIO DE CITA PARA LA APP ===============
async function createChangeRequestForApp({ token, service, finalDate, startTime, endTime }) {
  const [h, m] = startTime.split(":").map((n) => parseInt(n, 10));
  const startHour = h;
  const block = startHour < 15 ? "morning" : "afternoon";

  let durationMinutes;
  if (endTime) {
    const [eh, em] = endTime.split(":").map((n) => parseInt(n, 10));
    durationMinutes = eh * 60 + em - (h * 60 + m);
  } else {
    durationMinutes = service?.duration || SERVICE_DEFAULT_MIN;
  }
  durationMinutes = parseDurationMinutes(durationMinutes);

  const computedEnd = endTime || formatTime(addMinutes(finalDate, durationMinutes));

  const docData = {
    token,
    appointmentId: service ? service.serviceId : null,
    requestedDate: admin.firestore.Timestamp.fromDate(finalDate),
    requestedDateString: finalDate.toISOString().slice(0, 10),
    requestedStartTime: startTime,
    requestedEndTime: computedEnd,
    requestedBlock: block,
    clientName: service ? service.name : "Desconocido",
    clientPhone: service ? service.phone : "",
    address: service ? service.address : "",
    city: service ? service.city : "",
    zip: service ? service.zip : "",
    originalDate: service?.originalDate ? admin.firestore.Timestamp.fromDate(service.originalDate) : null,
    status: "pending",
    source: "smartBooking",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  // Colección que lee la app
  const changeRef = await db.collection("appointmentChangeRequests").add(docData);

  // histórico opcional
  await db.collection("onlineAppointmentRequests").add(docData);

  return changeRef.id;
}

// =============== ADMIN AUTH (LOGIN) ===============
function getBearerToken(req) {
  const h = req.headers.authorization || "";
  const parts = h.split(" ");
  if (parts.length === 2 && parts[0] === "Bearer") return parts[1];
  return null;
}

function requireAdmin(req, res, next) {
  const token = getBearerToken(req);
  if (!token) return res.status(401).json({ error: "No auth" });

  try {
    if (!ADMIN_JWT_SECRET) return res.status(500).json({ error: "ADMIN_JWT_SECRET missing" });
    const payload = jwt.verify(token, ADMIN_JWT_SECRET);
    if (!payload || payload.role !== "admin") return res.status(403).json({ error: "Forbidden" });
    req.admin = payload;
    next();
  } catch (_) {
    return res.status(401).json({ error: "Invalid token" });
  }
}

// =============== ENDPOINTS BASE ===============
app.get("/", (req, res) => {
  res.json({ ok: true, service: "marsalva-smart-backend", time: new Date().toISOString() });
});

// =============== ADMIN: LOGIN ===============
app.post("/admin/login", async (req, res) => {
  try {
    const { user, pass } = req.body || {};

    if (!ADMIN_USER || !ADMIN_PASS || !ADMIN_JWT_SECRET) {
      return res.status(500).json({ error: "Admin env not configured" });
    }

    if (user !== ADMIN_USER || pass !== ADMIN_PASS) {
      return res.status(401).json({ error: "Bad credentials" });
    }

    const token = jwt.sign({ role: "admin", user: ADMIN_USER }, ADMIN_JWT_SECRET, { expiresIn: "12h" });
    res.json({ ok: true, token });
  } catch (e) {
    res.status(500).json({ error: "Login error" });
  }
});

// =============== ADMIN: BLOQUEOS ===============
app.get("/admin/blocks", requireAdmin, async (req, res) => {
  try {
    const now = getSpainNow();
    const to = addDays(now, 60);
    const fromKey = toDayKeyES(now);
    const toKey = toDayKeyES(to);

    const snap = await db.collection("calendarBlocks").orderBy("createdAt", "desc").limit(300).get();

    const itemsRaw = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const items = itemsRaw.filter((it) => {
      const keys = it.dayKeys || [];
      return keys.some((k) => k >= fromKey && k <= toKey);
    });

    res.json({ ok: true, items });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Blocks fetch error" });
  }
});

app.post("/admin/blocks", requireAdmin, async (req, res) => {
  try {
    let { startISO, endISO, allDay, reason, city } = req.body || {};

    const startD = new Date(startISO);
    const endD = new Date(endISO);
    if (isNaN(startD.getTime()) || isNaN(endD.getTime())) {
      return res.status(400).json({ error: "Bad dates" });
    }

    let startFinal = toSpainDate(startD);
    let endFinal = toSpainDate(endD);

    if (allDay) {
      const s = spainDayStart(startFinal);
      const e = new Date(s);
      e.setHours(23, 59, 0, 0);
      startFinal = s;
      endFinal = e;
    }

    if (endFinal <= startFinal) return res.status(400).json({ error: "End must be > start" });

    const dayKeys = buildDayKeysBetween(startFinal, endFinal);

    const doc = {
      start: admin.firestore.Timestamp.fromDate(startFinal),
      end: admin.firestore.Timestamp.fromDate(endFinal),
      allDay: !!allDay,
      reason: (reason || "").toString().slice(0, 200),
      city: (city || "").toString().trim(),
      dayKeys,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const ref = await db.collection("calendarBlocks").add(doc);
    res.json({ ok: true, id: ref.id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Blocks create error" });
  }
});

app.delete("/admin/blocks/:id", requireAdmin, async (req, res) => {
  try {
    await db.collection("calendarBlocks").doc(req.params.id).delete();
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Blocks delete error" });
  }
});

// =============== CITAS: AVAILABILITY SMART ===============
app.post("/availability-smart", async (req, res) => {
  try {
    const { token, block, rangeDays } = req.body;
    const range = rangeDays || 14;

    const service = await getServiceByToken(token);
    if (!service) return res.status(404).json({ error: "Token inválido" });

    // Geolocalizamos al NUEVO cliente
    const fullAddr = `${service.address}, ${service.city}, ${service.zip}`.trim();
    const clientLoc = await geocodeAddress(fullAddr);

    // Duración del nuevo servicio
    const newServiceDuration = parseDurationMinutes(service.duration || SERVICE_DEFAULT_MIN);

    const resultDays = [];
    const nowES = getSpainNow();

    for (let i = 0; i < range; i++) {
      const dayCandidate = addDays(nowES, i);
      const dayBaseES = spainDayStart(dayCandidate);

      // No findes
      if (isWeekendES(dayBaseES)) continue;

      // ✅ Bloqueos del día (globales o por ciudad del servicio)
      const dayKey = toDayKeyES(dayBaseES);
      const blocks = await getBlocksForDay(dayKey, service.city || "");

      // Si hay bloqueo día completo => saltar el día
      if (blocks.some((b) => b.allDay)) continue;

      const existingAppts = await getAppointmentsForDay(dayBaseES, block);
      const possibleStartTimes = generateSlotsForDayAndBlock(dayBaseES, block);

      const validSlots = [];

      for (const slotStart of possibleStartTimes) {
        // ✅ No ofrecer horas pasadas de HOY
        if (slotStart < nowES) continue;

        const slotEnd = addMinutes(slotStart, newServiceDuration);

        // ✅ Bloqueos horarios
        const blocked = blocks.some((b) => {
          if (!b.start || !b.end) return false;
          const bStart = toSpainDate(b.start);
          const bEnd = toSpainDate(b.end);
          return overlaps(slotStart, slotEnd, bStart, bEnd);
        });
        if (blocked) continue;

        // ✅ Validación anti-solapes + viaje + anti-zigzag
        const feasible = await isSlotFeasible(
          slotStart,
          clientLoc,
          newServiceDuration,
          block,
          existingAppts
        );

        if (feasible) {
          validSlots.push({
            startTime: formatTime(slotStart),
            endTime: formatTime(slotEnd),
          });
        }
      }

      if (validSlots.length > 0) {
        resultDays.push({
          date: dayKey,
          label: toSpainDate(dayBaseES).toLocaleDateString("es-ES", {
            weekday: "long",
            day: "numeric",
            month: "long",
          }),
          slots: validSlots,
        });
      }
    }

    res.json({ days: resultDays });
  } catch (e) {
    console.error("Error en /availability-smart:", e);
    res.status(500).json({ error: "Error interno" });
  }
});

// =============== CITAS: CREAR SOLICITUD (APP CAMBIO DE CITA) ===============
app.post("/appointment-request", async (req, res) => {
  try {
    const { token, date, startTime, endTime } = req.body;
    if (!token || !date || !startTime) {
      return res.status(400).json({ error: "Datos faltantes" });
    }

    // fecha en ES
    const [h, m] = startTime.split(":");
    const base = new Date(date);
    base.setHours(parseInt(h, 10), parseInt(m, 10), 0, 0);
    const finalDate = toSpainDate(base);

    const service = await getServiceByToken(token);

    const changeId = await createChangeRequestForApp({
      token,
      service,
      finalDate,
      startTime,
      endTime,
    });

    res.json({ ok: true, id: changeId });
  } catch (e) {
    console.error("Error en /appointment-request:", e);
    res.status(500).json({ error: "Error interno" });
  }
});

// Endpoint auxiliar para ver datos del cliente
app.post("/client-from-token", async (req, res) => {
  try {
    const { token } = req.body;
    const s = await getServiceByToken(token);
    if (!s) return res.status(404).json({ error: "No encontrado" });
    res.json(s);
  } catch (e) {
    res.status(500).json({ error: "Error interno" });
  }
});

app.listen(PORT, () => console.log(`✅ Marsalva Smart Backend V4 corriendo en puerto ${PORT}`));
