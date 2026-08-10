/**
 * Testes de hidratacao (ensureSerializedMessageId) — payloads reais redigidos.
 * Valida o formato canonico fromMe_remote_id[_participant] preservando
 * _serialized valido existente e nunca derivando remote de message.from/to.
 */
import { ensureSerializedMessageId } from '@waha/core/utils/message-hydration';

// Re-export para permitir teste isolado: exponha a funcao de forma testavel.
// (A funcao e module-level no arquivo fonte; aqui testamos via import do arquivo
//  compilado/source transpilado pelo jest.)

function helper(message: any) {
  return ensureSerializedMessageId(message);
}

describe('ensureSerializedMessageId (hidratacao homologada)', () => {
  it('não serializa se message é null/undefined', () => {
    expect(helper(undefined)).toBeUndefined();
    expect(helper(null)).toBeNull();
  });

  it('inbound sem _serialized: gera canonico true_remote_id', () => {
    const msg = {
      id: {
        fromMe: false,
        remote: { _serialized: '5511999999999@s.whatsapp.net' },
        id: 'ABCDEF123456',
        participant: undefined,
      },
      _data: { id: { fromMe: false, remote: { _serialized: '5511999999999@s.whatsapp.net' }, id: 'ABCDEF123456' } },
    };
    const out = helper(msg);
    expect(out.id._serialized).toBe('false_5511999999999@s.whatsapp.net_ABCDEF123456');
  });

  it('fromMe: gera canonico true_remote_id', () => {
    const msg = {
      id: { fromMe: true, remote: '5511888888888@s.whatsapp.net', id: 'XYZ789' },
    };
    const out = helper(msg);
    expect(out.id._serialized).toBe('true_5511888888888@s.whatsapp.net_XYZ789');
  });

  it('grupo com participant: gera canonico true_remote_id_participant', () => {
    const msg = {
      id: {
        fromMe: true,
        remote: '5511777777777-5555555555@g.us',
        id: 'GRP1',
        participant: '5511666666666@c.us',
      },
      _data: { id: { fromMe: true, remote: '5511777777777-5555555555@g.us', id: 'GRP1', participant: '5511666666666@c.us' } },
    };
    const out = helper(msg);
    expect(out.id._serialized).toBe('true_5511777777777-5555555555@g.us_GRP1_5511666666666@c.us');
  });

  it('mídia (message com media): hidrata id e mantém media fields', () => {
    const msg = {
      id: { fromMe: false, remote: { id: '5511555555555@c.us' }, id: 'MEDIA1' },
      hasMedia: true,
      media: { url: 'https://media.example/1' },
    };
    const out = helper(msg);
    expect(out.id._serialized).toBe('false_5511555555555@c.us_MEDIA1');
    expect(out.hasMedia).toBe(true);
    expect(out.media.url).toBe('https://media.example/1');
  });

  it('ID já serializado: preserva _serialized válido existente', () => {
    const msg = {
      id: { fromMe: false, remote: '5511444444444@s.whatsapp.net', id: 'X1', _serialized: 'false_5511444444444@s.whatsapp.net_X1' },
    };
    const out = helper(msg);
    expect(out.id._serialized).toBe('false_5511444444444@s.whatsapp.net_X1');
  });

  it('não deriva remote de message.from/to (usa id.remote)', () => {
    const msg = {
      id: { fromMe: true, remote: { _serialized: '5511333333333@s.whatsapp.net' }, id: 'R1' },
      from: '5511222222222@c.us', // IRRELEVANTE — não deve ser usado
      to: '5511999999999@c.us',   // IRRELEVANTE — não deve ser usado
    };
    const out = helper(msg);
    expect(out.id._serialized).toBe('true_5511333333333@s.whatsapp.net_R1');
    expect(out.id._serialized).not.toContain('5511222222222');
    expect(out.id._serialized).not.toContain('5511999999999');
  });
});
