// server.js (V11 - Firebase Auth + Availability Smart por franjas horarias)
"use strict";

const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");

// =============== 1) INICIALIZACIÓN FIREBASE ===============
if (!admin.apps.length) {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const rawPrivateKey = process.env.FIREBASE_PRIVATE_KEY;

  if (!projectId || !clientEmail || !rawPrivateKey) {
    console.error("❌ ERROR: Faltan variables FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY");
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
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 10000;

// =============== 2) SEGURIDAD (MIDDLEWARE) ===============
const verifyFirebaseUser = async (req, res, next) => {
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No autorizado. Falta token (Bearer)." });
  }
  const idToken = authHeader.slice("Bearer ".length).trim();
  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.user = decodedToken;
    return next();
  } catch (error) {
    console.error("❌ verifyIdToken:", error?.message || error);
    return res.status(403).json({ error: "Token inválido o caducado." });
  }
};

// =============== 3) CONFIG GLOBAL ===============
const HOME_ALGECIRAS = { lat: 36.1408, lng: -5.4562 };

// Para distancias y geocoding (recomendado para el filtro 5 km)
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || "";

// Cache en memoria (Render reinicia a veces, pero ayuda)
const geocodeCache = new Map();

const SCHEDULE = {
  // Ajustado a lo que pediste (por horas completas)
  morning: { startHour: 9, startMinute: 0, endHour: 14, endMinute: 0 },
  afternoon: { startHour: 17, startMinute: 0, endHour: 20, endMinute: 0 },
};

const SLOT_STEP_MIN = 60;          // slots cada 60 min (9-10, 10-11...)
const SLOT_DISPLAY_WINDOW_MIN = 60; // lo que ve el cliente (de 9 a 10, etc)
const MAX_HOP_KM = 5;               // no más de 5km entre visitas del mismo día
const DEFAULT_DURATION_MIN = 60;
const DEFAULT_RANGE_DAYS = 14;

// =============== 4) UTILIDADES FECHAS (Europe/Madrid) ===============
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
function setTime(baseDate, hour, minute) {
  const d = new Date(baseDate);
  d.setHours(hour, minute, 0, 0);
  return d;
}
function formatHHMM(d) {
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}
function isWeekendES(d) {
  const n = toSpainDate(d).getDay();
  return n === 0 || n === 6;
}
function isoDate(d) {
  const x = toSpainDate(d);
  const y = x.getFullYear();
  const m = String(x.getMonth() + 1).padStart(2, "0");
  const day = String(x.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function parseISODate(dateStr) {
  // "YYYY-MM-DD" -> Date en zona local, luego lo tratamos en Europe/Madrid con setTime()
  if (!dateStr || typeof dateStr !== "string") return null;
  const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]) - 1, da = Number(m[3]);
  const d = new Date(y, mo, da, 0, 0, 0, 0);
  return d;
}
function parseHHMMToMinutes(hhmm) {
  const m = String(hhmm || "").trim().match(/^(\d{2}):(\d{2})$/);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return hh * 60 + mm;
}
function normalizeBlock(b) {
  const v = String(b || "").trim().toLowerCase();
  if (!v) return "morning";

  if (v === "afternoon" || v === "tarde" || v === "pm") return "afternoon";
  if (v === "morning" || v === "mañana" || v === "manana" || v === "am") return "morning";

  // fallbacks por si llega raro
  if (v.includes("tard")) return "afternoon";
  if (v.includes("mañ") || v.includes("man")) return "morning";

  return "morning";
}
function pickDurationMinutes(tokenDoc) {
  const d = tokenDoc || {};
  const candidates = [
    d.durationMinutes,
    d.duration,
    d.estimatedDuration,
    d.serviceDurationMinutes,
    d.timeMinutes,
    d.minutes,
  ];
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c) && c > 0) return Math.max(15, Math.round(c));
    if (typeof c === "string" && c.trim() && !isNaN(Number(c))) return Math.max(15, Math.round(Number(c)));
  }
  return DEFAULT_DURATION_MIN;
}

// =============== 5) UTILIDADES DISTANCIA / GEO ===============
function cleanText(t) {
  return t ? String(t).replace(/\s+/g, " ").trim() : "";
}

