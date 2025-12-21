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

// ✅ Franjas exactas por hora (lo que pediste)
const SCHEDULE = {
  morning: { startHour: 9, startMinute: 0, endHour: 14, endMinute: 0 },
  afternoon: { startHour: 17, startMinute: 0, endHour: 20, endMinute: 0 },
};
const WINDOW_MINUTES = 60;
const MAX_KM_BETWEEN_VISITS = 5;

// =============== 3.1 UTILIDADES FECHAS / HORAS ===============
function toSpainDate(d = new Date()) {
  return new Date(new Date(d).toLocaleString("en-US", { timeZone: "Europe/Madrid" }));
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
function normalizeBlock(b) {
  const s = String(b || "").toLowerCase().trim();
  if (s === "afternoon" || s.includes("tard")) return "afternoon";
  return "morning";
}

// ✅ Parsea fechas en varios formatos: YYYY-MM-DD, DD/MM/YYYY, D/M/YYYY
function parseDateAny(v) {
  if (!v) return null;

  // Firestore Timestamp
  if (v?.toDate) {
    const d = toSpainDate(v.toDate());
    d.setHours(0, 0, 0, 0);
    return d;
  }

  const s = String(v).trim();

  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = toSpainDate(new Date(s + "T00:00:00"));
    d.setHours(0, 0, 0, 0);
    return d;
  }

  // DD/MM/YYYY or D/M/YYYY
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const dd = Number(m[1]);
    const mm = Number(m[2]);
    const yy = Number(m[3]);
    const d = toSpainDate(new Date(yy, mm - 1, dd));
    d.setHours(0, 0, 0, 0);
    return d;
  }

  return null;
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
  const loc = data?.results?.[0]?.geometry?.location;
  const out = loc && typeof loc.lat === "number" && typeof loc.lng === "number" ? loc : null;
  geocodeCache.set(full, out);
  return out;
}
function distanceKm(a, b) {
  if (!a || !b) return Infinity;
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s1 = Math.sin(dLat / 2) ** 2;
  const s2 =
    Math.cos((a.lat * Math.PI) / 180) *
    Math.cos((b.lat * Math.PI) / 180) *
    Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s1 + s2));
}

// =============== 3.3 LECTURA CITA EXISTENTE (MUY ROBUSTA) ===============

// Si tu agenda tiene estados, aquí puedes ampliar.
function isCancelledAppointment(data) {
  const st = String(data.status || data.state || data.robotStatus || "").toLowerCase();
  return data.cancelled === true || data.canceled === true || st.includes("cancel");
}

// Esto intenta sacar (date + start/end) de MUCHAS variantes de campos.
// Así no te vuelve a pasar lo de “lunes lleno pero te lo ofrece”.
function extractIntervalAny(doc) {
  const d = doc || {};

  // Campos de fecha posibles
  const baseDate =
    parseDateAny(d.date) ||
    parseDateAny(d.scheduledDate) ||
    parseDateAny(d.requestedDate) ||
    parseDateAny(d.day) ||
    parseDateAny(d.dateString) ||
    parseDateAny(d.requestedDateString) ||
    parseDateAny(d.startDate) ||
    parseDateAny(d.start) ||
    null;

  // Campos de start/end como HH:mm
  const st =
    parseHHMM(d.startTime) ||
    parseHHMM(d.requestedStartTime) ||
    parseHHMM(d.inicio) ||
    parseHHMM(d.horaInicio) ||
    parseHHMM(d.start_hour) ||
    null;

  const en =
    parseHHMM(d.endTime) ||
    parseHHMM(d.requestedEndTime) ||
    parseHHMM(d.fin) ||
    parseHHMM(d.horaFin) ||
    parseHHMM(d.end_hour) ||
    null;

  // Campos timestamp completos
  const startTs =
    (d.startDate?.toDate && toSpainDate(d.startDate.toDate())) ||
    (d.start?.toDate && toSpainDate(d.start.toDate())) ||
    (d.scheduledStart?.toDate && toSpainDate(d.scheduledStart.toDate())) ||
    null;

  const endTs =
    (d.endDate?.toDate && toSpainDate(d.endDate.toDate())) ||
    (d.end?.toDate && toSpainDate(d.end.toDate())) ||
    (d.scheduledEnd?.toDate && toSpainDate(d.scheduledEnd.toDate())) ||
    null;

  // Si tenemos timestamps reales: perfecto
  if (startTs && endTs) {
    const dateKey = formatDateYYYYMMDD(startTs);
    return { start: startTs, end: endTs, dateKey };
  }

  // Si tenemos baseDate + HH:mm
  if (baseDate && st && en) {
    const start = setTime(baseDate, st.h, st.m);
    const end = setTime(baseDate, en.h, en.m);
    const dateKey = formatDateYYYYMMDD(baseDate);
    return { start, end, dateKey };
  }

  // Si tenemos baseDate + start y duración
  const dur = parseDurationMinutes(d.durationMinutes || d.duration || 0);
  if (baseDate && st && dur) {
    const start = setTime(baseDate, st.h, st.m);
    const end = addMinutes(start, dur);
    const dateKey = formatDateYYYYMMDD(baseDate);
    return { start, end, dateKey };
  }

  return null;
}

