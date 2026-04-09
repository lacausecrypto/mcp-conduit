import { describe, it, expect } from 'vitest';
import { redact, createRedactor } from '../../src/observability/redactor.js';

const SENSITIVE_FIELDS = ['password', 'token', 'ssn', 'api_key', 'secret', 'authorization'];

describe('redact', () => {
  describe('valeurs primitives', () => {
    it('retourne null tel quel', () => {
      expect(redact(null, SENSITIVE_FIELDS)).toBeNull();
    });

    it('retourne undefined tel quel', () => {
      expect(redact(undefined, SENSITIVE_FIELDS)).toBeUndefined();
    });

    it('retourne les chaînes telles quelles', () => {
      expect(redact('hello', SENSITIVE_FIELDS)).toBe('hello');
    });

    it('retourne les nombres tels quels', () => {
      expect(redact(42, SENSITIVE_FIELDS)).toBe(42);
    });

    it('retourne les booléens tels quels', () => {
      expect(redact(true, SENSITIVE_FIELDS)).toBe(true);
    });
  });

  describe('champs sensibles au niveau racine', () => {
    it('masque le champ "password"', () => {
      const result = redact({ password: 'secret123', username: 'alice' }, SENSITIVE_FIELDS);
      expect((result as Record<string, unknown>)['password']).toBe('[REDACTED]');
      expect((result as Record<string, unknown>)['username']).toBe('alice');
    });

    it('masque le champ "token"', () => {
      const result = redact({ token: 'abc123', data: 'ok' }, SENSITIVE_FIELDS);
      expect((result as Record<string, unknown>)['token']).toBe('[REDACTED]');
    });

    it('masque le champ "ssn"', () => {
      const result = redact({ ssn: '123-45-6789' }, SENSITIVE_FIELDS);
      expect((result as Record<string, unknown>)['ssn']).toBe('[REDACTED]');
    });

    it('masque le champ "api_key"', () => {
      const result = redact({ api_key: 'key-xyz' }, SENSITIVE_FIELDS);
      expect((result as Record<string, unknown>)['api_key']).toBe('[REDACTED]');
    });

    it('masque le champ "authorization"', () => {
      const result = redact({ authorization: 'Bearer xyz' }, SENSITIVE_FIELDS);
      expect((result as Record<string, unknown>)['authorization']).toBe('[REDACTED]');
    });
  });

  describe('correspondance partielle (insensible à la casse)', () => {
    it('masque "user_password" car contient "password"', () => {
      const result = redact({ user_password: 'secret' }, SENSITIVE_FIELDS);
      expect((result as Record<string, unknown>)['user_password']).toBe('[REDACTED]');
    });

    it('masque "access_token" car contient "token"', () => {
      const result = redact({ access_token: 'abc' }, SENSITIVE_FIELDS);
      expect((result as Record<string, unknown>)['access_token']).toBe('[REDACTED]');
    });

    it('masque "apiKey" (camelCase) car les segments matchent "api_key"', () => {
      // "apiKey" se décompose en segments ["api", "key"] qui matchent "api_key" → ["api", "key"]
      const result = redact({ apiKey: 'abc' }, ['api_key']);
      expect((result as Record<string, unknown>)['apiKey']).toBe('[REDACTED]');
    });

    it('ne masque PAS les champs dont le segment sensible est un sous-mot', () => {
      // "tokenizer" → ["tokenizer"], ne matche PAS "token" → ["token"]
      const result = redact({ tokenizer: 'bert', detokenize: true }, ['token']);
      expect((result as Record<string, unknown>)['tokenizer']).toBe('bert');
      expect((result as Record<string, unknown>)['detokenize']).toBe(true);
    });

    it('est insensible à la casse pour le nom du champ', () => {
      const result = redact({ PASSWORD: 'secret' }, SENSITIVE_FIELDS);
      expect((result as Record<string, unknown>)['PASSWORD']).toBe('[REDACTED]');
    });
  });

  describe('objets imbriqués', () => {
    it('masque les champs sensibles dans des objets imbriqués', () => {
      const input = {
        user: {
          name: 'Alice',
          credentials: {
            password: 'secret',
            token: 'abc',
          },
        },
      };

      const result = redact(input, SENSITIVE_FIELDS) as {
        user: { name: string; credentials: { password: string; token: string } };
      };

      expect(result.user.name).toBe('Alice');
      expect(result.user.credentials.password).toBe('[REDACTED]');
      expect(result.user.credentials.token).toBe('[REDACTED]');
    });

    it('masque les champs sensibles profondément imbriqués', () => {
      const input = { a: { b: { c: { password: 'deep' } } } };
      const result = redact(input, SENSITIVE_FIELDS) as { a: { b: { c: { password: string } } } };
      expect(result.a.b.c.password).toBe('[REDACTED]');
    });
  });

  describe('tableaux', () => {
    it('masque les champs sensibles dans les tableaux d\'objets', () => {
      const input = [
        { id: 1, password: 'pass1' },
        { id: 2, password: 'pass2' },
      ];

      const result = redact(input, SENSITIVE_FIELDS) as Array<{ id: number; password: string }>;

      expect(result[0]?.password).toBe('[REDACTED]');
      expect(result[1]?.password).toBe('[REDACTED]');
      expect(result[0]?.id).toBe(1);
    });

    it('traite les tableaux imbriqués dans des objets', () => {
      const input = {
        users: [
          { name: 'Alice', token: 'tok1' },
          { name: 'Bob', token: 'tok2' },
        ],
      };

      const result = redact(input, SENSITIVE_FIELDS) as {
        users: Array<{ name: string; token: string }>;
      };

      expect(result.users[0]?.token).toBe('[REDACTED]');
      expect(result.users[1]?.token).toBe('[REDACTED]');
      expect(result.users[0]?.name).toBe('Alice');
    });
  });

  describe('immutabilité', () => {
    it('ne modifie pas l\'objet original', () => {
      const original = { password: 'secret', name: 'Alice' };
      const copy = { ...original };

      redact(original, SENSITIVE_FIELDS);

      expect(original.password).toBe('secret');
      expect(original).toEqual(copy);
    });

    it('ne modifie pas les tableaux originaux', () => {
      const original = [{ password: 'secret' }];
      redact(original, SENSITIVE_FIELDS);
      expect(original[0]?.password).toBe('secret');
    });
  });

  describe('champs non sensibles', () => {
    it('ne masque pas les champs non sensibles', () => {
      const input = { name: 'Alice', email: 'alice@example.com', id: 123 };
      const result = redact(input, SENSITIVE_FIELDS) as typeof input;
      expect(result.name).toBe('Alice');
      expect(result.email).toBe('alice@example.com');
      expect(result.id).toBe(123);
    });
  });

  describe('liste de champs vide', () => {
    it('ne masque rien si la liste de champs sensibles est vide', () => {
      const input = { password: 'secret', token: 'abc' };
      const result = redact(input, []) as typeof input;
      expect(result.password).toBe('secret');
      expect(result.token).toBe('abc');
    });
  });
});

describe('createRedactor', () => {
  it('crée une fonction de masquage réutilisable', () => {
    const redactor = createRedactor(SENSITIVE_FIELDS);
    const result = redactor({ password: 'secret', name: 'Alice' }) as Record<string, unknown>;
    expect(result['password']).toBe('[REDACTED]');
    expect(result['name']).toBe('Alice');
  });

  it('applique le masquage plusieurs fois avec la même config', () => {
    const redactor = createRedactor(['token']);
    const r1 = redactor({ token: 'abc' }) as Record<string, unknown>;
    const r2 = redactor({ token: 'xyz' }) as Record<string, unknown>;
    expect(r1['token']).toBe('[REDACTED]');
    expect(r2['token']).toBe('[REDACTED]');
  });
});
