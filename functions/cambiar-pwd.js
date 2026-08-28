const admin = require("firebase-admin");
admin.initializeApp({ credential: admin.credential.applicationDefault() });
admin.auth().updateUser("BUSCA_EL_UID", { password: "Cradic2024!" })
  .then(() => { console.log("Contraseña cambiada exitosamente!"); process.exit(0); })
  .catch(err => { console.error("Error:", err.message); process.exit(1); });