async function loadBusyIntervals(fromDate, toDateExclusive) {
  // ✅ Aquí va la clave: NO dependemos de un where por "date".
  // Cargamos un bloque razonable de docs y filtramos por rango parseando.
  // Con 85 citas va sobrado y no rompe nada.

  let docs = [];
  try {
    // si tienes createdAt
    const snap = await db.collection("appointments").orderBy("createdAt", "desc").limit(1200).get();
    docs = snap.docs.map((x) => ({ id: x.id, ...x.data() }));
  } catch (e1) {
    try {
      // si no tienes createdAt, intenta updatedAt
      const snap = await db.collection("appointments").orderBy("updatedAt", "desc").limit(1200).get();
      docs = snap.docs.map((x) => ({ id: x.id, ...x.data() }));
    } catch (e2) {
      // fallback final
      const snap = await db.collection("appointments").limit(1200).get();
      docs = snap.docs.map((x) => ({ id: x.id, ...x.data() }));
    }
  }

  const out = [];
  for (const a of docs) {
    if (isCancelledAppointment(a)) continue;
    const it = extractIntervalAny(a);
    if (!it) continue;

    // Filtra por rango
    if (it.start >= toDateExclusive || it.end < fromDate) continue;

    out.push({
      id: a.id,
      dateKey: it.dateKey,
      start: it.start,
      end: it.end,
      city: String(a.city || a.locality || a.poblacion || "").trim(),
      address: String(a.address || a.direccion || "").trim(),
      lat: typeof a.lat === "number" ? a.lat : (a.location?.lat ?? null),
      lng: typeof a.lng === "number" ? a.lng : (a.location?.lng ?? null),
    });
  }

  return out;
}

// =============== 4. ENDPOINTS PROTEGIDOS (USAN verifyFirebaseUser) ===============

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
      { user, pass, lastChange: admin.firestore.FieldValue.serverTimestamp() },
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

// CLIENT INFO
app.post("/client-from-token", async (req, res) => {
  const token = String(req.body.token || "").trim();
  const d = await db.collection("appointments").doc(token).get();
  if (d.exists) res.json(d.data());
  else res.status(404).json({});
});

