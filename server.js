// server.js (V11 - SEGURIDAD FIREBASE AUTH + AVAILABILITY SMART CON FRANJAS 1H)
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");

// =============== 1. INICIALIZACIÓN ===============
if (!admin.apps.length) {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const rawPrivateKey = process.env.FIREBASE_PRIVATE_KEY;

  if (!projectId || !clientEmail || !rawPrivateKey) {
    console.error("❌ ERROR: Faltan variables de Firebase.");
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
const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

const PORT = process.env.PORT || 10000;

// =============== 2. SEGURIDAD REAL (MIDDLEWARE) ===============
const verifyFirebaseUser = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No autorizado. Falta token." });
  }

  const idToken = authHeader.split("Bearer ")[1];

  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.user = decodedToken;
    next();
  } catch (error) {
    console.error("Error verificando token:", error);
    return res.status(403).json({ error: "Token inválido o caducado." });
  }
};

// =============== 3. CONFIGURACIÓN GLOBALES (CONSTANTES) ===============
const HOME_ALGECIRAS = { lat: 36.1408, lng: -5.4562 };
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || "";
const geocodeCache = new Map();

// ⬇️ Cambiado para permitir franjas 09:00–14:00 exactas
const SCHEDULE = {
  morning: { startHour: 9, startMinute: 0, endHour: 14, endMinute: 0 },
  afternoon: { startHour: 17, startMinute: 0, endHour: 20, endMinute: 0 },
};

// Franjas fijas de 60 min
const WINDOW_MINUTES = 60;

// Máxima distancia entre citas del mismo día (km)
const MAX_KM_BETWEEN_VISITS = 5;

