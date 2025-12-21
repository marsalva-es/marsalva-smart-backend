"use strict";

const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");

// =============== 1) FIREBASE INIT ===============
if (!admin.apps.length) {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const rawPrivateKey = process.env.FIREBASE_PRIVATE_KEY;

  if (!projectId || !clientEmail || !rawPrivateKey) {
    console.error("❌ ERROR: faltan FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY");
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

// =============== 2) AUTH MIDDLEWARE ===============
const verifyFirebaseUser = async (req, res, next) => {
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No autorizado. Falta Bearer token." });
  }
  const idToken = authHeader.slice("Bearer ".length).trim();
  try {
    req.user = await admin.auth().verifyIdToken(idToken);
    return next();
  } catch (e) {
    console.error("❌ verifyIdToken:", e?.message || e);
    return res.status(403).json({ error: "Token inválido o caducado." });
  }
};

// =============== 3) CONFIG ===============
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || "";

// Franjas por horas (lo que ve el cliente)
const SCHEDULE = {
  morning: { startHour: 9, startMinute: 0, endHour: 14, endMinute: 0 },   // 09-10-11-12-13-14
  afternoon: { startHour: 17, startMinute: 0, endHour: 20, endMinute: 0 },// 17-18-19-20
};

const SLOT_STEP_MIN = 60;            // cada 1h
const SLOT_DISPLAY_WINDOW_MIN = 60;  // 9-10, 10-11...
const MAX_HOP_KM = 5;                // regla dura
const DEFAULT_DURATION_MIN = 60;
const DEFAULT_RANGE_DAYS = 14;

// Cache memoria + Firestore opcional
const geocodeCache = new Map();

// =============== 4) TIME HELPERS (Europe/Madrid) ===============
function toSpainDate(d = new Date()) {
  return new Date(new Date(d).toLocaleString("en-US", { timeZone: "Europe/Madrid" }));
}
function getSpainNow() { return toSpainDate(new Date()); }
function addMinutes(d, m) { return new Date(d.getTime() + m * 60000); }
function addDays(d, days) { return addMinutes(d, days * 24 * 60); }
function setTime(baseDate, hour, minute) {
  const d = new Date(baseDate);
  d.setHours(hour, minute, 0, 0);
  return d;
}
function isoDate(d) {
  const x = toSpainDate(d);
  const y = x.getFullYear();
  const m = String(x.getMonth() + 1).padStart(2, "0");
  const day = String(x.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function parseISODate(dateStr) {
  const m = String(dateStr || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
}
function formatHHMM(d) {
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}
function parseHHMMToMinutes(hhmm) {
  const m = String(hhmm || "").trim().match(/^(\d{2}):(\d{2})$/);
  if (!m) return null;
  const hh = Number(m[1]), mm = Number(m[2]);
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return hh * 60 + mm;
}
function isWeekendES(d) {
  const n = toSpainDate(d).getDay();
  return n === 0 || n === 6;
}
function cleanText(t) { return t ? String(t).replace(/\s+/g, " ").trim() : ""; }

function normalizeBlock(b) {
  const v = String(b || "").trim().toLowerCase();
  if (!v) return "morning";
  if (v === "afternoon" || v === "tarde" || v === "pm" || v.includes("tard")) return "afternoon";
  if (v === "morning" || v === "mañana" || v === "manana" || v === "am" || v.includes("mañ") || v.includes("man")) return "morning";
  return "morning";
}

function pickDurationMinutes(doc) {
  const d = doc || {};
  const candidates = [
    d.durationMinutes, d.duration, d.estimatedDuration, d.serviceDurationMinutes,
    d.timeMinutes, d.minutes
  ];
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c) && c > 0) return Math.max(15, Math.round(c));
    if (typeof c === "string" && c.trim() && !isNaN(Number(c))) return Math.max(15, Math.round(Number(c)));
  }
  return DEFAULT_DURATION_MIN;
}

// =============== 5) GEO / DIST ===============
function haversineKm(a, b) {
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

  // cache Firestore
  const cacheId = Buffer.from(q).toString("base64");
  try {
    const snap = await db.collection("geocodeCache").doc(cacheId).get();
    if (snap.exists) {
      const data = snap.data() || {};
      if (typeof data.lat === "number" && typeof data.lng === "number") {
        const loc = { lat: data.lat, lng: data.lng, city: cleanText(data.city || "") };
        geocodeCache.set(q, loc);
        return loc;
      }
    }
  } catch (_) {}

  if (!GOOGLE_MAPS_API_KEY) return null;

  const url =
    "https://maps.googleapis.com/maps/api/geocode/json?address=" +
    encodeURIComponent(q) +
    "&key=" +
    encodeURIComponent(GOOGLE_MAPS_API_KEY);

  const resp = await fetch(url);
  if (!resp.ok) return null;
  const json = await resp.json();
  if (json.status !== "OK" || !json.results?.[0]) return null;

  const r0 = json.results[0];
  const loc = r0.geometry?.location;
  if (!loc || typeof loc.lat !== "number" || typeof loc.lng !== "number") return null;

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
    await db.collection("geocodeCache").doc(cacheId).set({
      address: q, lat: out.lat, lng: out.lng, city: out.city,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  } catch (_) {}

  return out;
}

async function getLocationFromDoc(data) {
  if (!data) return null;

  // lat/lng directos
  if (typeof data.lat === "number" && typeof data.lng === "number") {
    return { lat: data.lat, lng: data.lng, city: cleanText(data.city || "") };
  }

  // Firestore GeoPoint
  if (data.geo && typeof data.geo.latitude === "number" && typeof data.geo.longitude === "number") {
    return { lat: data.geo.latitude, lng: data.geo.longitude, city: cleanText(data.city || "") };
  }

  // location {lat,lng}
  if (data.location && typeof data.location.lat === "number" && typeof data.location.lng === "number") {
    return { lat: data.location.lat, lng: data.location.lng, city: cleanText(data.city || "") };
  }

  // address -> geocode
  const addr = cleanText(data.address || data.direccion || "");
  if (addr) return await geocodeAddress(addr);

  return null;
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

// =============== 6) APPOINTMENTS FETCH (día) ===============
function parseAppointmentInterval(data, fallbackDayISO) {
  if (!data) return null;

  // startAt/endAt (Timestamp)
  const startAt = data.startAt?.toDate?.() || data.start?.toDate?.() || data.scheduledAt?.toDate?.() || null;
  const endAt = data.endAt?.toDate?.() || data.end?.toDate?.() || null;

  if (startAt instanceof Date && !isNaN(startAt)) {
    const start = toSpainDate(startAt);
    const dur = pickDurationMinutes(data);
    const end = (endAt instanceof Date && !isNaN(endAt)) ? toSpainDate(endAt) : addMinutes(start, dur);
    return { start, end };
  }

  // date + startTime
  const dayISO = cleanText(data.date || data.scheduledDate || data.day || fallbackDayISO || "");
  const base = parseISODate(dayISO);
  if (!base) return null;

  const stMin = parseHHMMToMinutes(data.startTime || data.scheduledStartTime || data.time || "");
  if (stMin == null) return null;

  const start = addMinutes(setTime(base, 0, 0), stMin);
  const dur = pickDurationMinutes(data);

  const etMin = parseHHMMToMinutes(data.endTime || data.scheduledEndTime || "");
  const end = (etMin != null) ? addMinutes(setTime(base, 0, 0), etMin) : addMinutes(start, dur);

  return { start: toSpainDate(start), end: toSpainDate(end) };
}

function isBlockingStatus(data) {
  const st = String(data?.status || "").toLowerCase();
  if (st.includes("cancel")) return false;
  if (st.includes("archiv")) return false;
  if (data?.inCalendar === true) return true;
  if (data?.startAt || data?.startTime) return true;
  return false;
}

async function fetchAppointmentsForDay(dayISO) {
  const results = new Map();

  const tryQuery = async (field) => {
    try {
      const snap = await db.collection("appointments").where(field, "==", dayISO).get();
      snap.forEach(d => results.set(d.id, d));
    } catch (_) {}
  };

  await tryQuery("date");
  await tryQuery("scheduledDate");
  await tryQuery("day");

  // fallback si tu schema es distinto
  if (results.size === 0) {
    try {
      const snap = await db.collection("appointments").orderBy("createdAt", "desc").limit(500).get();
      snap.forEach(d => results.set(d.id, d));
    } catch (_) {}
  }

  const out = [];
  for (const doc of results.values()) {
    const data = doc.data() || {};
    if (!isBlockingStatus(data)) continue;

    const interval = parseAppointmentInterval(data, dayISO);
    if (!interval) continue;

    const realDay = isoDate(interval.start);
    if (realDay !== dayISO) continue;

    out.push({ id: doc.id, data, interval });
  }

  out.sort((a, b) => a.interval.start - b.interval.start);
  return out;
}

// =============== 7) DAY SELECTION (localidad) ===============
function getCityName(tokenDoc, tokenLoc) {
  // prioridad: city del doc -> city del geocode
  const c1 = cleanText(tokenDoc?.city || tokenDoc?.locality || tokenDoc?.ciudad || "");
  const c2 = cleanText(tokenLoc?.city || "");
  return c1 || c2 || "";
}

function getApptCity(appt, apptLoc) {
  const c1 = cleanText(appt?.data?.city || appt?.data?.locality || appt?.data?.ciudad || "");
  const c2 = cleanText(apptLoc?.city || "");
  return c1 || c2 || "";
}

// =============== 8) AVAILABILITY (reglas duras) ===============
async function buildAvailability({ tokenDoc, block, rangeDays }) {
  const now = getSpainNow();
  const durMin = pickDurationMinutes(tokenDoc);

  const tokenLoc = await getLocationFromDoc(tokenDoc);
  const targetCity = getCityName(tokenDoc, tokenLoc);

  // 1) Pre-scan: analizar días con citas + ciudad
  const dayInfos = [];
  for (let i = 0; i < rangeDays; i++) {
    const dayDate = addDays(now, i);
    if (isWeekendES(dayDate)) continue;

    const dayISO = isoDate(dayDate);
    const existing = await fetchAppointmentsForDay(dayISO);

    const existingWithLoc = [];
    let unknownLocCount = 0;
    let sameCityCount = 0;

    for (const appt of existing) {
      const loc = await getLocationFromDoc(appt.data);
      if (!loc) unknownLocCount++;

      const apptCity = getApptCity(appt, loc);
      if (targetCity && apptCity && apptCity.toLowerCase() === targetCity.toLowerCase()) {
        sameCityCount++;
      }

      existingWithLoc.push({ ...appt, loc, apptCity });
    }

    dayInfos.push({
      dayISO,
      dateObj: parseISODate(dayISO),
      existing: existingWithLoc,
      sameCityCount,
      unknownLocCount,
      total: existingWithLoc.length,
      isEmpty: existingWithLoc.length === 0,
    });
  }

  // 2) Elegir los mejores días según reglas:
  //    - si hay ciudad objetivo: preferir días con esa ciudad
  //    - si no: preferir días vacíos
  //    - evitamos días que tengan citas pero sin localización si NO hay GOOGLE_KEY (porque no podremos aplicar 5km)
  const selectable = dayInfos
    .filter(d => d.dateObj)
    .map(d => {
      let score = 0;

      if (targetCity) {
        if (d.sameCityCount > 0) score += 100;     // misma ciudad: top
        else if (d.isEmpty) score += 70;           // día vacío: muy bien
        else score += 10;                          // otras ciudades: último
      } else {
        if (d.isEmpty) score += 80;
        else score += 20;
      }

      // preferir días con algo de curro (agrupa), pero sin pasarse
      if (!d.isEmpty) score += Math.min(10, d.total);

      // penalizar si no podemos aplicar distancia
      if (!GOOGLE_MAPS_API_KEY && d.total > 0) score -= 999; // sin API y hay citas => no garantizamos 5km

      // penalizar si hay muchas citas sin localización
      if (d.unknownLocCount > 0 && d.total > 0) score -= 30 * d.unknownLocCount;

      return { ...d, score };
    })
    .sort((a, b) => b.score - a.score || a.dayISO.localeCompare(b.dayISO));

  // cogemos top 3 días (para no marear al cliente)
  const bestDays = selectable.slice(0, 3);

  const daysOut = [];

  for (const day of bestDays) {
    const cfg = SCHEDULE[block] || SCHEDULE.morning;
    const dayStart = setTime(day.dateObj, cfg.startHour, cfg.startMinute);
    const dayEnd = setTime(day.dateObj, cfg.endHour, cfg.endMinute);

    // Si hay citas y no hay targetLoc, no podemos aplicar 5km => no proponemos nada
    if (day.total > 0 && !tokenLoc) {
      continue;
    }

    const slots = [];

    for (let t = new Date(dayStart); t < dayEnd; t = addMinutes(t, SLOT_STEP_MIN)) {
      const displayEnd = addMinutes(t, SLOT_DISPLAY_WINDOW_MIN);
      const reserveEnd = addMinutes(t, durMin);
      if (reserveEnd > dayEnd) continue;

      // 1) No solapar con existentes
      let ok = true;
      for (const appt of day.existing) {
        if (overlaps(t, reserveEnd, appt.interval.start, appt.interval.end)) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;

      // 2) Regla 5 km (DURA)
      // buscamos vecino anterior y siguiente por tiempo
      let prev = null;
      let next = null;

      for (const appt of day.existing) {
        if (appt.interval.end <= t) prev = appt;
        if (!next && appt.interval.start >= reserveEnd) next = appt;
      }

      // Si hay citas ese día, necesitamos poder medir distancias
      if (day.total > 0) {
        if (!GOOGLE_MAPS_API_KEY) {
          // sin API: NO garantizamos 5km => no damos slots
          ok = false;
        } else {
          // con API: necesitamos locs para vecinos (si existen)
          const prevLoc = prev?.loc || null;
          const nextLoc = next?.loc || null;

          // si hay vecino pero no tiene loc => no podemos aplicar regla => descartamos
          if (prev && !prevLoc) ok = false;
          if (next && !nextLoc) ok = false;

          if (ok) {
            if (prevLoc) {
              const dPrev = haversineKm(prevLoc, tokenLoc);
              if (dPrev > MAX_HOP_KM) ok = false;
            }
            if (ok && nextLoc) {
              const dNext = haversineKm(tokenLoc, nextLoc);
              if (dNext > MAX_HOP_KM) ok = false;
            }
          }
        }
      }

      if (!ok) continue;

      slots.push({ startTime: formatHHMM(t), endTime: formatHHMM(displayEnd) });
    }

    if (slots.length > 0) {
      const label = new Intl.DateTimeFormat("es-ES", {
        weekday: "long",
        day: "2-digit",
        month: "2-digit",
      }).format(day.dateObj);

      daysOut.push({
        date: day.dayISO,
        label: label.charAt(0).toUpperCase() + label.slice(1),
        slots,
      });
    }
  }

  // orden cronológico final
  daysOut.sort((a, b) => a.date.localeCompare(b.date));
  return daysOut;
}

// =============== 9) ADMIN ENDPOINTS (PROTEGIDOS) ===============

app.get("/admin/config/homeserve", verifyFirebaseUser, async (req, res) => {
  try {
    const doc = await db.collection("settings").doc("homeserve").get();
    if (!doc.exists) return res.json({ user: "", hasPass: false, lastChange: null });
    const data = doc.data() || {};
    res.json({
      user: data.user || "",
      hasPass: !!data.pass,
      lastChange: data.lastChange ? data.lastChange.toDate().toISOString() : null,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/admin/config/homeserve", verifyFirebaseUser, async (req, res) => {
  try {
    const { user, pass } = req.body || {};
    await db.collection("settings").doc("homeserve").set({
      user: cleanText(user),
      pass: cleanText(pass),
      lastChange: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/admin/config/render", verifyFirebaseUser, async (req, res) => {
  try {
    const doc = await db.collection("settings").doc("render_config").get();
    res.json(doc.exists ? doc.data() : { apiUrl: "", serviceId: "", apiKey: "" });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// =============== 10) CLIENT ENDPOINTS (PÚBLICOS) ===============

app.post("/client-from-token", async (req, res) => {
  try {
    const token = cleanText(req.body?.token || "");
    if (!token) return res.status(400).json({ error: "Falta token." });

    const doc = await db.collection("appointments").doc(token).get();
    if (!doc.exists) return res.status(404).json({ error: "Token no encontrado." });

    res.json(doc.data() || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/availability-smart", async (req, res) => {
  try {
    const token = cleanText(req.body?.token || "");
    const block = normalizeBlock(req.body?.block);
    const rangeDays = Math.max(1, Math.min(30, Number(req.body?.rangeDays || DEFAULT_RANGE_DAYS)));

    if (!token) return res.status(400).json({ error: "Falta token." });

    const tokenSnap = await db.collection("appointments").doc(token).get();
    if (!tokenSnap.exists) return res.status(404).json({ error: "Token no encontrado." });

    const tokenDoc = tokenSnap.data() || {};

    const days = await buildAvailability({ tokenDoc, block, rangeDays });

    // Si no hay GOOGLE_KEY y había citas, esto puede dar 0 días por regla dura
    return res.json({ days });
  } catch (e) {
    console.error("❌ /availability-smart:", e?.message || e);
    return res.status(500).json({ error: e.message });
  }
});

app.post("/appointment-request", async (req, res) => {
  try {
    const token = cleanText(req.body?.token || "");
    const block = normalizeBlock(req.body?.block);
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
      return res.status(400).json({ error: "Formato inválido." });
    }

    const tokenSnap = await db.collection("appointments").doc(token).get();
    if (!tokenSnap.exists) return res.status(404).json({ error: "Token no encontrado." });

    const tokenDoc = tokenSnap.data() || {};
    const durationMin = pickDurationMinutes(tokenDoc);

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
      estimatedDurationMinutes: durationMin,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

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
    console.error("❌ /appointment-request:", e?.message || e);
    return res.status(500).json({ error: e.message });
  }
});

app.get("/", (req, res) => res.send("✅ Marsalva Smart Backend OK"));

app.listen(PORT, () => console.log(`✅ Marsalva Server V11 Running on :${PORT}`));
