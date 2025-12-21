// server.js (V11 - SEGURIDAD FIREBASE AUTH)
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

// ✅ Ventanas por hora (lo que quieres)
const SCHEDULE = {
  morning: { startHour: 9, startMinute: 0, endHour: 14, endMinute: 0 },
  afternoon: { startHour: 17, startMinute: 0, endHour: 20, endMinute: 0 },
};

// ✅ ya no queremos 30 mins
const SLOT_INTERVAL_MINUTES = 60;

// 🔒 regla de distancia
const MAX_KM_BETWEEN = 5;

// ===== Utilidades fecha (Madrid) =====
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
function normalizeBlock(b) {
  return (b || "").toLowerCase().includes("tard") ? "afternoon" : "morning";
}
function isWeekendES(d) {
  const n = toSpainDate(d).getDay();
  return n === 0 || n === 6;
}
function parseDurationMinutes(v) {
  if (typeof v === "number" && isFinite(v) && v > 0) return Math.round(v);
  const n = Number(v);
  if (isFinite(n) && n > 0) return Math.round(n);
  return 60;
}
function cleanStr(s) {
  return String(s || "").trim();
}
function normalizeCity(s) {
  return cleanStr(s).toLowerCase().replace(/\s+/g, " ");
}

// ===== Distancia (Haversine) =====
function toRad(x) {
  return (x * Math.PI) / 180;
}
function kmDistance(a, b) {
  if (!a || !b) return Infinity;
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;

  return 2 * R * Math.asin(Math.sqrt(h));
}

// ===== Geocoding =====
async function geocodeAddress(address) {
  const key = address.toLowerCase();
  if (geocodeCache.has(key)) return geocodeCache.get(key);

  if (!GOOGLE_MAPS_API_KEY) return null;

  const url =
    "https://maps.googleapis.com/maps/api/geocode/json?address=" +
    encodeURIComponent(address) +
    "&key=" +
    encodeURIComponent(GOOGLE_MAPS_API_KEY);

  const resp = await fetch(url);
  if (!resp.ok) return null;

  const data = await resp.json();
  if (!data.results || !data.results.length) return null;

  const r = data.results[0];
  const loc = r.geometry?.location;
  if (!loc) return null;

  let city = "";
  let zip = "";

  const comps = r.address_components || [];
  for (const c of comps) {
    const types = c.types || [];
    if (types.includes("locality")) city = c.long_name;
    if (types.includes("postal_code")) zip = c.long_name;
    // fallback por si “locality” no viene
    if (!city && types.includes("administrative_area_level_2")) city = c.long_name;
  }

  const out = { lat: loc.lat, lng: loc.lng, city: city || "", zip: zip || "" };
  geocodeCache.set(key, out);
  return out;
}

function extractLatLngFromAppointment(docData) {
  if (!docData) return null;

  // soportar varios formatos
  if (typeof docData.lat === "number" && typeof docData.lng === "number") return { lat: docData.lat, lng: docData.lng };
  if (docData.location && typeof docData.location.lat === "number" && typeof docData.location.lng === "number") {
    return { lat: docData.location.lat, lng: docData.location.lng };
  }
  if (docData.coords && typeof docData.coords.lat === "number" && typeof docData.coords.lng === "number") {
    return { lat: docData.coords.lat, lng: docData.coords.lng };
  }
  return null;
}

function pickDurationFromAppointment(docData) {
  return parseDurationMinutes(
    docData?.durationMinutes ??
      docData?.duration ??
      docData?.estimatedDuration ??
      docData?.estimatedMinutes ??
      60
  );
}

function pickDateFromAppointment(docData) {
  // esperado: Timestamp Firestore en "date"
  const ts = docData?.date;
  if (ts && typeof ts.toDate === "function") return ts.toDate();
  // fallback: dateISO string
  if (docData?.dateISO) {
    const d = new Date(docData.dateISO);
    if (!isNaN(d.getTime())) return d;
  }
  return null;
}

function formatDayLabelES(date) {
  const fmt = new Intl.DateTimeFormat("es-ES", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    timeZone: "Europe/Madrid",
  });
  // ej: "lun, 22 dic"
  return fmt.format(date).replace(".", "");
}

