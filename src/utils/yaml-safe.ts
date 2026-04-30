/**
 * Safe YAML parsing helpers. Forces js-yaml to JSON_SCHEMA (no custom tags),
 * then walks the parsed value to drop prototype-pollution keys as a belt-and-
 * braces defense on top of js-yaml v4's existing protections.
 */

import { load as yamlLoad, JSON_SCHEMA } from 'js-yaml';

function stripPollutionKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    for (const item of value) stripPollutionKeys(item);
    return value;
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      delete obj[key];
      continue;
    }
    stripPollutionKeys(obj[key]);
  }
  return value;
}

export function safeYamlLoad(content: string): unknown {
  const parsed = yamlLoad(content, { schema: JSON_SCHEMA });
  return stripPollutionKeys(parsed);
}
