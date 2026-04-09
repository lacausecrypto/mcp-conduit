import { describe, it, expect } from 'vitest';
import { deepSort, deterministicStringify } from '../../src/utils/deep-sort.js';

describe('deepSort', () => {
  it('retourne les valeurs primitives telles quelles', () => {
    expect(deepSort('hello')).toBe('hello');
    expect(deepSort(42)).toBe(42);
    expect(deepSort(true)).toBe(true);
    expect(deepSort(null)).toBe(null);
    expect(deepSort(undefined)).toBe(undefined);
  });

  it('trie les clés d\'un objet simple par ordre alphabétique', () => {
    const result = deepSort({ z: 1, a: 2, m: 3 }) as Record<string, number>;
    expect(Object.keys(result)).toEqual(['a', 'm', 'z']);
  });

  it('trie les clés récursivement', () => {
    const input = { z: { c: 1, a: 2 }, a: { y: 'foo', b: 'bar' } };
    const result = deepSort(input) as Record<string, Record<string, unknown>>;
    expect(Object.keys(result)).toEqual(['a', 'z']);
    expect(Object.keys(result['a']!)).toEqual(['b', 'y']);
    expect(Object.keys(result['z']!)).toEqual(['a', 'c']);
  });

  it('conserve l\'ordre des éléments dans les tableaux', () => {
    expect(deepSort([3, 1, 2])).toEqual([3, 1, 2]);
  });

  it('trie récursivement les objets dans les tableaux', () => {
    const result = deepSort([{ z: 1, a: 2 }]) as Record<string, number>[];
    expect(Object.keys(result[0]!)).toEqual(['a', 'z']);
  });

  it('gère les objets vides', () => {
    expect(deepSort({})).toEqual({});
  });

  it('gère les tableaux vides', () => {
    expect(deepSort([])).toEqual([]);
  });

  it('produit le même résultat quel que soit l\'ordre initial des clés', () => {
    const r1 = JSON.stringify(deepSort({ z: 1, a: 2, m: 3 }));
    const r2 = JSON.stringify(deepSort({ a: 2, z: 1, m: 3 }));
    const r3 = JSON.stringify(deepSort({ m: 3, a: 2, z: 1 }));
    expect(r1).toBe(r2);
    expect(r2).toBe(r3);
  });
});

describe('deterministicStringify', () => {
  it('produit un JSON déterministe pour des objets dans un ordre différent', () => {
    const a = { z: 1, a: 2 };
    const b = { a: 2, z: 1 };
    expect(deterministicStringify(a)).toBe(deterministicStringify(b));
  });

  it('sérialise correctement en JSON valide', () => {
    const output = deterministicStringify({ foo: 'bar', num: 42 });
    expect(() => JSON.parse(output)).not.toThrow();
    expect(JSON.parse(output)).toEqual({ foo: 'bar', num: 42 });
  });

  it('produit toujours les clés dans le même ordre', () => {
    expect(deterministicStringify({ z: 1, a: 2, m: 3 })).toBe('{"a":2,"m":3,"z":1}');
  });
});
