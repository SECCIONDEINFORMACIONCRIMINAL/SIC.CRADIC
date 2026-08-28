// v2 - fix crearUsuario y restablecerPassword
/**
 * ============================================================
 * ARGOS SIC.CRADIC — Cloud Functions
 * Gestión de usuarios en Firebase Auth desde el cliente
 * ============================================================
 * 
 * DEPLOY:
 *   cd functions
 *   npm install
 *   firebase deploy --only functions
 * 
 * NOTA: Estas funciones se llaman como Callable Functions
 * desde el cliente con functions.httpsCallable('nombre')
 * ============================================================
 */

const functions = require('firebase-functions');
const admin = require('firebase-admin');

// Inicializar Admin SDK
admin.initializeApp();

const auth = admin.auth();
const rtdb = admin.database();

// ─── CONFIGURACIÓN ────────────────────────────────────────────
const AUTH_CONFIG = {
  EMAIL_DOMAIN: 'cradic.gt',
  DEFAULT_PASSWORD: 'Cradic2024!',
  MIN_PASSWORD_LENGTH: 6,
};

// ─── HELPER: Verificar que el llamador es Administrador ──────

async function verificarAdmin(context) {
  if (!context.auth) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'Debe iniciar sesión para realizar esta acción.'
    );
  }
  
  const { admin: isAdmin, role } = context.auth.token || {};
  
  if (!isAdmin && role !== 'admin') {
    throw new functions.https.HttpsError(
      'permission-denied',
      'Solo los administradores pueden gestionar usuarios.'
    );
  }
  
  return context.auth.uid;
}

// ─── HELPER: Generar email a partir de nombre de usuario ─────

function generarEmail(usuarioLogin) {
  const nombre = (usuarioLogin || 'usuario')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '.')
    .replace(/\.+/g, '.')
    .replace(/^\.|\.$/g, '');
  
  return `${nombre}@${AUTH_CONFIG.EMAIL_DOMAIN}`;
}

// ─── HELPER: Mapa de roles a custom claims ──────────────────

function claimsPorRol(rolNombre) {
  const rol = (rolNombre || '').toLowerCase();
  
  const mapa = {
    'administrador general': { admin: true, role: 'admin' },
    'administrador': { admin: true, role: 'admin' },
    'ingresador extorsivos': { ingresador: true, role: 'ingresador' },
    'ingresador': { ingresador: true, role: 'ingresador' },
    'operador': { operador: true, role: 'operador' },
    'analista': { analista: true, role: 'analista' },
  };
  
  return mapa[rol] || { viewer: true, role: 'viewer' };
}

// ═════════════════════════════════════════════════════════════
// CLOUD FUNCTION: crearUsuario
// Crea un usuario en Firebase Auth + RTDB
// Parámetros: { nombre, usuario, pass, rol }
//   - nombre: Nombre completo (display name)
//   - usuario: Login name (se usa para generar el email)
//   - pass: Contraseña (mínimo 6 caracteres, si vacía usa DEFAULT_PASSWORD)
//   - rol: Rol del sistema
// ═════════════════════════════════════════════════════════════

