/**
 * PII Redaction Utility
 * Replaces sensitive patterns with generic redacted markers.
 */

const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

// Matches US and simple international phone number formats (7-15 digits, optional separators)
const PHONE_PATTERN = /(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g;

// Matches common credit card numbers (13 to 16 digits)
const CARD_PATTERN = /\b(?:\d[ -]*?){13,16}\b/g;

// Matches US SSN format
const SSN_PATTERN = /\b\d{3}-\d{2}-\d{4}\b/g;

// Matches generic high-entropy API keys (e.g. OpenAI sk-...) or standard authentication tokens
const API_KEY_PATTERN = /(?:sk-[a-zA-Z0-9]{32,}|AIzaSy[a-zA-Z0-9-_]{33}|[a-f0-9]{32,})/gi;

export function redactPII(text: string | null | undefined): string {
  if (!text) return '';

  let redacted = text;

  // Redact Emails
  redacted = redacted.replace(EMAIL_PATTERN, '[REDACTED_EMAIL]');

  // Redact API Keys / Sensitive Keys
  redacted = redacted.replace(API_KEY_PATTERN, '[REDACTED_KEY]');

  // Redact Credit Cards
  redacted = redacted.replace(CARD_PATTERN, '[REDACTED_CARD]');

  // Redact SSN
  redacted = redacted.replace(SSN_PATTERN, '[REDACTED_SSN]');

  // Redact Phone Numbers
  redacted = redacted.replace(PHONE_PATTERN, '[REDACTED_PHONE]');

  return redacted;
}
