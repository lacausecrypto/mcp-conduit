import { describe, it, expect } from 'vitest';
import { matchesPattern, matchesAnyPattern } from '../../src/utils/pattern.js';

describe('matchesPattern', () => {
  it('matches exact string', () => {
    expect(matchesPattern('hello', 'hello')).toBe(true);
    expect(matchesPattern('hello', 'world')).toBe(false);
  });

  it('star wildcard matches everything', () => {
    expect(matchesPattern('*', '')).toBe(true);
    expect(matchesPattern('*', 'anything')).toBe(true);
    expect(matchesPattern('*', 'even.dots')).toBe(true);
  });

  it('prefix wildcard matches start of string', () => {
    expect(matchesPattern('delete_*', 'delete_user')).toBe(true);
    expect(matchesPattern('delete_*', 'delete_')).toBe(true);
    expect(matchesPattern('delete_*', 'get_user')).toBe(false);
  });

  it('prefix wildcard with empty prefix', () => {
    // "*" is handled by the first check, not the prefix check
    expect(matchesPattern('*', 'anything')).toBe(true);
  });

  it('does not support mid-string wildcards', () => {
    // Only supports trailing * — mid-string * is treated as literal
    expect(matchesPattern('get_*_contact', 'get_all_contact')).toBe(false);
  });

  it('exact match is case-sensitive', () => {
    expect(matchesPattern('Hello', 'hello')).toBe(false);
    expect(matchesPattern('Hello', 'Hello')).toBe(true);
  });

  it('empty pattern only matches empty string', () => {
    expect(matchesPattern('', '')).toBe(true);
    expect(matchesPattern('', 'something')).toBe(false);
  });
});

describe('matchesAnyPattern', () => {
  it('returns true if any pattern matches', () => {
    expect(matchesAnyPattern(['delete_*', 'remove_*'], 'delete_user')).toBe(true);
    expect(matchesAnyPattern(['delete_*', 'remove_*'], 'remove_item')).toBe(true);
  });

  it('returns false if no pattern matches', () => {
    expect(matchesAnyPattern(['delete_*', 'remove_*'], 'get_user')).toBe(false);
  });

  it('returns false for empty patterns array', () => {
    expect(matchesAnyPattern([], 'anything')).toBe(false);
  });

  it('works with star wildcard in list', () => {
    expect(matchesAnyPattern(['specific', '*'], 'anything')).toBe(true);
  });
});
