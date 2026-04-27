// index.js
// Agente WhatsApp — Villa Bienes Raíces

import 'dotenv/config'
import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import pino from 'pino'
import qrcode from 'qrcode-terminal'
import QRCode from 'qrcode'
import cron from 'node-cron'
import http from 'http'

import { askClaude, FOLLOWUP_MSGS } from './src/claude.js'
import { getHistory, addToHistory, getLeadState, updateLeadState, getLeadsPendingFollowup } from './src/memory.js'

// ─── CONFIG ────────────────────────────────────────────────────────────────
const ASESOR_WHATSAPP = process.env.ASESOR_WHATSAPP || ''
const ASESOR_JID      = ASESOR_WHATSAPP ? `${ASESOR_WHATSAPP}@s.whatsapp.net` : null
const SESSION_PATH    = './sessions'
const PORT            = process.env.PORT || 3000
const CLIENTE_NOMBRE  = 'Villa Bienes Raíces'

const baileysLogger = pino({ level: 'silent' })
const logger = pino(pino.transport({
  target: 'pino-pretty',
  options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' }
}))

// ─── ESTADO QR ─────────────────────────────────────────────────────────────
let currentQR   = null
let isConnected = false

// ─── SERVIDOR WEB QR ───────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  if (req.url === '/qr') {
    if (isConnected) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Agente Activo</title>
        <style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#128C7E;}
        .box{background:white;padding:40px;border-radius:16px;text-align:center;}h2{color:#075E54;}</style></head>
        <body><div class="box"><h2>✅ WhatsApp Conectado</h2>
        <p>El agente de <strong>${CLIENTE_NOMBRE}</strong> está activo.</p>
        <p style="color:#25D366;font-size:22px;">🤖 En línea 24/7</p></div></body></html>`)
      return
    }
    if (!currentQR) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="3">
        <title>Generando QR...</title>
        <style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#128C7E;}
        .box{background:white;padding:40px;border-radius:16px;text-align:center;}h2{color:#075E54;}</style></head>
        <body><div class="box"><h2>⏳ Generando QR...</h2>
        <p>La página se actualizará en 3 segundos.</p></div></body></html>`)
      return
    }
    try {
      const qrImage = await QRCode.toDataURL(currentQR, { width: 300, margin: 2 })
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(`<!DOCTYPE html><html><head><meta charset="utf-8">
        <meta http-equiv="refresh" content="30">
        <title>Escanear QR — ${CLIENTE_NOMBRE}</title>
        <style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#128C7E;}
        .box{background:white;padding:40px;border-radius:16px;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,0.2);}
        h2{color:#075E54;margin-bottom:4px;}p{color:#555;font-size:14px;}
        img{border:4px solid #075E54;border-radius:8px;margin:16px 0;}
        .steps{text-align:left;background:#f5f5f5;padding:16px;border-radius:8px;margin-top:12px;font-size:13px;line-height:1.8;}
        </style></head>
        <body><div class="box">
        <h2>📱 Vincular WhatsApp</h2>
        <p>Agente: <strong>${CLIENTE_NOMBRE}</strong> — El QR expira en 60 segundos</p>
        <img src="${qrImage}" alt="QR Code" width="280"/>
        <div class="steps"><strong>Pasos:</strong><br>
        1. Abrí WhatsApp en el teléfono<br>
        2. Tocá los 3 puntitos ⋮ → Dispositivos vinculados<br>
        3. Tocá "Vincular dispositivo"<br>
        4. Escaneá este QR</div>
        </div></body></html>`)
    } catch (e) {
      res.writeHead(500)
      res.end('Error generando QR')
    }
    return
  }
  res.writeHead(302, { Location: '/qr' })
  res.end()
})

server.listen(PORT, () => {
  logger.info(`🌐 Servidor QR activo — abrí /qr para escanear`)
})

// ─── NOTIFICACIÓN AL ASESOR ────────────────────────────────────────────────
async function notifyAsesor(sock, userId, responseText) {
  if (!ASESOR_JID) return
  try {
    const msg =
      `🔔 *Nuevo lead calificado — Villa Bienes Raíces*\n\n` +
      `📱 WhatsApp: wa.me/${userId.replace('@s.whatsapp.net', '')}\n\n` +
      `💬 *Último mensaje del agente:*\n${responseText}\n\n` +
      `✅ Contactar para confirmar visita.`
    await sock.sendMessage(ASESOR_JID, { text: msg })
    logger.info(`✅ Asesor notificado: ${userId}`)
  } catch (err) {
    logger.error({ err }, '❌ Error notificando al asesor')
  }
}