// =============== 3.1 UTILIDADES FECHAS / HORAS ===============
function toSpainDate(d = new Date()) {
  return new Date(new Date(d).toLocaleString("en-US", { timeZone: "Europe/Madrid" }));
}
function getSpainNow() {
  return toSpainDate(new Date());
}
function addMinutes(d, m) {
  return new Date(d.getTime() + m * 60000);
}
function addDays(d, days) {
  return addMinutes(d, days * 24 * 60);
}
function setTime(base, h, m) {
  const d = new Date(base);
  d.setHours(h, m, 0, 0);
  return d;
}
function formatTime(d) {
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
}
function formatDateYYYYMMDD(d) {
  const x = toSpainDate(d);
  const y = x.getFullYear();
  const m = String(x.getMonth() + 1).padStart(2, "0");
  const day = String(x.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function normalizeBlock(b) {
  const s = String(b || "").toLowerCase();
  if (s.includes("tard")) return "afternoon";
  if (s.includes("after")) return "afternoon";
  return "morning";
}
function isWeekendES(d) {
  const n = toSpainDate(d).getDay();
  return n === 0 || n === 6;
}
function parseDurationMinutes(v) {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : 60;
}
function parseHHMM(hhmm) {
  const m = String(hhmm || "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if (h < 0 || h > 23 || mm < 0 || mm > 59) return null;
  return { h, m: mm };
}
function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

// =============== 3.2 GEO / DISTANCIA ===============
async function geocodeAddress(address, city) {
  if (!GOOGLE_MAPS_API_KEY) return null;

  const full = [address, city].filter(Boolean).join(", ").trim();
  if (!full) return null;

  if (geocodeCache.has(full)) return geocodeCache.get(full);

  const url =
    "https://maps.googleapis.com/maps/api/geocode/json?address=" +
    encodeURIComponent(full) +
    "&key=" +
    encodeURIComponent(GOOGLE_MAPS_API_KEY);

  const resp = await fetch(url);
  if (!resp.ok) return null;
  const data = await resp.json();
  if (!data.results || !data.results.length) return null;

  const loc = data.results[0].geometry?.location;
  const out = loc && typeof loc.lat === "number" && typeof loc.lng === "number" ? loc : null;
  geocodeCache.set(full, out);
  return out;
}

// Haversine km
function distanceKm(a, b) {
  if (!a || !b) return Infinity;
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s1 = Math.sin(dLat / 2) ** 2;
  const s2 = Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s1 + s2));
}

// =============== 3.3 LECTURA CITAS EXISTENTES ===============
function isCancelledAppointment(data) {
  const st = String(data.status || data.state || "").toLowerCase();
  return data.cancelled === true || data.canceled === true || st.includes("cancel");
}

// Intenta sacar date + start/end de varios formatos típicos
function extractAppointmentInterval(data) {
  // 1) date en string YYYY-MM-DD
  const dateStr = data.date || data.scheduledDateString || data.day;
  // 2) scheduledDate como Timestamp
  const scheduledTs = data.scheduledDate?.toDate ? data.scheduledDate.toDate() : null;
  // 3) start as Timestamp
  const startTs = data.start?.toDate ? data.start.toDate() : null;

  const startTime = data.startTime || data.start_hour || data.hourStart;
  const endTime = data.endTime || data.end_hour || data.hourEnd;

  let baseDate = null;
  if (typeof dateStr === "string" && /^\d{4}-\d{2}-\d{2}$/.test(dateStr.trim())) {
    baseDate = toSpainDate(new Date(dateStr.trim() + "T00:00:00"));
  } else if (scheduledTs) {
    baseDate = toSpainDate(scheduledTs);
    baseDate.setHours(0, 0, 0, 0);
  } else if (startTs) {
    baseDate = toSpainDate(startTs);
    baseDate.setHours(0, 0, 0, 0);
  }

  const st = parseHHMM(startTime);
  const en = parseHHMM(endTime);

  // Si tenemos timestamps completos, úsalo
  if (startTs && data.end?.toDate) {
    const s = toSpainDate(startTs);
    const e = toSpainDate(data.end.toDate());
    return { start: s, end: e, dateKey: formatDateYYYYMMDD(s) };
  }

  if (!baseDate || !st || !en) return null;

  const start = setTime(baseDate, st.h, st.m);
  const end = setTime(baseDate, en.h, en.m);
  return { start, end, dateKey: formatDateYYYYMMDD(baseDate) };
}

async function loadAppointmentsInRange(fromDate, toDateExclusive) {
  // OJO: Firestore no deja OR fácil; cargamos por rango de fechas si guardas "date" (YYYY-MM-DD).
  // Si no guardas "date", esto seguirá funcionando por fallback, pero será menos eficiente.
  const fromKey = formatDateYYYYMMDD(fromDate);
  const toKey = formatDateYYYYMMDD(addDays(toDateExclusive, 0)); // exclusivo

  let docs = [];

  // Si tienes el campo "date" como YYYY-MM-DD
  try {
    const snap = await db
      .collection("appointments")
      .where("date", ">=", fromKey)
      .where("date", "<", toKey)
      .get();
    docs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (e) {
    // Si no existe ese índice/campo, fallback: carga últimas N (no ideal, pero no rompe)
    const snap = await db.collection("appointments").orderBy("createdAt", "desc").limit(400).get();
    docs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  }

  // Filtra y normaliza a intervalos
  const intervals = [];
  for (const a of docs) {
    if (isCancelledAppointment(a)) continue;
    const it = extractAppointmentInterval(a);
    if (!it) continue;

    // Solo dentro de rango
    if (it.start >= toDateExclusive || it.end < fromDate) continue;

    intervals.push({
      id: a.id,
      dateKey: it.dateKey,
      start: it.start,
      end: it.end,
      city: (a.city || a.locality || "").toString().trim(),
      address: (a.address || a.direccion || "").toString().trim(),
      lat: typeof a.lat === "number" ? a.lat : (a.location?.lat ?? null),
      lng: typeof a.lng === "number" ? a.lng : (a.location?.lng ?? null),
    });
  }
  return intervals;
}

// =============== 4. ENDPOINTS PROTEGIDOS ===============
app.get("/admin/config/homeserve", verifyFirebaseUser, async (req, res) => {
  try {
    const doc = await db.collection("settings").doc("homeserve").get();
    if (!doc.exists) return res.json({ user: "", hasPass: false, lastChange: null });
    const data = doc.data();
    res.json({
      user: data.user,
      hasPass: !!data.pass,
      lastChange: data.lastChange ? data.lastChange.toDate().toISOString() : null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/admin/config/homeserve", verifyFirebaseUser, async (req, res) => {
  try {
    const { user, pass } = req.body;
    await db.collection("settings").doc("homeserve").set(
      {
        user,
        pass,
        lastChange: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/admin/config/render", verifyFirebaseUser, async (req, res) => {
  const doc = await db.collection("settings").doc("render_config").get();
  res.json(doc.exists ? doc.data() : { apiUrl: "", serviceId: "", apiKey: "" });
});

app.post("/admin/config/render", verifyFirebaseUser, async (req, res) => {
  const { apiUrl, serviceId, apiKey } = req.body;
  await db.collection("settings").doc("render_config").set({ apiUrl, serviceId, apiKey });
  res.json({ success: true });
});

app.get("/admin/services/homeserve", verifyFirebaseUser, async (req, res) => {
  const snap = await db.collection("externalServices").where("provider", "==", "homeserve").get();
  const services = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  res.json(services);
});

app.put("/admin/services/homeserve/:id", verifyFirebaseUser, async (req, res) => {
  const { client, address } = req.body;
  await db.collection("externalServices").doc(req.params.id).update({ client, address });
  res.json({ success: true });
});

app.post("/admin/services/homeserve/delete", verifyFirebaseUser, async (req, res) => {
  const { ids } = req.body;
  const batch = db.batch();
  ids.forEach((id) => batch.delete(db.collection("externalServices").doc(id)));
  await batch.commit();
  res.json({ success: true });
});

// =============== 5. ENDPOINTS PÚBLICOS (CITAS) ===============

// CLIENT INFO (token == docId)
app.post("/client-from-token", async (req, res) => {
  const token = String(req.body.token || "").trim();
  const d = await db.collection("appointments").doc(token).get();
  if (d.exists) res.json(d.data());
  else res.status(404).json({});
});

// === AVAILABILITY SMART ===
// Devuelve franjas de 1 hora, sin solapar con citas ya existentes, y respetando bloque.
app.post("/availability-smart", async (req, res) => {
  try {
    const token = String(req.body.token || "").trim();
    const block = normalizeBlock(req.body.block);
    const rangeDays = Math.min(30, Math.max(1, Number(req.body.rangeDays || 14)));

    if (!token) return res.status(400).json({ error: "Falta token" });

    // Cita/servicio del cliente (para dirección/ciudad)
    const apDoc = await db.collection("appointments").doc(token).get();
    if (!apDoc.exists) return res.status(404).json({ error: "Token no encontrado" });
    const apData = apDoc.data() || {};

    const serviceCity = String(apData.city || apData.locality || "").trim();
    const serviceAddress = String(apData.address || apData.direccion || "").trim();
    const durationMin = parseDurationMinutes(apData.durationMinutes || apData.duration || 60);

    // Rango fechas
    const now = getSpainNow();
    const startDay = toSpainDate(now);
    startDay.setHours(0, 0, 0, 0);
    const endDayExclusive = addDays(startDay, rangeDays);

    // Cargar citas existentes (ocupadas)
    const existing = await loadAppointmentsInRange(startDay, endDayExclusive);

    // Geocode del servicio (solo si hay API)
    const serviceLoc =
      typeof apData.lat === "number" && typeof apData.lng === "number"
        ? { lat: apData.lat, lng: apData.lng }
        : await geocodeAddress(serviceAddress, serviceCity);

    const daysOut = [];

    for (let i = 0; i < rangeDays; i++) {
      const day = addDays(startDay, i);
      if (isWeekendES(day)) continue;

      const dayKey = formatDateYYYYMMDD(day);

      const dayAppointments = existing.filter((x) => x.dateKey === dayKey);

      // Regla “misma localidad”: si ya hay citas ese día y hay city, exige ciudad igual
      const focusCity = dayAppointments.find((x) => x.city)?.city || "";
      if (focusCity && serviceCity && focusCity.toLowerCase() !== serviceCity.toLowerCase()) {
        continue;
      }

      // Generar franjas del bloque
      const sch = SCHEDULE[block];
      const blockStart = setTime(day, sch.startHour, sch.startMinute);
      const blockEnd = setTime(day, sch.endHour, sch.endMinute);

      // Franjas alineadas a la hora (09:00, 10:00…)
      // Ajuste: empezamos en la siguiente hora exacta desde blockStart
      let cursor = new Date(blockStart);
      cursor.setMinutes(0, 0, 0);

      if (cursor < blockStart) cursor = addMinutes(cursor, 60);

      const slots = [];

      while (addMinutes(cursor, WINDOW_MINUTES) <= blockEnd) {
        const winStart = new Date(cursor);
        const winEnd = addMinutes(cursor, WINDOW_MINUTES);

        // Para que la visita “quepa”, usamos durationMin desde el inicio de la franja.
        const visitStart = winStart;
        const visitEnd = addMinutes(winStart, durationMin);

        // 1) Debe caber dentro del bloque (y dentro de la franja si duration > 60, al menos que no pase del bloque)
        if (visitEnd > blockEnd) {
          cursor = addMinutes(cursor, 60);
          continue;
        }

        // 2) No solapar con citas existentes de ese día
        const conflict = dayAppointments.some((a) => overlaps(visitStart, visitEnd, a.start, a.end));
        if (conflict) {
          cursor = addMinutes(cursor, 60);
          continue;
        }

        // 3) Regla 5km (si podemos geocodificar)
        if (dayAppointments.length && GOOGLE_MAPS_API_KEY && serviceLoc) {
          // Geocode citas existentes si no traen lat/lng
          let ok = true;
          for (const a of dayAppointments) {
            const aLoc =
              typeof a.lat === "number" && typeof a.lng === "number"
                ? { lat: a.lat, lng: a.lng }
                : await geocodeAddress(a.address, a.city);

            const km = distanceKm(serviceLoc, aLoc);
            if (km > MAX_KM_BETWEEN_VISITS) {
              ok = false;
              break;
            }
          }
          if (!ok) {
            cursor = addMinutes(cursor, 60);
            continue;
          }
        }

        slots.push({
          startTime: formatTime(winStart),
          endTime: formatTime(winEnd),
        });

        cursor = addMinutes(cursor, 60);
      }

      // Si no hay slots, no devolvemos ese día
      if (slots.length) {
        const label = day.toLocaleDateString("es-ES", {
          weekday: "long",
          day: "2-digit",
          month: "2-digit",
        });
        daysOut.push({ date: dayKey, label, slots });
      }
    }

    // Preferencia: días donde ya tienes citas (misma ciudad) primero
    daysOut.sort((a, b) => {
      const aHas = existing.some((x) => x.dateKey === a.date);
      const bHas = existing.some((x) => x.dateKey === b.date);
      return Number(bHas) - Number(aHas);
    });

    return res.json({ days: daysOut });
  } catch (e) {
    console.error("❌ availability-smart:", e);
    return res.status(500).json({ error: e.message });
  }
});

// === APPOINTMENT REQUEST ===
// Guarda la solicitud del cliente (bloque + fecha + franja) y crea un ChangeRequest para tu app.
app.post("/appointment-request", async (req, res) => {
  try {
    const token = String(req.body.token || "").trim();
    const block = normalizeBlock(req.body.block);
    const date = String(req.body.date || "").trim(); // YYYY-MM-DD
    const startTime = String(req.body.startTime || "").trim(); // HH:mm
    const endTime = String(req.body.endTime || "").trim(); // HH:mm

    if (!token || !date || !startTime || !endTime) {
      return res.status(400).json({ error: "Faltan campos (token/date/startTime/endTime)" });
    }

    const apRef = db.collection("appointments").doc(token);
    const apSnap = await apRef.get();
    if (!apSnap.exists) return res.status(404).json({ error: "Token no encontrado" });

    const ap = apSnap.data() || {};

    const requestedDateString = date;
    const requestedDate = admin.firestore.Timestamp.fromDate(new Date(date + "T00:00:00"));

    const changePayload = {
      token,
      appointmentId: token,
      source: "web_client",
      status: "pending",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      processedAt: null,

      requestedBlock: block,
      requestedDate,
      requestedDateString,
      requestedStartTime: startTime,
      requestedEndTime: endTime,

      // Datos del cliente (si existen)
      clientName: ap.clientName || ap.name || ap.nombre || "",
      clientPhone: ap.phone || ap.clientPhone || "",
      address: ap.address || "",
      city: ap.city || "",
      zip: ap.zip || "",
      originalDate: ap.date || null,

      acceptedDate: null,
      resolvedAppointmentDocId: null,
    };

    // 1) Guarda la solicitud también en la cita
    await apRef.set(
      {
        requestedBlock: block,
        requestedDate,
        requestedDateString,
        requestedStartTime: startTime,
        requestedEndTime: endTime,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    // 2) Crea el changeRequest (tu app lo escucha)
    await db.collection("changeRequests").add(changePayload);

    return res.json({ success: true });
  } catch (e) {
    console.error("❌ appointment-request:", e);
    return res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`✅ Marsalva Server V11 (Secure Auth) Running on ${PORT}`));
