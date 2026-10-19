import type { ComposerAttachment } from "../../shared/attachments";

// The timeline keeps only the text of a user message, so the attachments sent
// from this page are remembered for the session to show them with the message.

interface Sent {
  messageId: string;
  text: string;
  attachments: ComposerAttachment[];
}

const sent: Sent[] = [];
const KEEP = 100;

/** `text` is what the chat receives: the typed text, or the line sent for attachments alone. */
export function rememberSent(messageId: string, text: string, attachments: ComposerAttachment[]): void {
  if (attachments.length === 0) return;
  sent.push({ messageId, text: text.trim() || "See the attached files.", attachments });
  if (sent.length > KEEP) sent.splice(0, sent.length - KEEP);
}

/** The attachments sent with a user message: matched by its id, else by its text for providers that assign their own ids. */
export function sentAttachments(message: { text: string; messageId?: string; clientMessageId?: string }): ComposerAttachment[] {
  const ids = [message.messageId, message.clientMessageId].filter(Boolean);
  const match = sent.find((entry) => ids.includes(entry.messageId)) ?? sent.find((entry) => entry.text === message.text.trim());
  return match?.attachments ?? [];
}
