// server.js (V16 - DEBUG MODE & SAFETY CHECKS)
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

// =============== 2. SEGURIDAD ===============
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

// =============== 3. UTILS ===============
const MAX_DISTANCE_KM = 5; 

const SCHEDULE = {
  morning: { startHour: 9, endHour: 14 },
  afternoon: { startHour: 16, endHour: 20 },
};

// Función de fecha más segura para evitar bloqueos
function toSpainDate(d = new Date()) {
  try {
    return new Date(new Date(d).toLocaleString("en-US", { timeZone: "Europe/Madrid" }));
  } catch (e) {
    return new Date(); // Fallback a fecha servidor si falla la conversión
  }
}
function getSpainNow() { return toSpainDate(new Date()); }
function addDays(d, days) { return new Date(d.getTime() + days * 86400000); }

// Función segura para obtener nombre del día
function getDayLabel(dateObj) {
  try {
    const days = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
    const months = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
    const dayName = days[dateObj.getDay()];
    const dayNum = dateObj.getDate();
    const monthName = months[dateObj.getMonth()];
    if (!dayName || !monthName) return "Fecha desconocida";
    return `${dayName} ${dayNum} de ${monthName}`;
  } catch (e) {
    return "Fecha inválida";
  }
}

function getDistanceInKm(lat1, lon1, lat2, lon2) {
  if(!lat1 || !lon1 || !lat2 || !lon2) return 0; // Evitar errores matemáticos
  const R = 6371; 
  const dLat = (lat2 - lat1) * (Math.PI/180);
  const dLon = (lon2 - lon1) * (Math.PI/180);
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * (Math.PI/180)) * Math.cos(lat2 * (Math.PI/180)) * Math.sin(dLon/2) * Math.sin(dLon/2); 
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)); 
  return R * c;
}

function isOverlapping(startA, endA, startB, endB) {
  return startA < endB && startB < endA;
}

// =============== 4. ADMIN ENDPOINTS (IGUAL) ===============
app.get("/admin/config/homeserve", verifyFirebaseUser, async (req, res) => {
  try {
    const doc = await db.collection("settings").doc("homeserve").get();
    if (!doc.exists) return res.json({ user: "", hasPass: false, lastChange: null });
    const data = doc.data();
    res.json({ user: data.user, hasPass: !!data.pass, lastChange: data.lastChange ? data.lastChange.toDate().toISOString() : null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/admin/config/homeserve", verifyFirebaseUser, async (req, res) => {
  try {
    const { user, pass } = req.body;
    await db.collection("settings").doc("homeserve").set({ user, pass, lastChange: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/admin/services/homeserve", verifyFirebaseUser, async (req, res) => {
    const snap = await db.collection("externalServices").where("provider", "==", "homeserve").get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
});

// =============== 5. LÓGICA DE CITAS (V16 - CON LOGS) ===============

app.post("/availability-smart", async (req, res) => {
  console.log("🔍 [1] Iniciando availability-smart..."); // LOG 1
  try {
    const { lat, lng, durationMinutes = 60, timePreference, timeSlot } = req.body;
    
    // Protección: Convertir a String seguro antes de toLowerCase
    const rawPref = timePreference || timeSlot || "";
    const requestedTime = String(rawPref).toLowerCase();
    
    console.log(`🔍 [2] Preferencia: ${requestedTime} | Coords: ${lat},${lng}`); // LOG 2

    const hasCoords = (lat && lng && !isNaN(Number(lat)) && !isNaN(Number(lng)));
    const today = getSpainNow();
    const daysToCheck = 10;
    let availableSlots = [];

    // 1. DB Range
    const startRange = new Date(today);
    startRange.setHours(0,0,0,0);
    const endRange = addDays(startRange, daysToCheck);
    
    console.log("🔍 [3] Consultando Firebase..."); // LOG 3
    const snapshot = await db.collection("appointments")
      .where("date", ">=", startRange)
      .where("date", "<=", endRange)
      .get();
    console.log(`🔍 [4] Firebase respondió. Citas encontradas: ${snapshot.size}`); // LOG 4

    const existingApps = snapshot.docs.map(doc => {
      const data = doc.data();
      const appDuration = data.duration || 60;
      return {
        start: data.date.toDate(),
        end: new Date(data.date.toDate().getTime() + appDuration * 60000),
        lat: data.location?.lat,
        lng: data.location?.lng
      };
    });

    // 2. Loop
    console.log("🔍 [5] Iniciando bucle de días..."); // LOG 5
    for (let i = 0; i < daysToCheck; i++) {
      const currentDay = addDays(today, i);
      const dayNum = currentDay.getDay();
      if (dayNum === 0 || dayNum === 6) continue; 

      const dayApps = existingApps.filter(app => 
        app.start.getDate() === currentDay.getDate() &&
        app.start.getMonth() === currentDay.getMonth()
      );

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
      if (dayIsBlockedByDistance) continue; 

      // Selección de bloques
      let blocksToUse = [];
      if (requestedTime.includes('mañana') || requestedTime.includes('morning')) {
         blocksToUse.push(SCHEDULE.morning);
      } else if (requestedTime.includes('tarde') || requestedTime.includes('afternoon')) {
         blocksToUse.push(SCHEDULE.afternoon);
      } else {
         blocksToUse = [SCHEDULE.morning, SCHEDULE.afternoon];
      }

      for (const block of blocksToUse) {
        for (let hour = block.startHour; hour < block.endHour; hour++) {
          const slotStart = new Date(currentDay);
          slotStart.setHours(hour, 0, 0, 0);
          
          const windowEnd = new Date(currentDay);
          windowEnd.setHours(hour + 1, 0, 0, 0); 
          const workEnd = new Date(slotStart.getTime() + durationMinutes * 60000); 

          if (slotStart < new Date()) continue;

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

    console.log(`🔍 [6] Bucle terminado. Slots generados: ${availableSlots.length}`); // LOG 6

    const grouped = availableSlots.reduce((acc, slot) => {
      if (!acc[slot.date]) acc[slot.date] = [];
      acc[slot.date].push(slot);
      return acc;
    }, {});

    const responseArray = Object.keys(grouped).map(dateKey => {
      const dateObj = new Date(dateKey); 
      const labelDia = getDayLabel(dateObj); 
      return {
        date: dateKey,       
        dayLabel: labelDia,  
        title: labelDia,     
        slots: grouped[dateKey]
      };
    });

    console.log("🔍 [7] Enviando respuesta..."); // LOG 7
    res.json({ days: responseArray });

  } catch (error) {
    console.error("❌ ERROR CRÍTICO en availability-smart:", error);
    res.json({ days: [] }); // Devolver array vacío para no colgar el front
  }
});

// ... resto de endpoints (guardado, etc) igual ...
app.post("/appointment-request", async (req, res) => {
    try {
        const { slot, clientData, location, durationMinutes = 60 } = req.body; 
        await db.collection("appointments").add({
            date: admin.firestore.Timestamp.fromDate(new Date(slot.isoStart)),
            duration: durationMinutes, 
            client: clientData,
            location: location || null,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/client-from-token", async(req,res)=>{
  const d = await db.collection("appointments").doc(req.body.token).get();
  if(d.exists) res.json(d.data()); else res.status(404).json({});
});

app.listen(PORT, () => console.log(`✅ Marsalva Server V16 (DEBUG MODE) Running`));
