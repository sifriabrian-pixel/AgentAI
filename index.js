// src/index.js
// Punto de entrada — conecta WhatsApp con el agente IA

import 'dotenv/config'
import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import pino from 'pino'
import qrcode from 'qrcode-terminal'
import cron from 'node-cron'

import { askClaude } from './claude.js'
import { getHistory, addToHistory, getLeadState, updateLeadState, getLeadsPendingFollowup } from './memory.js'

// ─── CONFIG ────────────────────────────────────────────────────────────────
const ASESOR_JID    = `${process.env.ASESOR_WHATSAPP}@s.whatsapp.net`
const AGENTE_MODO   = process.env.AGENTE_MODO || 'meta'
const CLIENTE_NOMBRE = process.env.CLIENTE_NOMBRE || 'Cliente'
const SESSION_PATH  = process.env.SESSION_PATH || './sessions'

// Logger silencioso para Baileys (evita spam en consola)
const baileysLogger = pino({ level: 'silent' })

// Logger de la app (visible y legible)
const logger = pino(pino.transport({
  target: 'pino-pretty',
  options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' }
}))

// ─── MENSAJES DE SEGUIMIENTO ───────────────────────────────────────────────
const FOLLOWUP_MSGS = {
  meta: {
    '24h': '¡Hola! 👋 Te escribo porque ayer te compartí info de uno de nuestros proyectos y quería saber si tuviste oportunidad de revisarla. ¿Sigue siendo de tu interés o preferís que te cuente otras opciones? Estoy aquí para ayudarte 🏗️',
    '48h': '¡Hola de nuevo! 😊 Sé que andás ocupado/a, pero quería dejarte saber que seguimos disponibles para ayudarte a encontrar el proyecto ideal. ¿Podemos retomar cuando tengas un momento?'
  },
  tuguru: {
    '24h': '¡Hola! 👋 Te escribo porque ayer te compartí info de una propiedad y quería saber si tuviste oportunidad de revisarla. ¿Sigue siendo de tu interés o prefieres que te muestre otras opciones? Estoy aquí para ayudarte 🏠',
    '48h': '¡Hola de nuevo! 😊 Sé que andas ocupado/a, pero quería dejarte saber que seguimos disponibles para ayudarte a encontrar la propiedad ideal. ¿Podemos retomar cuando tengas un momento?'
  }
}

// ─── NOTIFICACIÓN AL ASESOR ────────────────────────────────────────────────
async function notifyAsesor(sock, userId, responseText) {
  try {
    const msg =
      `🔔 *Nuevo lead calificado — Acción requerida*\n\n` +
      `📱 WhatsApp del prospecto: ${userId.replace('@s.whatsapp.net', '')}\n\n` +
      `💬 *Último mensaje del agente:*\n${responseText}\n\n` +
      `✅ *Acción sugerida:* Contactar al prospecto para confirmar la visita/reunión.`

    await sock.sendMessage(ASESOR_JID, { text: msg })
    logger.info(`✅ Asesor notificado sobre lead: ${userId}`)
  } catch (err) {
    logger.error({ err }, '❌ Error notificando al asesor')
  }
}

// ─── HANDLER PRINCIPAL DE MENSAJES ────────────────────────────────────────
async function handleMessage(sock, msg) {
  const jid = msg.key.remoteJid

  // Ignorar mensajes propios, de grupos y de estado
  if (msg.key.fromMe) return
  if (jid.endsWith('@g.us')) return
  if (jid === 'status@broadcast') return

  // Extraer texto del mensaje
  const text =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    null

  if (!text) return

  logger.info(`📩 [${jid}] "${text}"`)

  // Marcar como leído
  await sock.readMessages([msg.key])

  // Indicador "escribiendo..."
  await sock.sendPresenceUpdate('composing', jid)

  try {
    // Agregar mensaje del usuario al historial
    addToHistory(jid, 'user', text)

    // Llamar a Claude
    const { text: reply, triggers } = await askClaude(getHistory(jid), AGENTE_MODO)

    // Guardar respuesta en historial
    addToHistory(jid, 'assistant', reply)

    // Actualizar estado del lead
    const state = getLeadState(jid)
    updateLeadState(jid, { lastMessageAt: Date.now() })

    if (triggers.qualified && !state.qualified) {
      updateLeadState(jid, { qualified: true })
      logger.info(`🎯 Lead calificado: ${jid}`)
    }

    if (triggers.followup && !state.followupScheduled) {
      updateLeadState(jid, { followupScheduled: true })
      logger.info(`⏰ Seguimiento programado para: ${jid}`)
    }

    // Enviar respuesta al usuario
    await sock.sendPresenceUpdate('paused', jid)
    await sock.sendMessage(jid, { text: reply })

    // Si hay handoff → notificar al asesor
    if (triggers.handoff && !state.handoffDone) {
      updateLeadState(jid, { handoffDone: true })
      logger.info(`🔔 Handoff activado — notificando asesor`)
      await notifyAsesor(sock, jid, reply)
    }

  } catch (err) {
    logger.error({ err }, '❌ Error procesando mensaje')
    await sock.sendPresenceUpdate('paused', jid)

    const errMsg = AGENTE_MODO === 'meta'
      ? 'Perdoná, tuve un problema técnico. ¡Intentá de nuevo en un momento! 🙏'
      : 'Disculpa, tuve un problema técnico. ¡Intenta de nuevo en un momento! 🙏'

    await sock.sendMessage(jid, { text: errMsg })
  }
}