function toYMD(date) {
  const d = toSpainDate(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${da}`;
}

// =============== 4. ENDPOINTS PROTEGIDOS (USAN verifyFirebaseUser) ===============

// GET Config HomeServe
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

// SAVE Config HomeServe
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

// GET / SAVE RENDER Config
app.get("/admin/config/render", verifyFirebaseUser, async (req, res) => {
  const doc = await db.collection("settings").doc("render_config").get();
  res.json(doc.exists ? doc.data() : { apiUrl: "", serviceId: "", apiKey: "" });
});

app.post("/admin/config/render", verifyFirebaseUser, async (req, res) => {
  const { apiUrl, serviceId, apiKey } = req.body;
  await db.collection("settings").doc("render_config").set({ apiUrl, serviceId, apiKey });
  res.json({ success: true });
});

// SERVICIOS (GET, EDIT, DELETE)
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

// ✅ Calcula ventanas por hora y respeta 5km / agrupación por ciudad
app.post("/availability-smart", async (req, res) => {
  try {
    const token = cleanStr(req.body?.token);
    const block = normalizeBlock(req.body?.block);
    const rangeDays = Math.min(Math.max(Number(req.body?.rangeDays || 14), 3), 30);

    if (!token) return res.status(400).json({ error: "Falta token" });
    if (!SCHEDULE[block]) return res.status(400).json({ error: "Bloque inválido" });

    // 1) Cargar servicio por token
    const svcSnap = await db.collection("appointments").doc(token).get();
    if (!svcSnap.exists) return res.status(404).json({ error: "Token no encontrado" });

    const svc = svcSnap.data() || {};
    const svcAddress = cleanStr(svc.address || "");
    const svcCity = cleanStr(svc.city || svc.poblacion || "");
    const durationMin = pickDurationFromAppointment(svc);

    // Ventana necesaria (múltiplos de 60)
    const hoursNeeded = Math.ceil(durationMin / 60);
    const windowMinutes = hoursNeeded * 60;

    // 2) Obtener coords del servicio (lat/lng)
    let svcLoc = extractLatLngFromAppointment(svc);
    let geoCity = "";
    let geoZip = "";

    if (!svcLoc) {
      const fullAddr = [svcAddress, svcCity].filter(Boolean).join(", ");
      const geo = await geocodeAddress(fullAddr);
      if (!geo) {
        return res.status(500).json({
          error:
            "No puedo geocodificar (faltan lat/lng en la cita y GOOGLE_MAPS_API_KEY no está configurada).",
        });
      }
      svcLoc = { lat: geo.lat, lng: geo.lng };
      geoCity = geo.city || "";
      geoZip = geo.zip || "";
    }

    const targetCity = normalizeCity(svcCity || geoCity);

    // 3) Generar días candidatos
    const now = getSpainNow();
    const base = setTime(addDays(now, 1), 0, 0); // desde mañana
    const candidates = [];

    for (let i = 0; i < rangeDays; i++) {
      const day = addDays(base, i);
      if (isWeekendES(day)) continue;

      const dayStart = setTime(day, 0, 0);
      const dayEnd = addDays(dayStart, 1);

      // 4) Traer citas de ese día
      // Nota: si tu campo se llama distinto a "date", aquí hay que cambiarlo.
      const snap = await db
        .collection("appointments")
        .where("date", ">=", admin.firestore.Timestamp.fromDate(dayStart))
        .where("date", "<", admin.firestore.Timestamp.fromDate(dayEnd))
        .get();

      const appts = [];
      snap.forEach((d) => {
        const data = d.data() || {};
        // evitar comparar contra el mismo token (por si acaso)
        if (d.id === token) return;

        const startDate = pickDateFromAppointment(data);
        if (!startDate) return;

        appts.push({
          id: d.id,
          data,
          start: startDate,
          duration: pickDurationFromAppointment(data),
          city: normalizeCity(data.city || data.poblacion || ""),
          loc: extractLatLngFromAppointment(data), // si no hay coords, lo dejamos null (no rompe)
        });
      });

      // 5) Crear ventanas por hora dentro del bloque
      const sch = SCHEDULE[block];
      const blockStart = setTime(day, sch.startHour, sch.startMinute);
      const blockEnd = setTime(day, sch.endHour, sch.endMinute);

      const slots = [];
      for (let t = new Date(blockStart); addMinutes(t, windowMinutes) <= blockEnd; t = addMinutes(t, SLOT_INTERVAL_MINUTES)) {
        const slotStart = new Date(t);
        const slotEnd = addMinutes(slotStart, windowMinutes);

        // 6) No solapar con citas existentes
        let overlaps = false;
        for (const a of appts) {
          const aStart = toSpainDate(a.start);
          const aEnd = addMinutes(aStart, a.duration);
          if (slotStart < aEnd && slotEnd > aStart) {
            overlaps = true;
            break;
          }
        }
        if (!overlaps) {
          slots.push({
            startTime: formatTime(slotStart),
            endTime: formatTime(slotEnd),
          });
        }
      }

      if (!slots.length) continue;

      // 7) Regla 5km + scoring por ciudad
      // Si ese día ya tiene citas, exigimos que exista al menos una a <= 5 km (si tienen coords)
      let minKm = Infinity;
      let hasCoordsSome = false;

      for (const a of appts) {
        if (a.loc && typeof a.loc.lat === "number" && typeof a.loc.lng === "number") {
          hasCoordsSome = true;
          const km = kmDistance(svcLoc, a.loc);
          if (km < minKm) minKm = km;
        }
      }

      // Si hay citas en ese día pero ninguna tiene coords y no hay API key,
      // no podemos evaluar 5km => no filtramos, pero penalizamos.
      let distanceOk = true;
      let distancePenalty = 0;

      if (appts.length > 0) {
        if (hasCoordsSome) {
          distanceOk = minKm <= MAX_KM_BETWEEN;
        } else {
          distancePenalty = 30; // “no sé medir”, así que baja prioridad
        }
      }

      if (!distanceOk) continue;

      let score = 0;

      // prioridad por misma ciudad
      if (targetCity) {
        const sameCity = appts.some((a) => a.city && a.city === targetCity);
        if (sameCity) score += 100;
      }

      // prioridad por cercanía
      if (isFinite(minKm)) {
        if (minKm <= 2) score += 50;
        else if (minKm <= 5) score += 20;
        else score -= 20;
      }

      // penalizar días muy cargados
      score -= appts.length * 5;
      score -= distancePenalty;

      candidates.push({
        date: toYMD(day),
        label: formatDayLabelES(day),
        slots,
        _score: score,
      });
    }

    // 8) Seleccionar mejores y devolver en orden por fecha
    candidates.sort((a, b) => b._score - a._score || a.date.localeCompare(b.date));
    const top = candidates.slice(0, 12).sort((a, b) => a.date.localeCompare(b.date));

    res.json({
      days: top.map(({ _score, ...rest }) => rest),
      meta: {
        block,
        windowMinutes,
        maxKmBetween: MAX_KM_BETWEEN,
        usedGoogleGeocode: !!GOOGLE_MAPS_API_KEY,
      },
    });
  } catch (e) {
    console.error("availability-smart error:", e);
    res.status(500).json({ error: e.message });
  }
});

// ✅ Crea una solicitud (ChangeRequest) para que tú la aceptes en la app
app.post("/appointment-request", async (req, res) => {
  try {
    const token = cleanStr(req.body?.token);
    const block = normalizeBlock(req.body?.block);
    const date = cleanStr(req.body?.date); // "YYYY-MM-DD"
    const startTime = cleanStr(req.body?.startTime); // "09:00"
    const endTime = cleanStr(req.body?.endTime); // "10:00"

    if (!token || !date || !startTime || !endTime) {
      return res.status(400).json({ error: "Faltan datos" });
    }

    // Leer servicio original
    const apptSnap = await db.collection("appointments").doc(token).get();
    if (!apptSnap.exists) return res.status(404).json({ error: "Token no encontrado" });

    const appt = apptSnap.data() || {};
    const originalDate = pickDateFromAppointment(appt);

    // Guardar request
    const payload = {
      token,
      appointmentId: token,
      source: "web",
      status: "pending",

      clientName: cleanStr(appt.clientName || appt.name || ""),
      clientPhone: cleanStr(appt.phone || ""),
      address: cleanStr(appt.address || ""),
      city: cleanStr(appt.city || ""),
      zip: cleanStr(appt.zip || ""),

      requestedBlock: block,
      requestedDate: date,
      requestedDateString: date, // tu app ya lo usa así en logs
      requestedStartTime: startTime,
      requestedEndTime: endTime,

      originalDate: originalDate ? admin.firestore.Timestamp.fromDate(originalDate) : null,

      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      processedAt: null,
      acceptedDate: null,
      resolvedAppointmentDocId: null,
    };

    await db.collection("changeRequests").add(payload);

    res.json({ success: true });
  } catch (e) {
    console.error("appointment-request error:", e);
    res.status(500).json({ error: e.message });
  }
});

// CLIENT INFO
app.post("/client-from-token", async (req, res) => {
  const token = cleanStr(req.body?.token);
  if (!token) return res.status(400).json({ error: "Falta token" });

  const d = await db.collection("appointments").doc(token).get();
  if (d.exists) res.json(d.data());
  else res.status(404).json({});
});

app.listen(PORT, () => console.log(`✅ Marsalva Server V11 (Secure Auth) Running`));
