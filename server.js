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
// Esta función verifica que quien llama es un usuario real de tu Firebase
const verifyFirebaseUser = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: "No autorizado. Falta token." });
  }

  const idToken = authHeader.split('Bearer ')[1];

  try {
    // Preguntamos a Firebase: "¿Este token es real y válido?"
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.user = decodedToken; // Guardamos datos del usuario
    next(); // Todo OK, pasa.
  } catch (error) {
    console.error("Error verificando token:", error);
    return res.status(403).json({ error: "Token inválido o caducado." });
  }
};

// =============== 3. CONFIGURACIÓN GLOBALES (CONSTANTES) ===============
const HOME_ALGECIRAS = { lat: 36.1408, lng: -5.4562 };
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || "";
const geocodeCache = new Map();
const SCHEDULE = {
  morning: { startHour: 9, startMinute: 30, endHour: 14, endMinute: 0 },
  afternoon: { startHour: 17, startMinute: 0, endHour: 20, endMinute: 0 },
};
const SLOT_INTERVAL = 30;

// ... (Funciones de utilidad de fechas igual que antes: toSpainDate, etc) ...
// (Las resumo aquí para no ocupar espacio, pero DEBEN ESTAR en tu código)
function toSpainDate(d=new Date()){return new Date(new Date(d).toLocaleString("en-US",{timeZone:"Europe/Madrid"}));}
function getSpainNow(){return toSpainDate(new Date());}
function addMinutes(d,m){return new Date(d.getTime()+m*60000);}
function addDays(d,days){return addMinutes(d,days*24*60);}
function setTime(b,h,m){const d=new Date(b);d.setHours(h,m,0,0);return d;}
function formatTime(d){return`${d.getHours().toString().padStart(2,"0")}:${d.getMinutes().toString().padStart(2,"0")}`;}
function normalizeBlock(b){return(b||"").toLowerCase().includes("tard")?"afternoon":"morning";}
function isWeekendES(d){const n=toSpainDate(d).getDay();return n===0||n===6;}
function parseDurationMinutes(v){return typeof v==="number"?v:60;}

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
      lastChange: data.lastChange ? data.lastChange.toDate().toISOString() : null
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// SAVE Config HomeServe
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

// =============== 5. ENDPOINTS PÚBLICOS (CITAS) ===============
// (No llevan verifyFirebaseUser porque los usa el cliente final)

// ... (Aquí van tus funciones de availability-smart, appointment-request, etc. IGUAL QUE ANTES) ...
// Para ahorrar espacio no las copio todas de nuevo, pero deben estar aquí igual que en la V10
// Solo asegúrate de que app.post("/admin/login") YA NO EXISTA.

app.post("/availability-smart", async (req, res) => {
    // ... tu lógica de availability (copiar de V10) ...
    res.json({ days: [] }); // Placeholder para que completes con tu lógica V10
});

app.post("/appointment-request", async (req, res) => {
    // ... tu lógica de appointment-request (copiar de V10) ...
    res.json({ success: true });
});

// CLIENT INFO
app.post("/client-from-token", async(req,res)=>{
  const d = await db.collection("appointments").doc(req.body.token).get();
  if(d.exists) res.json(d.data()); else res.status(404).json({});
});

app.listen(PORT, () => console.log(`✅ Marsalva Server V11 (Secure Auth) Running`));