function haversineKm(a, b) {
  if (!a || !b) return null;
  const R = 6371;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

async function geocodeAddress(address) {
  const q = cleanText(address);
  if (!q) return null;

  if (geocodeCache.has(q)) return geocodeCache.get(q);

  // Intento de cache persistente (opcional)
  try {
    const snap = await db.collection("geocodeCache").doc(Buffer.from(q).toString("base64")).get();
    if (snap.exists) {
      const data = snap.data() || {};
      if (data.lat && data.lng) {
        const loc = { lat: data.lat, lng: data.lng, city: data.city || "" };
        geocodeCache.set(q, loc);
        return loc;
      }
    }
  } catch (_) {}

  if (!GOOGLE_MAPS_API_KEY) {
    console.warn("⚠️ Sin GOOGLE_MAPS_API_KEY: no se puede geocodificar. (No bloqueo por distancia)");
    return null;
  }

  const url =
    "https://maps.googleapis.com/maps/api/geocode/json?address=" +
    encodeURIComponent(q) +
    "&key=" +
    encodeURIComponent(GOOGLE_MAPS_API_KEY);

  const resp = await fetch(url);
  if (!resp.ok) return null;
  const json = await resp.json();

  if (json.status !== "OK" || !json.results || !json.results[0]) return null;

  const r0 = json.results[0];
  const loc = r0.geometry?.location;
  if (!loc || typeof loc.lat !== "number" || typeof loc.lng !== "number") return null;

  // ciudad (si aparece)
  let city = "";
  const comps = r0.address_components || [];
  for (const c of comps) {
    const types = c.types || [];
    if (types.includes("locality")) city = c.long_name;
    if (!city && types.includes("postal_town")) city = c.long_name;
  }

  const out = { lat: loc.lat, lng: loc.lng, city: cleanText(city) };

  geocodeCache.set(q, out);
  try {
    await db.collection("geocodeCache").doc(Buffer.from(q).toString("base64")).set({
      address: q,
      lat: out.lat,
      lng: out.lng,
      city: out.city,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  } catch (_) {}

  return out;
}

async function getLocationFromDoc(data) {
  // soporta varios formatos típicos
  if (!data) return null;

  // 1) lat/lng directos
  if (typeof data.lat === "number" && typeof data.lng === "number") {
    return { lat: data.lat, lng: data.lng, city: cleanText(data.city || "") };
  }

  // 2) Firestore GeoPoint
  if (data.geo && typeof data.geo.latitude === "number" && typeof data.geo.longitude === "number") {
    return { lat: data.geo.latitude, lng: data.geo.longitude, city: cleanText(data.city || "") };
  }

  // 3) location {lat,lng}
  if (data.location && typeof data.location.lat === "number" && typeof data.location.lng === "number") {
    return { lat: data.location.lat, lng: data.location.lng, city: cleanText(data.city || "") };
  }

  // 4) address -> geocode
  const addr = cleanText(data.address || data.direccion || "");
  if (addr) {
    const g = await geocodeAddress(addr);
    if (g) return g;
  }

  return null;
}

async function distanceKm(locA, locB) {
  if (!locA || !locB) return null;
  // si tenemos coords, haversine
  const d = haversineKm({ lat: locA.lat, lng: locA.lng }, { lat: locB.lat, lng: locB.lng });
  if (typeof d === "number" && Number.isFinite(d)) return d;
  return null;
}

// =============== 6) LECTURA CITAS EXISTENTES ===============
function parseAppointmentInterval(data, fallbackDateISO) {
  // Devuelve { start: Date, end: Date } o null
  if (!data) return null;

  // A) startAt / endAt (Timestamp)
  const startAt = data.startAt?.toDate?.() || data.start?.toDate?.() || data.scheduledAt?.toDate?.() || null;
  const endAt = data.endAt?.toDate?.() || data.end?.toDate?.() || null;

  if (startAt instanceof Date && !isNaN(startAt)) {
    let end = endAt instanceof Date && !isNaN(endAt) ? endAt : null;
    if (!end) {
      const dur = pickDurationMinutes(data);
      end = addMinutes(startAt, dur);
    }
    return { start: toSpainDate(startAt), end: toSpainDate(end) };
  }

  // B) date + startTime/endTime
  const dateISO = cleanText(data.date || data.scheduledDate || data.day || fallbackDateISO || "");
  const base = parseISODate(dateISO);
  if (!base) return null;

  const stMin = parseHHMMToMinutes(data.startTime || data.scheduledStartTime || data.time || "");
  if (stMin == null) return null;

  const start = addMinutes(setTime(base, 0, 0), stMin);
  let end = null;

  const etMin = parseHHMMToMinutes(data.endTime || data.scheduledEndTime || "");
  if (etMin != null) {
    end = addMinutes(setTime(base, 0, 0), etMin);
  } else {
    const dur = pickDurationMinutes(data);
    end = addMinutes(start, dur);
  }

  return { start: toSpainDate(start), end: toSpainDate(end) };
}

function isBlockingStatus(data) {
  // considera qué citas “bloquean” agenda
  const st = String(data?.status || "").toLowerCase();

  // cancela/borra no bloquea
  if (st.includes("cancel")) return false;
  if (st.includes("archiv")) return false;

  // si marca explícito en calendario
  if (data?.inCalendar === true) return true;

  // estados típicos bloqueantes
  const ok = ["accepted", "scheduled", "confirmed", "calendar", "in_calendar", "alta", "en_curso", "done"];
  if (ok.includes(st)) return true;

  // si tiene startTime/startAt, asumimos que bloquea
  if (data?.startAt || data?.startTime) return true;

  return false;
}

async function fetchAppointmentsForDay(dayISO) {
  // Intentamos varias queries típicas (sin OR real en Firestore)
  const results = new Map();

  const tryQuery = async (field) => {
    try {
      const snap = await db.collection("appointments").where(field, "==", dayISO).get();
      snap.forEach((d) => results.set(d.id, d));
    } catch (_) {}
  };

  await tryQuery("date");
  await tryQuery("scheduledDate");
  await tryQuery("day");

  // fallback: si no hay nada, traemos últimos X y filtramos (evita “0 huecos” por schema diferente)
  if (results.size === 0) {
    try {
      const snap = await db.collection("appointments").orderBy("createdAt", "desc").limit(400).get();
      snap.forEach((d) => results.set(d.id, d));
    } catch (_) {}
  }

  const out = [];
  for (const doc of results.values()) {
    const data = doc.data() || {};
    // filtramos por día si venimos del fallback
    const interval = parseAppointmentInterval(data, dayISO);
    if (!interval) continue;

    const docDay = isoDate(interval.start);
    if (docDay !== dayISO) continue;

    if (!isBlockingStatus(data)) continue;

    out.push({ id: doc.id, data, interval });
  }

  // orden por hora
  out.sort((a, b) => a.interval.start - b.interval.start);
  return out;
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

// =============== 7) GENERAR DISPONIBILIDAD (por horas + 5km) ===============
async function buildAvailability({ tokenDoc, block, rangeDays }) {
  const now = getSpainNow();
  const durMin = pickDurationMinutes(tokenDoc);

  // ubicación del servicio (del token)
  const targetLoc = await getLocationFromDoc(tokenDoc);
  // si no hay, usamos un fallback (Algeciras) para que no “mate” el algoritmo
  const safeTargetLoc = targetLoc || HOME_ALGECIRAS;

  const days = [];

  for (let i = 0; i < rangeDays; i++) {
    const dayDate = addDays(now, i);
    if (isWeekendES(dayDate)) continue;

    const dayISO = isoDate(dayDate);

    const cfg = SCHEDULE[block] || SCHEDULE.morning;
    const dayStart = setTime(parseISODate(dayISO), cfg.startHour, cfg.startMinute);
    const dayEnd = setTime(parseISODate(dayISO), cfg.endHour, cfg.endMinute);

    const existing = await fetchAppointmentsForDay(dayISO);

    // Preparar locations de citas existentes (solo si hay API, porque puede costar)
    const existingWithLoc = [];
    for (const appt of existing) {
      const loc = await getLocationFromDoc(appt.data);
      existingWithLoc.push({ ...appt, loc });
    }

    // city del target si existe (para preferencia)
    const targetCity = cleanText((targetLoc && targetLoc.city) || tokenDoc.city || "");

    const slots = [];
    for (let t = new Date(dayStart); t < dayEnd; t = addMinutes(t, SLOT_STEP_MIN)) {
      // ventana mostrada al cliente (1h)
      const displayEnd = addMinutes(t, SLOT_DISPLAY_WINDOW_MIN);

      // reserva interna (duración real)
      const reserveEnd = addMinutes(t, durMin);
      if (reserveEnd > dayEnd) continue;

      // solape con existentes (usamos reserva real)
      let ok = true;
      for (const appt of existingWithLoc) {
        if (overlaps(t, reserveEnd, appt.interval.start, appt.interval.end)) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;

      // distancia con vecinos (si tenemos GOOGLE_MAPS_API_KEY o coords)
      // buscamos cita anterior (la que acaba más cerca antes de t) y posterior (la que empieza más cerca después de reserveEnd)
      let prev = null;
      let next = null;

      for (const appt of existingWithLoc) {
        if (appt.interval.end <= t) prev = appt;
        if (!next && appt.interval.start >= reserveEnd) next = appt;
      }

      // Si no tenemos API o coords, no bloqueamos por distancia (pero dejamos logs)
      if (GOOGLE_MAPS_API_KEY) {
        const prevLoc = prev?.loc || null;
        const nextLoc = next?.loc || null;

        if (prevLoc) {
          const dPrev = await distanceKm(prevLoc, safeTargetLoc);
          if (typeof dPrev === "number" && dPrev > MAX_HOP_KM) continue;
        }
        if (nextLoc) {
          const dNext = await distanceKm(safeTargetLoc, nextLoc);
          if (typeof dNext === "number" && dNext > MAX_HOP_KM) continue;
        }
      }

      // scoring: preferir días/slots con misma localidad
      let score = 0;
      if (targetCity) {
        // +2 si ese día ya tiene alguna cita en esa ciudad
        const sameCityCount = existingWithLoc.filter(x => cleanText(x.loc?.city || x.data.city || "") === targetCity).length;
        if (sameCityCount > 0) score += 2;
      }
      // +1 si ya hay citas ese día (agrupa trabajo)
      if (existingWithLoc.length > 0) score += 1;

      // slot listo
      slots.push({
        startTime: formatHHMM(t),
        endTime: formatHHMM(displayEnd),

        // extras (la web no los usa, pero tu app/servidor sí puede)
        _reserveEndTime: formatHHMM(reserveEnd),
        _score: score,
      });
    }

    if (slots.length > 0) {
      // ordenar slots por score desc y luego por hora
      slots.sort((a, b) => (b._score - a._score) || (parseHHMMToMinutes(a.startTime) - parseHHMMToMinutes(b.startTime)));

      // label bonito
      const label = new Intl.DateTimeFormat("es-ES", {
        weekday: "long",
        day: "2-digit",
        month: "2-digit",
      }).format(parseISODate(dayISO));

      // limpiar extras para el cliente (dejamos start/end)
      const cleanSlots = slots.map(s => ({ startTime: s.startTime, endTime: s.endTime }));

      days.push({
        date: dayISO,
        label: label.charAt(0).toUpperCase() + label.slice(1),
        slots: cleanSlots,
      });
    }
  }

  // Orden cronológico (más natural para el cliente)
  days.sort((a, b) => a.date.localeCompare(b.date));
  return days;
}

// =============== 8) ENDPOINTS ADMIN (PROTEGIDOS) ===============

// GET Config HomeServe
app.get("/admin/config/homeserve", verifyFirebaseUser, async (req, res) => {
  try {
    const doc = await db.collection("settings").doc("homeserve").get();
    if (!doc.exists) return res.json({ user: "", hasPass: false, lastChange: null });
    const data = doc.data();
    res.json({
      user: data.user || "",
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
    const { user, pass } = req.body || {};
    await db.collection("settings").doc("homeserve").set(
      { user: cleanText(user), pass: cleanText(pass), lastChange: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET / SAVE RENDER Config
app.get("/admin/config/render", verifyFirebaseUser, async (req, res) => {
  try {
    const doc = await db.collection("settings").doc("render_config").get();
    res.json(doc.exists ? doc.data() : { apiUrl: "", serviceId: "", apiKey: "" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/admin/config/render", verifyFirebaseUser, async (req, res) => {
  try {
    const { apiUrl, serviceId, apiKey } = req.body || {};
    await db.collection("settings").doc("render_config").set({
      apiUrl: cleanText(apiUrl),
      serviceId: cleanText(serviceId),
      apiKey: cleanText(apiKey),
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// SERVICIOS (GET, EDIT, DELETE)
app.get("/admin/services/homeserve", verifyFirebaseUser, async (req, res) => {
  try {
    const snap = await db.collection("externalServices").where("provider", "==", "homeserve").get();
    const services = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    res.json(services);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put("/admin/services/homeserve/:id", verifyFirebaseUser, async (req, res) => {
  try {
    const { client, address } = req.body || {};
    await db.collection("externalServices").doc(req.params.id).update({
      client: cleanText(client),
      address: cleanText(address),
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/admin/services/homeserve/delete", verifyFirebaseUser, async (req, res) => {
  try {
    const { ids } = req.body || {};
    const batch = db.batch();
    (ids || []).forEach((id) => batch.delete(db.collection("externalServices").doc(id)));
    await batch.commit();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =============== 9) ENDPOINTS PÚBLICOS (CLIENTE) ===============

// CLIENT INFO (la web manda {token})
app.post("/client-from-token", async (req, res) => {
  try {
    const token = cleanText(req.body?.token || "");
    if (!token) return res.status(400).json({ error: "Falta token." });

    const doc = await db.collection("appointments").doc(token).get();
    if (!doc.exists) return res.status(404).json({ error: "Token no encontrado." });

    const data = doc.data() || {};
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// AVAILABILITY SMART (devuelve days[])
app.post("/availability-smart", async (req, res) => {
  try {
    const token = cleanText(req.body?.token || "");
    const rawBlock = req.body?.block;
    const block = normalizeBlock(rawBlock);
    const rangeDays = Math.max(1, Math.min(30, Number(req.body?.rangeDays || DEFAULT_RANGE_DAYS)));

    if (!token) return res.status(400).json({ error: "Falta token." });

    const tokenSnap = await db.collection("appointments").doc(token).get();
    if (!tokenSnap.exists) return res.status(404).json({ error: "Token no encontrado." });

    const tokenDoc = tokenSnap.data() || {};

    console.log("✅ availability-smart:", { token, rawBlock, block, rangeDays });

    const days = await buildAvailability({ tokenDoc, block, rangeDays });

    return res.json({ days });
  } catch (e) {
    console.error("❌ /availability-smart:", e.message);
    return res.status(500).json({ error: e.message });
  }
});

// APPOINTMENT REQUEST (crea solicitud)
app.post("/appointment-request", async (req, res) => {
  try {
    const token = cleanText(req.body?.token || "");
    const rawBlock = req.body?.block;
    const block = normalizeBlock(rawBlock);

    const date = cleanText(req.body?.date || "");
    const startTime = cleanText(req.body?.startTime || "");
    const endTime = cleanText(req.body?.endTime || "");

    if (!token || !date || !startTime || !endTime) {
      return res.status(400).json({ error: "Faltan datos (token/date/startTime/endTime)." });
    }

    const base = parseISODate(date);
    const stMin = parseHHMMToMinutes(startTime);
    const etMin = parseHHMMToMinutes(endTime);
    if (!base || stMin == null || etMin == null) {
      return res.status(400).json({ error: "Formato inválido de date/startTime/endTime." });
    }

    // Verificamos token existe
    const tokenSnap = await db.collection("appointments").doc(token).get();
    if (!tokenSnap.exists) return res.status(404).json({ error: "Token no encontrado." });

    const tokenDoc = tokenSnap.data() || {};
    const durationMin = pickDurationMinutes(tokenDoc);

    // Guardamos en ChangeRequests (tu app ya lo escucha)
    const payload = {
      token,
      appointmentId: tokenDoc.appointmentId || token,
      source: "web_booking",
      status: "pending",

      requestedBlock: block,
      requestedDate: date,
      requestedDateString: date,
      requestedStartTime: startTime,
      requestedEndTime: endTime,

      // extra útil
      estimatedDurationMinutes: durationMin,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    // Si ya existe un changeRequest para ese token en estado pending, lo actualizamos
    const existingSnap = await db.collection("changeRequests")
      .where("token", "==", token)
      .where("status", "in", ["pending", "open"])
      .limit(1)
      .get();

    if (!existingSnap.empty) {
      const docId = existingSnap.docs[0].id;
      await db.collection("changeRequests").doc(docId).set({
        ...payload,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });

      return res.json({ success: true, updated: true });
    }

    await db.collection("changeRequests").add(payload);
    return res.json({ success: true });
  } catch (e) {
    console.error("❌ /appointment-request:", e.message);
    return res.status(500).json({ error: e.message });
  }
});

// Health
app.get("/", (req, res) => res.send("✅ Marsalva Smart Backend OK"));

// =============== 10) START ===============
app.listen(PORT, () => console.log(`✅ Marsalva Server V11 Running on :${PORT}`));
