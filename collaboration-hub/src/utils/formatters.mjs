// Text formatting helpers shared by the hub modules.

/** Hide Trello key/token values that can appear in request URLs inside error messages. */
export function redactSecrets(text) {
  return String(text).replace(/([?&](?:key|token)=)[^&\s]+/gi, '$1[redacted]');
}
