/**
 * Message serialization for quality evaluation and decompression.
 *
 * @module @dsh-asc/compaction-agentic/text
 */

import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'

/** Render one content block to plain text; non-text blocks get a marker. */
export function blockText(block: ContentBlock): string {
  switch (block.type) {
    case 'text':
      return block.text
    case 'image':
      return '[image]'
    case 'tool-call':
      return `[tool-call: ${block.name}(${block.id})]\n${block.arguments}`
    case 'tool-result':
      return `[tool-result: ${block.toolCallId}]\n${block.content.map(blockText).join('\n')}`
    case 'reasoning':
      return `[reasoning]\n${block.text}`
    default:
      return '[content]'
  }
}

/**
 * Serialize one model-visible message to plain text with role headers.
 * @param message - derived message.
 * @returns the plain-text rendering.
 */
export function serializeMessage(message: Message): string {
  const header = message.role === 'user'
    ? '[user]'
    : message.role === 'assistant' ? '[assistant]' : `[${message.role}]`
  const body = message.content.map(blockText).join('\n')
  return `${header}\n${body}`
}

/**
 * Serialize an ordered list of messages to one plain-text transcript.
 * @param messages - derived messages in surface order.
 * @returns the concatenated rendering.
 */
export function serializeMessages(messages: readonly Message[]): string {
  return messages.map(serializeMessage).join('\n\n')
}

/** First `limit` characters of a text, preserving a preview boundary. */
export function textPreview(text: string, limit: number): string {
  const points = Array.from(text)
  if (points.length <= limit) return text
  return points.slice(0, limit).join('') + '…'
}
