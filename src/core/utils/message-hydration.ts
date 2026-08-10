/**
 * message-hydration.ts — ensureSerializedMessageId (hidratacao homologada).
 * Canonicaliza message.id._serialized no formato fromMe_remote_id[_participant],
 * preservando _serialized valido existente e nunca derivando remote de from/to.
 * Modulo isolado (sem deps baileys) para testabilidade unitaria.
 */
function __wSjid(v: any): string | null {
  if (typeof v === 'string') return v.trim() || null;
  if (v && typeof v === 'object') {
    if (typeof v._serialized === 'string' && v._serialized.trim()) return v._serialized.trim();
    if (typeof v.id === 'string' && v.id.trim()) return v.id.trim();
    if (v.remote && typeof v.remote === 'object' && v.remote._serialized) return v.remote._serialized.trim();
  }
  return null;
}

export function ensureSerializedMessageId(message: any): any {
  if (!message) return message;
  const rawId = message.id || (message._data && message._data.id) || null;
  if (!rawId) return message;
  // Preserva _serialized valido existente.
  const existing =
    rawId && typeof rawId === 'object' && typeof rawId._serialized === 'string' && rawId._serialized.trim()
      ? rawId._serialized.trim()
      : rawId && rawId._data && typeof rawId._data === 'object' && typeof rawId._data._serialized === 'string'
        ? rawId._data._serialized.trim()
        : null;
  if (existing) return message;
  // fromMe literal true/false (nunca deriva de message.from/to).
  const fromMe = rawId && rawId.fromMe === true ? 'true' : rawId && rawId.fromMe === false ? 'false' : null;
  // remote SEMPRE vem de id.remote/_data.id.remote.
  const remote = __wSjid(rawId && rawId.remote) || __wSjid(rawId && rawId._data && rawId._data.remote);
  const idPart = typeof rawId === 'string' ? rawId.trim() || null : __wSjid(rawId && rawId.id);
  const participant =
    rawId && rawId.participant !== undefined
      ? __wSjid(rawId.participant)
      : rawId && rawId._data && rawId._data.participant !== undefined
        ? __wSjid(rawId._data.participant)
        : null;
  if (!fromMe || !remote || !idPart) return message; // impossível montar canonico
  const serialized = participant
    ? fromMe + '_' + remote + '_' + idPart + '_' + participant
    : fromMe + '_' + remote + '_' + idPart;
  if (rawId && typeof rawId === 'object') {
    if (typeof rawId._serialized !== 'string') {
      try {
        Object.defineProperty(rawId, '_serialized', {
          value: serialized,
          writable: true,
          configurable: true,
          enumerable: false,
        });
      } catch (e) {
        try {
          const copy = Object.create(Object.getPrototypeOf(rawId));
          Object.assign(copy, rawId);
          copy._serialized = serialized;
          message.id = copy;
        } catch (e2) {
          /* non-fatal */
        }
      }
    }
  }
  return message;
}
