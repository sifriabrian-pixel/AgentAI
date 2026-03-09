// src/claude.js
// Llama a la API de Anthropic y detecta triggers en la respuesta

import Anthropic from '@anthropic-ai/sdk'
import { PROMPTS } from './prompts.js'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

/**
 * Envía el historial a Claude y devuelve la respuesta + triggers detectados
 */
export async function askClaude(history, mode = 'meta') {
  const systemPrompt = PROMPTS[mode] || PROMPTS.meta

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1000,
    system: systemPrompt,
    messages: history
  })

  const rawText = response.content[0].text

  // Detectar triggers embebidos en la respuesta
  const triggers = {
    handoff:   rawText.includes('[HANDOFF_TRIGGER]'),
    qualified: rawText.includes('[LEAD_QUALIFIED]'),
    followup:  rawText.includes('[FOLLOWUP_TRIGGER]')
  }

  // Limpiar el texto antes de enviarlo al usuario
  const cleanText = rawText
    .replace(/\[HANDOFF_TRIGGER\]/g, '')
    .replace(/\[LEAD_QUALIFIED\]/g, '')
    .replace(/\[FOLLOWUP_TRIGGER\]/g, '')
    .trim()

  return { text: cleanText, triggers }
}
