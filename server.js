// server.js (V17 - BASE V11 + SMART SLOTS ONLY)
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");

// =============== 1. INICIALIZACIÓN (INTACTO) ===============
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

// =============== 2. SEGURIDAD REAL (MIDDLEWARE) (INTACTO) ===============
const verifyFirebaseUser = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: "No autorizado. Falta token." });
  }

  const idToken = authHeader.split('Bearer ')[1];

  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.user = decodedToken; 
    next(); 
  } catch (error) {
    console.error("Error verificando token:", error);
    return res.status(403).json({ error: "Token inválido o caducado." });
  }
};

// =============== 3. CONFIGURACIÓN GLOBALES (INTACTO + NUEVOS UTILS) ===============
const HOME_ALGECIRAS = { lat: 36.1408, lng: -5.4562 };
const MAX_DISTANCE_KM = 5; // <--- NUEVA REGLA

// AJUSTE: Simplificado a horas enteras para tus franjas de 1h
const SCHEDULE = {
  morning: { startHour: 9, endHour: 14 },   
  afternoon: { startHour: 16, endHour: 20 }, 
};

// --- Funciones de utilidad ---
function toSpainDate(d=new Date()){return new Date(new Date(d).toLocaleString("en-US",{timeZone:"Europe/Madrid"}));}
function getSpainNow(){return toSpainDate(new Date());}
function addDays(d,days){return new Date(d.getTime() + days * 86400000);}

// NUEVO: Calcular distancia KM (Fórmula Haversine)
function getDistanceInKm(lat1, lon1, lat2, lon2) {
  if(!lat1 || !lon1 || !lat2 || !lon2) return 0;
  const R = 6371; 
  const dLat = (lat2 - lat1) * (Math.PI/180);
  const dLon = (lon2 - lon1) * (Math.PI/180);
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * (Math.PI/180)) * Math.cos(lat2 * (Math.PI/180)) * Math.sin(dLon/2) * Math.sin(dLon/2); 
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)); 
  return R * c;
}

// NUEVO: Verificar choque de horarios
function isOverlapping(startA, endA, startB, endB) {
  return startA < endB && startB < endA;
}

// NUEVO: Nombre bonito del día (ej: "Lunes 23 de Octubre")
function getDayLabel(dateObj) {
  const days = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
  const months = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  return `${days[dateObj.getDay()]} ${dateObj.getDate()} de ${months[dateObj.getMonth()]}`;
}


// =============== 4. ENDPOINTS PROTEGIDOS (INTACTO) ===============
// (Copio exactamente tus endpoints de admin V11)

