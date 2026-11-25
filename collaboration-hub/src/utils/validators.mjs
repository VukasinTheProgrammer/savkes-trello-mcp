// Input validation for the Collaboration Hub: every limit and allowed value in one place.
// server.mjs imports these instead of repeating numbers and lists inline.

/** Maximum length of each text value. Sent to the dashboard so its inputs use the same limits. */
export const LIMITS = Object.freeze({
  name: 40,        // developer name typed in the dashboard
  developerId: 80, // developer ID sent by the MCP server
  cardId: 80,      // Trello card ID or short link
  field: 40,       // card field name, e.g. "description"
  note: 200,       // collaboration request message
  work: 160,       // each half of a work split
  detail: 160,     // free-text activity line
  tool: 60,        // MCP tool name in activity events
});

/** Roles a participant can join with (display labels; they do not grant permissions). */
export const ROLES = Object.freeze(['admin', 'project_manager', 'developer', 'reviewer', 'viewer']);

/** Statuses a card can be moved to in the hub. */
export const CARD_STATUSES = Object.freeze(['todo', 'doing', 'review', 'done']);

/** Trimmed string cut to `max` characters; anything that is not a string becomes ''.
 *  Used for machine-sent values (MCP events), where cutting is safe. */
export function cleanText(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/** Trimmed string checked against LIMITS[limit]. Too long → { error } with a readable message
 *  instead of silently cutting what a person typed. Otherwise → { value }. */
export function checkLength(value, limit, label) {
  const max = LIMITS[limit];
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length > max) return { error: `${label} must be ${max} characters or fewer (got ${text.length})` };
  return { value: text };
}

/** Field names are stored as "cardId:field", so they cannot contain ":". Returns an error or null. */
export function fieldNameError(field) {
  return field.includes(':') ? 'Field names cannot contain ":"' : null;
}

/** Cleaned, non-empty field names from a request body list. */
export function cleanFieldList(fields) {
  return Array.isArray(fields) ? fields.map((f) => cleanText(f, LIMITS.field)).filter(Boolean) : [];
}

export const isValidRole = (role) => typeof role === 'string' && ROLES.includes(role);
export const isValidStatus = (status) => CARD_STATUSES.includes(status);
