// server.js (V14 - FLEXIBLE CLUSTERING & STRICT TIME)
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

function toSpainDate(d=new Date()){return new Date(new Date(d).toLocaleString("en-US",{timeZone:"Europe/Madrid"}));}
function getSpainNow(){return toSpainDate(new Date());}
function addDays(d,days){return new Date(d.getTime() + days * 86400000);}

function getDistanceInKm(lat1, lon1, lat2, lon2) {
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

// =============== 4. ADMIN ENDPOINTS ===============

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

app.get("/admin/services/homeserve", verifyFirebaseUser, async (req, res) => {
    const snap = await db.collection("externalServices").where("provider", "==", "homeserve").get();
    const services = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json(services);
});

// =============== 5. LÓGICA DE CITAS FLEXIBLE (V14) ===============

app.post("/availability-smart", async (req, res) => {
  try {
    const { lat, lng, durationMinutes = 60 } = req.body;

    // AHORA: Verificamos si tenemos coordenadas válidas, pero NO bloqueamos si faltan.
    const hasCoords = (lat && lng && !isNaN(lat) && !isNaN(lng));

    const today = getSpainNow();
    const daysToCheck = 10;
    let availableSlots = [];

    // 1. Obtener rango
    const startRange = new Date(today);
    startRange.setHours(0,0,0,0);
    const endRange = addDays(startRange, daysToCheck);
    
    // 2. Cargar citas
    const snapshot = await db.collection("appointments")
      .where("date", ">=", startRange)
      .where("date", "<=", endRange)
      .get();

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

    // 3. Procesar días
    for (let i = 0; i < daysToCheck; i++) {
      const currentDay = addDays(today, i);
      const dayNum = currentDay.getDay();
      if (dayNum === 0 || dayNum === 6) continue; // No findes

      const dayApps = existingApps.filter(app => 
        app.start.getDate() === currentDay.getDate() &&
        app.start.getMonth() === currentDay.getMonth()
      );

      let dayIsBlockedByDistance = false;

      // === REGLA 1: CLUSTERING (SOLO SI HAY COORDENADAS) ===
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

      // Si se bloqueó por distancia, saltamos. Si no tenía coords, esto nunca es true.
      if (dayIsBlockedByDistance) continue; 

      // === REGLA 2: FRANJAS & DURACIÓN ===
      const blocks = [SCHEDULE.morning, SCHEDULE.afternoon];

      for (const block of blocks) {
        for (let hour = block.startHour; hour < block.endHour; hour++) {
          
          const slotStart = new Date(currentDay);
          slotStart.setHours(hour, 0, 0, 0);
          
          const windowEnd = new Date(currentDay);
          windowEnd.setHours(hour + 1, 0, 0, 0); // Visual: 9-10

          const workEnd = new Date(slotStart.getTime() + durationMinutes * 60000); // Real: 9-10:30

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

    const grouped = availableSlots.reduce((acc, slot) => {
      if (!acc[slot.date]) acc[slot.date] = [];
      acc[slot.date].push(slot);
      return acc;
    }, {});

    const responseArray = Object.keys(grouped).map(dateKey => ({
      date: dateKey,
      slots: grouped[dateKey]
    }));

    res.json({ days: responseArray });

  } catch (error) {
    console.error("Error availability:", error);
    // En caso de error fatal, devolvemos array vacío para no romper el front
    res.json({ days: [] }); 
  }
});

app.post("/appointment-request", async (req, res) => {
    try {
        const { slot, clientData, location, durationMinutes = 60 } = req.body; 
        
        await db.collection("appointments").add({
            date: admin.firestore.Timestamp.fromDate(new Date(slot.isoStart)),
            duration: durationMinutes, 
            client: clientData,
            location: location || null, // Guardamos null si no viene
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        res.json({ success: true });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

app.post("/client-from-token", async(req,res)=>{
  const d = await db.collection("appointments").doc(req.body.token).get();
  if(d.exists) res.json(d.data()); else res.status(404).json({});
});

app.listen(PORT, () => console.log(`✅ Marsalva Server V14 (Flexible) Running`));
