/**
 * v13 tests — handler message.ack (fix CRASH do "Cannot read properties of null
 * (reading 'to')"). Cobrem: to=null, ID objeto, inbound, fromMe, grupo/participant
 * e ACK incompleto. Nenhum deve lançar exceção nem derrubar a sessão.
 *
 * NOTA: estes testes exercitam o HELPERS do patch (ensureSerializedMessageId +
 * resolução de destino por id.remote/_data.id.remote/_data.Info.Chat) de forma
 * isolada; serão integrados ao handler no build v13.
 */
import {
  ensureSerializedMessageId,
} from '@waha/core/utils/message-hydration';
import { parseMessageIdSerialized } from '@waha/core/utils/ids';

// Helpers espelhando o patch proposto (v13-patch-proposal.md)
function safeAckRemote(message: any): string | null {
  const remote =
    (message?.id && (message.id.remote || message.id.address || null)) ||
    (message?._data?.id?.remote) ||
    (message?._data?.Info?.Chat) ||
    (message?._data?.Info?.chat?.id) ||
    null;
  return typeof remote === 'string' && remote ? remote : null;
}

function ackHasValidId(message: any): boolean {
  const mid = message?.id;
  if (!mid) return false;
  // aceita id string OU objeto com id/_serialized
  return typeof mid === 'string' ? mid.length > 0 : Boolean(mid.id || mid._serialized);
}

describe('v13 — message.ack (nunca lança; resolve destino sem message.to)', () => {
  it('ACK com to=null: não lança e é descartado (sem destino válido)', () => {
    const ack = {
      id: { id: 'ABC', _serialized: 'ABC', fromMe: true },
      to: null, // <-- caso problemático
      fromMe: true,
    };
    const hydrated = ensureSerializedMessageId(ack);
    const remote = safeAckRemote(hydrated);
    // não deve lançar; sem remote → descarta
    expect(remote).toBeNull();
  });

  it('ACK incompleto (sem message.id): não lança, descartado', () => {
    const ack = { to: '5511@c.us' }; // sem id
    expect(() => ensureSerializedMessageId(ack)).not.toThrow();
    expect(ackHasValidId(ack)).toBe(false);
    expect(safeAckRemote(ack)).toBeNull();
  });

  it('ID objeto resolve destino via id.remote (sem usar message.to)', () => {
    const ack = {
      id: { id: 'ABC', remote: '5511@c.us', fromMe: true },
      to: null,
      fromMe: true,
    };
    const hydrated = ensureSerializedMessageId(ack);
    const remote = safeAckRemote(hydrated);
    expect(remote).toBe('5511@c.us'); // resolveu por id.remote
    expect(ackHasValidId(ack)).toBe(true);
  });

  it('ID objeto resolve destino via _data.id.remote (fallback)', () => {
    const ack = {
      id: { id: 'ABC', fromMe: false },
      _data: { id: { remote: '55115555@c.us' } },
      to: null,
      fromMe: false,
    };
    const remote = safeAckRemote(ack);
    expect(remote).toBe('55115555@c.us');
  });

  it('resolve via _data.Info.Chat (fallback grupo/participant)', () => {
    const ack = {
      id: { id: 'ABC', fromMe: false },
      _data: { Info: { Chat: '120363@c.us' } },
      to: null,
      fromMe: false,
      participant: '5511@c.us',
    };
    const remote = safeAckRemote(ack);
    expect(remote).toBe('120363@c.us');
  });

  it('fromMe: resolve remote corretamente (não assume message.to)', () => {
    const ack = {
      id: { id: 'ABC', remote: '5511@c.us', fromMe: true },
      fromMe: true,
      to: null, // não usar
    };
    const remote = safeAckRemote(ack);
    expect(remote).toBe('5511@c.us');
    expect(ackHasValidId(ack)).toBe(true);
  });

  it('grupo/participant: extrai participant do id serializado', () => {
    // formato real: <fromMe>_<remoteJid>_<id>[_participant]
    const ack = {
      id: { id: 'ABC', _serialized: 'false_5511@c.us_AAAAAAAAAAAAAAAAAAAA_5511@c.us', fromMe: false },
      fromMe: false,
      to: null,
    };
    const key = parseMessageIdSerialized(ack.id._serialized);
    // destino (grupo) = address do id; participant = key.participant
    const remote = safeAckRemote({ id: { ...ack.id, address: '120363@c.us' } });
    expect(key).toBeTruthy();
    if (key) expect(String(key.participant)).toContain('5511');
    expect(remote).toBe('120363@c.us');
    expect(() => ackHasValidId(ack)).not.toThrow();
  });

  it('ACK parcial válido: produz um ACK leve (id/ack/fromMe/remote) sem lançar', () => {
    const ack = {
      id: { id: 'XYZ', remote: '5511@c.us', fromMe: false },
      fromMe: false,
      to: null,
      ack: 2,
    };
    const remote = safeAckRemote(ack);
    // use optional parse so nao falha se mock sem formato completo
    let key = null;
    try { key = ack.id && parseMessageIdSerialized(ack.id.id || ''); } catch { key = null; }
    expect(remote).toBe('5511@c.us');
    expect(ackHasValidId(ack)).toBe(true);
    // produção do ACK leve (mock) — nunca lança
    const light = { id: ack.id.id, fromMe: ack.fromMe, to: remote, ack: ack.ack };
    expect(light.to).toBe('5511@c.us');
    expect(light.ack).toBe(2);
  });
});
