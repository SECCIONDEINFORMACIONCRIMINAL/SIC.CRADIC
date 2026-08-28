/**
 * ============================================================
 * ARGOS SIC.CRADIC â€” Cloud Functions
 * Gestion de usuarios en Firebase Auth desde el cliente
 * ============================================================
 */

const functions = require('firebase-functions');
const admin = require('firebase-admin');

admin.initializeApp();

const auth = admin.auth();
const rtdb = admin.database();

const AUTH_CONFIG = {
  EMAIL_DOMAIN: 'cradic.gt',
  DEFAULT_PASSWORD: 'Cradic2024!',
};

async function verificarAdmin(context) {
  if (!context.auth) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'Debe iniciar sesion para realizar esta accion.'
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

function generarEmail(usuario) {
  const nombre = (usuario || 'usuario')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '.')
    .replace(/\.+/g, '.')
    .replace(/^\.|\.$/g, '');
  return `${nombre}@${AUTH_CONFIG.EMAIL_DOMAIN}`;
}

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

exports.crearUsuario = functions.https.onCall(async (data, context) => {
  await verificarAdmin(context);
  const { nombre, rol } = data;
  if (!nombre || typeof nombre !== 'string' || nombre.trim().length < 3) {
    throw new functions.https.HttpsError('invalid-argument', 'El nombre de usuario debe tener al menos 3 caracteres.');
  }
  if (!rol || typeof rol !== 'string') {
    throw new functions.https.HttpsError('invalid-argument', 'Debe especificar un rol valido.');
  }
  const email = generarEmail(nombre.trim());
  const claims = claimsPorRol(rol);
  try {
    try {
      await auth.getUserByEmail(email);
      throw new functions.https.HttpsError('already-exists', `Ya existe un usuario con el email ${email}.`);
    } catch (e) {
      if (e.code !== 'auth/user-not-found') throw e;
    }
    const userRecord = await auth.createUser({
      email: email,
      emailVerified: true,
      password: AUTH_CONFIG.DEFAULT_PASSWORD,
      displayName: nombre.trim(),
      disabled: false,
    });
    await auth.setCustomUserClaims(userRecord.uid, claims);
    const nuevaRef = rtdb.ref('usuariosSistema').push();
    await nuevaRef.set({
      usuario: nombre.trim(),
      rol: rol,
      authUid: userRecord.uid,
      authEmail: email,
      requiereCambioPass: true,
      fechaCreacion: admin.database.ServerValue.TIMESTAMP,
      creadoPor: context.auth.uid,
    });
    functions.logger.info(`Usuario creado: ${email} (${rol}) por ${context.auth.uid}`);
    return {
      success: true,
      uid: userRecord.uid,
      email: email,
      pushId: nuevaRef.key,
      mensaje: `Usuario ${nombre.trim()} creado. Email: ${email}. Contrasena temporal: ${AUTH_CONFIG.DEFAULT_PASSWORD}`,
    };
  } catch (error) {
    if (error.code && error.code.startsWith('functions/')) throw error;
    functions.logger.error('Error creando usuario:', error);
    throw new functions.https.HttpsError('internal', 'Error interno al crear usuario. Intente de nuevo.');
  }
});

exports.eliminarUsuario = functions.https.onCall(async (data, context) => {
  await verificarAdmin(context);
  const { pushId, authUid } = data;
  if (!pushId) {
    throw new functions.https.HttpsError('invalid-argument', 'Se requiere el pushId del usuario en RTDB.');
  }
  try {
    if (authUid) {
      try {
        await auth.updateUser(authUid, { disabled: true });
        functions.logger.info(`Auth deshabilitado: ${authUid}`);
      } catch (authError) {
        functions.logger.warn(`No se pudo deshabilitar Auth ${authUid}:`, authError.message);
      }
    }
    await rtdb.ref(`usuariosSistema/${pushId}`).update({
      eliminado: true,
      fechaEliminacion: admin.database.ServerValue.TIMESTAMP,
      eliminadoPor: context.auth.uid,
      authUid: null,
    });
    functions.logger.info(`Usuario eliminado: pushId=${pushId}, authUid=${authUid}, por=${context.auth.uid}`);
    return {
      success: true,
      mensaje: 'Usuario deshabilitado en Authentication y eliminado del sistema.',
    };
  } catch (error) {
    functions.logger.error('Error eliminando usuario:', error);
    throw new functions.https.HttpsError('internal', 'Error interno al eliminar usuario.');
  }
});