exports.crearUsuario = functions.https.onCall(async (data, context) => {
  await verificarAdmin(context);
  
  const { nombre, usuario, pass, rol } = data;
  
  // Validaciones
  if (!nombre || typeof nombre !== 'string' || nombre.trim().length < 2) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'El nombre completo debe tener al menos 2 caracteres.'
    );
  }
  
  if (!usuario || typeof usuario !== 'string' || usuario.trim().length < 2) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'El nombre de usuario (login) debe tener al menos 2 caracteres.'
    );
  }
  
  if (!rol || typeof rol !== 'string') {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'Debe especificar un rol válido.'
    );
  }
  
  // Usar la contraseña proporcionada, o la por defecto
  let password = (pass && typeof pass === 'string' && pass.trim().length >= AUTH_CONFIG.MIN_PASSWORD_LENGTH)
    ? pass.trim()
    : AUTH_CONFIG.DEFAULT_PASSWORD;
  
  const usuarioLogin = usuario.trim().toLowerCase();
  const email = generarEmail(usuarioLogin);
  const claims = claimsPorRol(rol);
  
  try {
    // Verificar si ya existe en Auth
    try {
      await auth.getUserByEmail(email);
      throw new functions.https.HttpsError(
        'already-exists',
        `Ya existe un usuario con el email ${email} en Firebase Auth.`
      );
    } catch (e) {
      if (e.code !== 'auth/user-not-found') throw e;
    }
    
    // Crear en Firebase Auth
    const userRecord = await auth.createUser({
      email: email,
      emailVerified: true,
      password: password,
      displayName: nombre.trim(),
      disabled: false,
    });
    
    // Establecer custom claims
    await auth.setCustomUserClaims(userRecord.uid, claims);
    
    // Crear registro en RTDB
    const nuevaRef = rtdb.ref('usuariosSistema').push();
    await nuevaRef.set({
      nombre: nombre.trim(),
      usuario: usuarioLogin,
      rol: rol,
      estado: 'Activo',
      authUid: userRecord.uid,
      authEmail: email,
      requiereCambioPass: password === AUTH_CONFIG.DEFAULT_PASSWORD,
      fechaCreacion: admin.database.ServerValue.TIMESTAMP,
      creadoPor: context.auth.uid,
    });
    
    functions.logger.info(`Usuario creado: ${email} (${rol}) por ${context.auth.uid}`);
    
    const passwordMsg = password === AUTH_CONFIG.DEFAULT_PASSWORD
      ? `Contraseña temporal: ${AUTH_CONFIG.DEFAULT_PASSWORD}`
      : 'Contraseña personalizada establecida.';
    
    return {
      success: true,
      uid: userRecord.uid,
      email: email,
      pushId: nuevaRef.key,
      mensaje: `Usuario "${usuarioLogin}" creado. Email: ${email}. ${passwordMsg}`,
    };
    
  } catch (error) {
    if (error.code && error.code.startsWith('functions/')) throw error;
    
    functions.logger.error('Error creando usuario:', error);
    throw new functions.https.HttpsError(
      'internal',
      'Error interno al crear usuario. Intente de nuevo.'
    );
  }
});

// ═════════════════════════════════════════════════════════════
// CLOUD FUNCTION: eliminarUsuario
// Deshabilita en Auth + elimina de RTDB
// ═════════════════════════════════════════════════════════════

exports.eliminarUsuario = functions.https.onCall(async (data, context) => {
  await verificarAdmin(context);
  
  const { pushId, authUid } = data;
  
  if (!pushId) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'Se requiere el pushId del usuario en RTDB.'
    );
  }
  
  try {
    // Deshabilitar en Auth (más seguro que eliminar — preserva UID)
    if (authUid) {
      try {
        await auth.updateUser(authUid, { disabled: true });
        functions.logger.info(`Auth deshabilitado: ${authUid}`);
      } catch (authError) {
        functions.logger.warn(`No se pudo deshabilitar Auth ${authUid}:`, authError.message);
        // Continuar — puede que el usuario no esté en Auth aún
      }
    }
    
    // Marcar como eliminado en RTDB (soft delete para auditoría)
    await rtdb.ref(`usuariosSistema/${pushId}`).update({
      eliminado: true,
      fechaEliminacion: admin.database.ServerValue.TIMESTAMP,
      eliminadoPor: context.auth.uid,
      authUid: null,  // Desvincular
    });
    
    functions.logger.info(`Usuario eliminado: pushId=${pushId}, authUid=${authUid}, por=${context.auth.uid}`);
    
    return {
      success: true,
      mensaje: 'Usuario deshabilitado en Authentication y eliminado del sistema.',
    };
    
  } catch (error) {
    functions.logger.error('Error eliminando usuario:', error);
    throw new functions.https.HttpsError(
      'internal',
      'Error interno al eliminar usuario.'
    );
  }
});

// ═════════════════════════════════════════════════════════════
// CLOUD FUNCTION: cambiarRolUsuario
// Actualiza custom claims de un usuario
// ═════════════════════════════════════════════════════════════

exports.cambiarRolUsuario = functions.https.onCall(async (data, context) => {
  await verificarAdmin(context);
  
  const { authUid, nuevoRol } = data;
  
  if (!authUid || !nuevoRol) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'Se requiere authUid y nuevoRol.'
    );
  }
  
  // No permitir que un admin se quite sus propios permisos
  if (authUid === context.auth.uid) {
    throw new functions.https.HttpsError(
      'permission-denied',
      'No puede cambiar su propio rol.'
    );
  }
  
  const claims = claimsPorRol(nuevoRol);
  
  try {
    await auth.setCustomUserClaims(authUid, claims);
    
    // Actualizar rol en RTDB también
    const usuariosSnap = await rtdb.ref('usuariosSistema')
      .orderByChild('authUid')
      .equalTo(authUid)
      .once('value');
    
    if (usuariosSnap.exists()) {
      const key = Object.keys(usuariosSnap.val())[0];
      await rtdb.ref(`usuariosSistema/${key}`).update({ rol: nuevoRol });
    }
    
    functions.logger.info(`Rol cambiado: ${authUid} → ${nuevoRol} por ${context.auth.uid}`);
    
    return {
      success: true,
      claims: claims,
      mensaje: `Rol actualizado a: ${nuevoRol}`,
    };
    
  } catch (error) {
    functions.logger.error('Error cambiando rol:', error);
    throw new functions.https.HttpsError(
      'internal',
      'Error interno al cambiar rol.'
    );
  }
});