// ─── HANDLER PRINCIPAL DE MENSAJES ────────────────────────────────────────
async function handleMessage(sock, msg) {
  const jid = msg.key.remoteJid
  if (msg.key.fromMe) return
  if (jid.endsWith('@g.us')) return
  if (jid === 'status@broadcast') return

  const text =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    null

  if (!text) return

  logger.info(`📩 [${jid}] "${text}"`)
  await sock.readMessages([msg.key])
  await sock.sendPresenceUpdate('composing', jid)

  try {
    addToHistory(jid, 'user', text)
    const { text: reply, triggers } = await askClaude(getHistory(jid))
    addToHistory(jid, 'assistant', reply)

    const state = getLeadState(jid)
    updateLeadState(jid, { lastMessageAt: Date.now() })

    if (triggers.qualified && !state.qualified) {
      updateLeadState(jid, { qualified: true })
      logger.info(`🎯 Lead calificado: ${jid}`)
    }

    if (triggers.followup && !state.followupScheduled) {
      updateLeadState(jid, { followupScheduled: true })
      logger.info(`⏰ Seguimiento programado: ${jid}`)
    }

    await sock.sendPresenceUpdate('paused', jid)
    await sock.sendMessage(jid, { text: reply })

    if (triggers.handoff && !state.handoffDone) {
      updateLeadState(jid, { handoffDone: true })
      logger.info(`🔔 Handoff — notificando asesor`)
      await notifyAsesor(sock, jid, reply)
    }

  } catch (err) {
    logger.error({ err }, '❌ Error procesando mensaje')
    await sock.sendPresenceUpdate('paused', jid)
    await sock.sendMessage(jid, { text: 'Disculpa, tuve un problema técnico. Intenta de nuevo en un momento 🙏' })
  }
}

// ─── SCHEDULER DE SEGUIMIENTOS ─────────────────────────────────────────────
function startFollowupScheduler(sock) {
  cron.schedule('0 * * * *', async () => {
    const pending = getLeadsPendingFollowup()
    if (pending.length === 0) return
    logger.info(`⏰ Procesando ${pending.length} seguimiento(s)`)
    for (const { userId, type } of pending) {
      try {
        const msg = FOLLOWUP_MSGS[type]
        await sock.sendMessage(userId, { text: msg })
        addToHistory(userId, 'assistant', msg)
        if (type === '24h') updateLeadState(userId, { followup24Sent: true })
        if (type === '48h') updateLeadState(userId, { followup48Sent: true })
        logger.info(`📤 Seguimiento ${type} → ${userId}`)
      } catch (err) {
        logger.error({ err }, `❌ Error seguimiento ${userId}`)
      }
    }
  })
  logger.info('⏰ Scheduler activo (revisión cada hora)')
}

// ─── CONEXIÓN WHATSAPP ─────────────────────────────────────────────────────
async function connectWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH)
  const { version } = await fetchLatestBaileysVersion()

  logger.info(`🚀 Iniciando agente: ${CLIENTE_NOMBRE}`)

  const sock = makeWASocket({
    version,
    logger: baileysLogger,
    auth: state,
    printQRInTerminal: true,
    browser: ['Agente IA', 'Chrome', '1.0.0'],
    generateHighQualityLinkPreview: false
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      currentQR = qr
      isConnected = false
      logger.info(`📱 QR disponible — abrí /qr para escanear`)
      qrcode.generate(qr, { small: true })
    }

    if (connection === 'open') {
      currentQR = null
      isConnected = true
      logger.info('✅ WhatsApp conectado exitosamente')
      logger.info(`🤖 Agente activo para ${CLIENTE_NOMBRE}`)
      startFollowupScheduler(sock)
    }

    if (connection === 'close') {
      isConnected = false
      const statusCode = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output?.statusCode : 0
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut
      if (shouldReconnect) {
        logger.warn(`⚠️  Reconectando en 5s... (código ${statusCode})`)
        setTimeout(connectWhatsApp, 5000)
      } else {
        logger.error('🚫 Sesión cerrada. Eliminá sessions/ y volvé a escanear el QR.')
      }
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return
    for (const msg of messages) await handleMessage(sock, msg)
  })

  return sock
}

// ─── ARRANQUE ──────────────────────────────────────────────────────────────
connectWhatsApp().catch((err) => {
  logger.fatal({ err }, '💥 Error fatal al iniciar')
  process.exit(1)
})