app.get("/admin/config/homeserve", verifyFirebaseUser, async (req, res) => {
  try {
    const doc = await db.collection("settings").doc("homeserve").get();
    if (!doc.exists) return res.json({ user: "", hasPass: false, lastChange: null });
    const data = doc.data();
    res.json({
      user: data.user,
      hasPass: !!data.pass,
      lastChange: data.lastChange ? data.lastChange.toDate().toISOString() : null
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/admin/config/homeserve", verifyFirebaseUser, async (req, res) => {
  try {
    const { user, pass } = req.body;
    await db.collection("settings").doc("homeserve").set({
      user,
      pass,
      lastChange: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
    const services = snap.docs.map(d => ({ id: d.id, ...d.data() }));
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
    ids.forEach(id => batch.delete(db.collection("externalServices").doc(id)));
    await batch.commit();
    res.json({ success: true });
});


// =============== 5. ENDPOINTS PÚBLICOS (MODIFICADO SOLO ESTO) ===============

// AQUÍ VA LA LÓGICA NUEVA DE FRANJAS DE 1 HORA Y DISTANCIA
app.post("/availability-smart", async (req, res) => {
  try {
    const { lat, lng, durationMinutes = 60, timePreference, timeSlot } = req.body;
    const requestedTime = (timePreference || timeSlot || "").toLowerCase();

    // Verificamos si tenemos coordenadas válidas (si no, no aplicamos filtro distancia)
    const hasCoords = (lat && lng && !isNaN(lat) && !isNaN(lng));

    const today = getSpainNow();
    const daysToCheck = 10;
    let availableSlots = [];

    // 1. Traer rango de citas
    const startRange = new Date(today);
    startRange.setHours(0,0,0,0);
    const endRange = addDays(startRange, daysToCheck);
    
    const snapshot = await db.collection("appointments")
      .where("date", ">=", startRange)
      .where("date", "<=", endRange)
      .get();

    const existingApps = snapshot.docs.map(doc => {
      const data = doc.data();
      return {
        start: data.date.toDate(),
        end: new Date(data.date.toDate().getTime() + (data.duration || 60) * 60000),
        lat: data.location?.lat,
        lng: data.location?.lng
      };
    });

    // 2. Procesar Días
    for (let i = 0; i < daysToCheck; i++) {
      const currentDay = addDays(today, i);
      const dayNum = currentDay.getDay();
      if (dayNum === 0 || dayNum === 6) continue; // Saltar fin de semana

      // Citas que ya existen ese día
      const dayApps = existingApps.filter(app => 
        app.start.getDate() === currentDay.getDate() &&
        app.start.getMonth() === currentDay.getMonth()
      );

      // --- REGLA DISTANCIA (5KM) ---
      let dayIsBlockedByDistance = false;
      if (hasCoords && dayApps.length > 0) {
        for (const bookedApp of dayApps) {
          if (bookedApp.lat && bookedApp.lng) {
            const dist = getDistanceInKm(lat, lng, bookedApp.lat, bookedApp.lng);
            if (dist > MAX_DISTANCE_KM) {
              dayIsBlockedByDistance = true;
              break; 
            }
          }
        }
      }
      if (dayIsBlockedByDistance) continue; // Si está lejos, saltamos el día entero

      // --- FILTRO MAÑANA / TARDE ---
      let blocksToUse = [];
      if (requestedTime.includes('mañana') || requestedTime.includes('morning')) {
         blocksToUse.push(SCHEDULE.morning);
      } else if (requestedTime.includes('tarde') || requestedTime.includes('afternoon')) {
         blocksToUse.push(SCHEDULE.afternoon);
      } else {
         blocksToUse = [SCHEDULE.morning, SCHEDULE.afternoon];
      }

      // --- GENERAR SLOTS DE 1 HORA ---
      for (const block of blocksToUse) {
        for (let hour = block.startHour; hour < block.endHour; hour++) {
          
          const slotStart = new Date(currentDay);
          slotStart.setHours(hour, 0, 0, 0);
          
          const windowEnd = new Date(currentDay);
          windowEnd.setHours(hour + 1, 0, 0, 0); // Visual: 09:00 - 10:00

          const workEnd = new Date(slotStart.getTime() + durationMinutes * 60000); // Real: Duración trabajo

          if (slotStart < new Date()) continue; // No mostrar horas pasadas

          // Verificar colisión
          let isOccupied = false;
          for (const booked of dayApps) {
            if (isOverlapping(slotStart, workEnd, booked.start, booked.end)) {
              isOccupied = true;
              break;
            }
          }

          if (!isOccupied) {
            const startStr = slotStart.toLocaleTimeString("es-ES", { hour: '2-digit', minute: '2-digit' });
            const endStr = windowEnd.toLocaleTimeString("es-ES", { hour: '2-digit', minute: '2-digit' });
            
            availableSlots.push({
              date: slotStart.toISOString().split('T')[0],
              startTime: startStr,
              endTime: endStr,
              label: `${startStr} - ${endStr}`,
              message: `La visita se realizará entre las ${startStr} y las ${endStr}`,
              isoStart: slotStart.toISOString() 
            });
          }
        }
      }
    }

    // 3. Formatear Respuesta con Nombres de Días
    const grouped = availableSlots.reduce((acc, slot) => {
      if (!acc[slot.date]) acc[slot.date] = [];
      acc[slot.date].push(slot);
      return acc;
    }, {});

    const responseArray = Object.keys(grouped).map(dateKey => {
      const dateObj = new Date(dateKey); 
      const labelDia = getDayLabel(dateObj); // "Lunes 23 de Octubre"
      return {
        date: dateKey,
        dayLabel: labelDia, // Esto llena el título del día en la web
        title: labelDia,
        slots: grouped[dateKey]
      };
    });

    res.json({ days: responseArray });

  } catch (error) {
    console.error("Error availability:", error);
    res.json({ days: [] }); // En caso de error, devuelve vacío, no cuelga
  }
});

// Guardado de Cita (Actualizado para guardar lat/lng)
app.post("/appointment-request", async (req, res) => {
    try {
        const { slot, clientData, location, durationMinutes = 60 } = req.body; 
        
        await db.collection("appointments").add({
            date: admin.firestore.Timestamp.fromDate(new Date(slot.isoStart)),
            duration: durationMinutes,
            client: clientData,
            location: location || null, // Guardamos location para el futuro
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        res.json({ success: true });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

// CLIENT INFO (INTACTO)
app.post("/client-from-token", async(req,res)=>{
  const d = await db.collection("appointments").doc(req.body.token).get();
  if(d.exists) res.json(d.data()); else res.status(404).json({});
});

app.listen(PORT, () => console.log(`✅ Marsalva Server V17 (Stable V11 + Smart) Running`));