// ═════════════════════════════════════════════════════════════
// CLOUD FUNCTION: restablecerPassword
// Restablece la contraseña de un usuario
// Parámetros: { authUid, nuevaPassword? }
//   - Si se pasa nuevaPassword, se usa esa
//   - Si no, se restablece a la contraseña temporal por defecto
// ═════════════════════════════════════════════════════════════

exports.restablecerPassword = functions.https.onCall(async (data, context) => {
  await verificarAdmin(context);
  
  const { authUid, nuevaPassword } = data;
  
  if (!authUid) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'Se requiere authUid.'
    );
  }
  
  // Si se proporciona una nueva contraseña, validarla
  let password;
  if (nuevaPassword && typeof nuevaPassword === 'string' && nuevaPassword.trim().length >= AUTH_CONFIG.MIN_PASSWORD_LENGTH) {
    password = nuevaPassword.trim();
  } else {
    password = AUTH_CONFIG.DEFAULT_PASSWORD;
  }
  
  try {
    const userRecord = await auth.getUser(authUid);
    
    // Actualizar contraseña
    await auth.updateUser(authUid, {
      password: password,
    });
    
    // Marcar en RTDB si es contraseña temporal
    const usuariosSnap = await rtdb.ref('usuariosSistema')
      .orderByChild('authUid')
      .equalTo(authUid)
      .once('value');
    
    if (usuariosSnap.exists()) {
      const key = Object.keys(usuariosSnap.val())[0];
      await rtdb.ref(`usuariosSistema/${key}`).update({
        requiereCambioPass: password === AUTH_CONFIG.DEFAULT_PASSWORD,
      });
    }
    
    functions.logger.info(`Password restablecido para ${authUid} por ${context.auth.uid}`);
    
    const passwordMsg = password === AUTH_CONFIG.DEFAULT_PASSWORD
      ? `Contraseña restablecida a: ${AUTH_CONFIG.DEFAULT_PASSWORD}.`
      : 'Contraseña actualizada exitosamente.';
    
    return {
      success: true,
      email: userRecord.email,
      mensaje: passwordMsg,
    };
    
  } catch (error) {
    functions.logger.error('Error restableciendo password:', error);
    throw new functions.https.HttpsError(
      'internal',
      'Error interno al restablecer contraseña.'
    );
  }
});

// ═════════════════════════════════════════════════════════════
// CLOUD FUNCTION: sincronizarUsuariosAuth
// Sincroniza estado de Auth → RTDB (para consistencia)
// ═════════════════════════════════════════════════════════════

exports.sincronizarUsuariosAuth = functions.https.onCall(async (data, context) => {
  await verificarAdmin(context);
  
  try {
    // Obtener todos los usuarios de Auth
    const listUsersResult = await auth.listUsers();
    const authUsers = listUsersResult.users;
    
    // Obtener todos los usuarios de RTDB
    const rtdbSnap = await rtdb.ref('usuariosSistema').once('value');
    const rtdbUsers = rtdbSnap.val() || {};
    
    const resultado = {
      auth: authUsers.length,
      rtdb: Object.keys(rtdbUsers).length,
      sincronizados: 0,
      inconsistentes: [],
    };
    
    // Verificar consistencia
    for (const [pushId, rtdbUser] of Object.entries(rtdbUsers)) {
      if (rtdbUser.authUid) {
        const authUser = authUsers.find(u => u.uid === rtdbUser.authUid);
        if (!authUser) {
          resultado.inconsistentes.push({
            pushId,
            tipo: 'auth_no_existe',
            authUid: rtdbUser.authUid,
          });
        } else if (authUser.disabled && !rtdbUser.eliminado) {
          resultado.inconsistentes.push({
            pushId,
            tipo: 'auth_deshabilitado_rtdb_activo',
            authUid: rtdbUser.authUid,
          });
        }
      }
    }
    
    functions.logger.info('Sincronización completada', resultado);
    
    return {
      success: true,
      ...resultado,
    };
    
  } catch (error) {
    functions.logger.error('Error sincronizando:', error);
    throw new functions.https.HttpsError(
      'internal',
      'Error interno al sincronizar.'
    );
  }
});