exports.cambiarRolUsuario = functions.https.onCall(async (data, context) => {
  await verificarAdmin(context);
  const { authUid, nuevoRol } = data;
  if (!authUid || !nuevoRol) {
    throw new functions.https.HttpsError('invalid-argument', 'Se requiere authUid y nuevoRol.');
  }
  if (authUid === context.auth.uid) {
    throw new functions.https.HttpsError('permission-denied', 'No puede cambiar su propio rol.');
  }
  const claims = claimsPorRol(nuevoRol);
  try {
    await auth.setCustomUserClaims(authUid, claims);
    const usuariosSnap = await rtdb.ref('usuariosSistema').orderByChild('authUid').equalTo(authUid).once('value');
    if (usuariosSnap.exists()) {
      const key = Object.keys(usuariosSnap.val())[0];
      await rtdb.ref(`usuariosSistema/${key}`).update({ rol: nuevoRol });
    }
    functions.logger.info(`Rol cambiado: ${authUid} -> ${nuevoRol} por ${context.auth.uid}`);
    return { success: true, claims: claims, mensaje: `Rol actualizado a: ${nuevoRol}` };
  } catch (error) {
    functions.logger.error('Error cambiando rol:', error);
    throw new functions.https.HttpsError('internal', 'Error interno al cambiar rol.');
  }
});

exports.restablecerPassword = functions.https.onCall(async (data, context) => {
  await verificarAdmin(context);
  const { authUid } = data;
  if (!authUid) {
    throw new functions.https.HttpsError('invalid-argument', 'Se requiere authUid.');
  }
  try {
    const userRecord = await auth.getUser(authUid);
    await auth.updateUser(authUid, { password: AUTH_CONFIG.DEFAULT_PASSWORD });
    const usuariosSnap = await rtdb.ref('usuariosSistema').orderByChild('authUid').equalTo(authUid).once('value');
    if (usuariosSnap.exists()) {
      const key = Object.keys(usuariosSnap.val())[0];
      await rtdb.ref(`usuariosSistema/${key}`).update({ requiereCambioPass: true });
    }
    functions.logger.info(`Password restablecido para ${authUid} por ${context.auth.uid}`);
    return {
      success: true,
      email: userRecord.email,
      mensaje: `Contrasena restablecida a: ${AUTH_CONFIG.DEFAULT_PASSWORD}. El usuario debe cambiarla al iniciar sesion.`,
    };
  } catch (error) {
    functions.logger.error('Error restableciendo password:', error);
    throw new functions.https.HttpsError('internal', 'Error interno al restablecer contrasena.');
  }
});

exports.sincronizarUsuariosAuth = functions.https.onCall(async (data, context) => {
  await verificarAdmin(context);
  try {
    const listUsersResult = await auth.listUsers();
    const authUsers = listUsersResult.users;
    const rtdbSnap = await rtdb.ref('usuariosSistema').once('value');
    const rtdbUsers = rtdbSnap.val() || {};
    const resultado = {
      auth: authUsers.length,
      rtdb: Object.keys(rtdbUsers).length,
      sincronizados: 0,
      inconsistentes: [],
    };
    for (const [pushId, rtdbUser] of Object.entries(rtdbUsers)) {
      if (rtdbUser.authUid) {
        const authUser = authUsers.find(u => u.uid === rtdbUser.authUid);
        if (!authUser) {
          resultado.inconsistentes.push({ pushId, tipo: 'auth_no_existe', authUid: rtdbUser.authUid });
        } else if (authUser.disabled && !rtdbUser.eliminado) {
          resultado.inconsistentes.push({ pushId, tipo: 'auth_deshabilitado_rtdb_activo', authUid: rtdbUser.authUid });
        }
      }
    }
    functions.logger.info('Sincronizacion completada', resultado);
    return { success: true, ...resultado };
  } catch (error) {
    functions.logger.error('Error sincronizando:', error);
    throw new functions.https.HttpsError('internal', 'Error interno al sincronizar.');
  }
});