// ✅ AVAILABILITY SMART (FRANJAS 1H + NO SOLAPE + MISMA LOCALIDAD + 5KM si hay API)
app.post("/availability-smart", async (req, res) => {
  try {
    const token = String(req.body.token || "").trim();
    const block = normalizeBlock(req.body.block);
    const rangeDays = Math.min(30, Math.max(1, Number(req.body.rangeDays || 14)));

    if (!token) return res.status(400).json({ error: "Falta token" });

    const apDoc = await db.collection("appointments").doc(token).get();
    if (!apDoc.exists) return res.status(404).json({ error: "Token no encontrado" });
    const apData = apDoc.data() || {};

    const serviceCity = String(apData.city || apData.locality || apData.poblacion || "").trim();
    const serviceAddress = String(apData.address || apData.direccion || "").trim();
    const durationMin = parseDurationMinutes(apData.durationMinutes || apData.duration || 60);

    const now = toSpainDate(new Date());
    const startDay = toSpainDate(now);
    startDay.setHours(0, 0, 0, 0);
    const endDayExclusive = addDays(startDay, rangeDays);

    // ✅ Cargar ocupación real (robusto)
    const busy = await loadBusyIntervals(startDay, endDayExclusive);

    // Debug útil (Render logs)
    console.log(
      `📌 availability-smart block=${block} rangeDays=${rangeDays} busyIntervals=${busy.length}`
    );

    // Geo del servicio (solo si hay API)
    const serviceLoc =
      (typeof apData.lat === "number" && typeof apData.lng === "number")
        ? { lat: apData.lat, lng: apData.lng }
        : await geocodeAddress(serviceAddress, serviceCity);

    const daysOut = [];

    for (let i = 0; i < rangeDays; i++) {
      const day = addDays(startDay, i);
      if (isWeekendES(day)) continue;

      const dayKey = formatDateYYYYMMDD(day);
      const dayBusy = busy.filter((x) => x.dateKey === dayKey);

      // ✅ Regla “misma localidad”: si ese día ya hay citas con city, solo ofrecemos si coincide
      const focusCity = String(dayBusy.find((x) => x.city)?.city || "").trim();
      if (focusCity && serviceCity && focusCity.toLowerCase() !== serviceCity.toLowerCase()) {
        continue;
      }

      const sch = SCHEDULE[block];
      const blockStart = setTime(day, sch.startHour, sch.startMinute);
      const blockEnd = setTime(day, sch.endHour, sch.endMinute);

      // Franjas exactas: 09:00,10:00,11:00...
      let cursor = new Date(blockStart);
      cursor.setMinutes(0, 0, 0);

      // Por si blockStart no es hora exacta (aquí es 0, pero lo dejamos seguro)
      if (cursor < blockStart) cursor = addMinutes(cursor, 60);

      const slots = [];

      while (addMinutes(cursor, WINDOW_MINUTES) <= blockEnd) {
        const winStart = new Date(cursor);
        const winEnd = addMinutes(cursor, WINDOW_MINUTES);

        // La visita empieza al inicio de la franja; si dura más de 60, se permite mientras no salga del bloque
        const visitStart = winStart;
        const visitEnd = addMinutes(winStart, durationMin);

        if (visitEnd > blockEnd) {
          cursor = addMinutes(cursor, 60);
          continue;
        }

        // ✅ No solape con ocupadas
        const conflict = dayBusy.some((a) => overlaps(visitStart, visitEnd, a.start, a.end));
        if (conflict) {
          cursor = addMinutes(cursor, 60);
          continue;
        }

        // ✅ Regla 5km (solo si hay API y podemos geocodificar)
        if (dayBusy.length && GOOGLE_MAPS_API_KEY && serviceLoc) {
          let ok = true;
          for (const a of dayBusy) {
            const aLoc =
              (typeof a.lat === "number" && typeof a.lng === "number")
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

        // ✅ OK -> añadimos franja
        slots.push({ startTime: formatTime(winStart), endTime: formatTime(winEnd) });

        cursor = addMinutes(cursor, 60);
      }

      if (slots.length) {
        const label = day.toLocaleDateString("es-ES", {
          weekday: "long",
          day: "2-digit",
          month: "2-digit",
        });
        daysOut.push({ date: dayKey, label, slots });
      }
    }

    return res.json({ days: daysOut });
  } catch (e) {
    console.error("❌ availability-smart:", e);
    return res.status(500).json({ error: e.message });
  }
});

// ✅ APPOINTMENT REQUEST (igual que tu flujo de ChangeRequests)
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

    const requestedDate = admin.firestore.Timestamp.fromDate(new Date(date + "T00:00:00"));
    const requestedDateString = date;

    // 1) Guardar en la cita
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

    // 2) Crear changeRequest para que tu app lo vea
    await db.collection("changeRequests").add({
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

      clientName: ap.clientName || ap.name || ap.nombre || "",
      clientPhone: ap.phone || ap.clientPhone || "",
      address: ap.address || "",
      city: ap.city || "",
      zip: ap.zip || "",

      acceptedDate: null,
      resolvedAppointmentDocId: null,
    });

    return res.json({ success: true });
  } catch (e) {
    console.error("❌ appointment-request:", e);
    return res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`✅ Marsalva Server V11 (Secure Auth) Running`));