// ─── SCHEDULER DE SEGUIMIENTOS ─────────────────────────────────────────────
function startFollowupScheduler(sock) {
  // Revisar cada hora si hay leads pendientes de seguimiento
  cron.schedule('0 * * * *', async () => {
    const pending = getLeadsPendingFollowup()
    if (pending.length === 0) return

    logger.info(`⏰ Procesando ${pending.length} seguimiento(s) pendiente(s)`)

    for (const { userId, type } of pending) {
      try {
        const msg = FOLLOWUP_MSGS[AGENTE_MODO][type]
        await sock.sendMessage(userId, { text: msg })
        addToHistory(userId, 'assistant', msg)

        if (type === '24h') updateLeadState(userId, { followup24Sent: true })
        if (type === '48h') updateLeadState(userId, { followup48Sent: true })

        logger.info(`📤 Seguimiento ${type} enviado a ${userId}`)
      } catch (err) {
        logger.error({ err }, `❌ Error enviando seguimiento a ${userId}`)
      }
    }
  })

  logger.info('⏰ Scheduler de seguimientos activo (revisión cada hora)')
}

// ─── CONEXIÓN WHATSAPP ─────────────────────────────────────────────────────
async function connectWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH)
  const { version } = await fetchLatestBaileysVersion()

  logger.info(`🚀 Iniciando agente: ${CLIENTE_NOMBRE} (modo: ${AGENTE_MODO})`)
  logger.info(`📌 Versión de WhatsApp Web: ${version.join('.')}`)

  const sock = makeWASocket({
    version,
    logger: baileysLogger,
    auth: state,
    printQRInTerminal: false,   // lo manejamos nosotros con qrcode-terminal
    browser: ['Agente IA', 'Chrome', '1.0.0'],
    generateHighQualityLinkPreview: false
  })

  // Guardar credenciales cuando se actualicen
  sock.ev.on('creds.update', saveCreds)

  // Eventos de conexión
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      console.log('\n')
      logger.info('📱 Escaneá este QR con WhatsApp > Dispositivos vinculados > Vincular dispositivo:\n')
      qrcode.generate(qr, { small: true })
      console.log('\n')
    }

    if (connection === 'open') {
      logger.info('✅ WhatsApp conectado exitosamente')
      logger.info(`🤖 Agente activo y escuchando mensajes para ${CLIENTE_NOMBRE}`)
      startFollowupScheduler(sock)
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output?.statusCode
        : 0

      const shouldReconnect = statusCode !== DisconnectReason.loggedOut

      if (shouldReconnect) {
        logger.warn(`⚠️  Conexión cerrada (código ${statusCode}), reconectando en 5s...`)
        setTimeout(connectWhatsApp, 5000)
      } else {
        logger.error('🚫 Sesión cerrada (logout). Eliminá la carpeta sessions/ y volvé a escanear el QR.')
      }
    }
  })

  // Mensajes entrantes
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return
    for (const msg of messages) {
      await handleMessage(sock, msg)
    }
  })

  return sock
}

// ─── ARRANQUE ──────────────────────────────────────────────────────────────
connectWhatsApp().catch((err) => {
  logger.fatal({ err }, '💥 Error fatal al iniciar')
  process.exit(1)
})
