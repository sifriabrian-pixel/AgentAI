// src/memory.js
// Gestiona el historial de conversación por usuario y el estado del lead

const sessions = new Map()   // historial de mensajes por número
const leadState = new Map()  // estado del lead por número

/**
 * Devuelve el historial de un usuario (lo crea si no existe)
 */
export function getHistory(userId) {
  if (!sessions.has(userId)) {
    sessions.set(userId, [])
  }
  return sessions.get(userId)
}

/**
 * Agrega un mensaje al historial del usuario
 */
export function addToHistory(userId, role, content) {
  const history = getHistory(userId)
  history.push({ role, content })

  // Limitar a últimos 20 mensajes para no exceder tokens
  if (history.length > 20) {
    sessions.set(userId, history.slice(-20))
  }
}

/**
 * Devuelve el estado del lead (calificado, handoff, followup)
 */
export function getLeadState(userId) {
  if (!leadState.has(userId)) {
    leadState.set(userId, {
      qualified: false,
      handoffDone: false,
      followupScheduled: false,
      followup24Sent: false,
      followup48Sent: false,
      lastMessageAt: null,
      name: null
    })
  }
  return leadState.get(userId)
}

/**
 * Actualiza campos del estado del lead
 */
export function updateLeadState(userId, updates) {
  const current = getLeadState(userId)
  leadState.set(userId, { ...current, ...updates })
}

/**
 * Devuelve todos los leads con seguimiento pendiente
 */
export function getLeadsPendingFollowup() {
  const now = Date.now()
  const pending = []

  for (const [userId, state] of leadState.entries()) {
    if (!state.followupScheduled || !state.lastMessageAt) continue

    const elapsed = now - state.lastMessageAt
    const hours24 = 24 * 60 * 60 * 1000
    const hours48 = 48 * 60 * 60 * 1000

    if (!state.followup24Sent && elapsed >= hours24) {
      pending.push({ userId, type: '24h' })
    } else if (state.followup24Sent && !state.followup48Sent && elapsed >= hours48) {
      pending.push({ userId, type: '48h' })
    }
  }

  return pending
}

/**
 * Lista todos los leads (para logging)
 */
export function getAllLeads() {
  return Array.from(leadState.entries()).map(([id, state]) => ({ id, ...state }))
}
