// src/claude.js
// Integración con la API de Claude

import Anthropic from '@anthropic-ai/sdk'
import fs from 'fs'
import path from 'path'
import { buildSystemPrompt, FOLLOWUP_24H, FOLLOWUP_48H } from '../prompts/villa.js'

export const FOLLOWUP_MSGS = {
  '24h': FOLLOWUP_24H,
  '48h': FOLLOWUP_48H
}

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

function loadProperties() {
  try {
    const filePath = path.resolve('./properties.json')
    const raw = fs.readFileSync(filePath, 'utf8')
    const data = JSON.parse(raw)
    return data.properties || []
  } catch {
    console.warn('⚠️  No se encontró properties.json — el agente funcionará sin base de propiedades externa')
    return []
  }
}

function parseTriggers(text) {
  return {
    handoff:   text.includes('[HANDOFF_TRIGGER]'),
    qualified: text.includes('[LEAD_QUALIFIED]'),
    followup:  text.includes('[FOLLOWUP_TRIGGER]'),
  }
}

function cleanText(text) {
  return text
    .replace(/\[HANDOFF_TRIGGER\]/g, '')
    .replace(/\[LEAD_QUALIFIED\]/g, '')
    .replace(/\[FOLLOWUP_TRIGGER\]/g, '')
    .trim()
}

function getEnvVars() {
  return {
    CLIENTE_NOMBRE: process.env.CLIENTE_NOMBRE || 'Villa Bienes Raíces',
  }
}

let cachedProperties = null

export async function askClaude(history) {
  if (!cachedProperties) cachedProperties = loadProperties()

  const systemPrompt = buildSystemPrompt(cachedProperties, getEnvVars())

  const response = await client.messages.create({
    model:      'claude-sonnet-4-20250514',
    max_tokens: 1024,
    system:     systemPrompt,
    messages:   history,
  })

  const rawText = response.content[0]?.text || 'Disculpa, tuve un problema técnico. Intenta de nuevo 🙏'
  const triggers = parseTriggers(rawText)
  const text     = cleanText(rawText)

  return { text, triggers }
}

export function reloadProperties() {
  cachedProperties = loadProperties()
  console.log(`🔄 Propiedades recargadas: ${cachedProperties.length}`)
}
