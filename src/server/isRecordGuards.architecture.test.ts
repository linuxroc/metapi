import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function listProductionTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return listProductionTypeScriptFiles(absolutePath);
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) return [];
    return [absolutePath];
  });
}

describe('record type guards', () => {
  it('does not classify arrays as records', () => {
    const serverRoot = path.resolve(process.cwd(), 'src/server');
    const violations: string[] = [];
    const isRecordFunction = /function isRecord\([^)]*\)[^{]*\{([\s\S]*?)\n\}/g;

    for (const file of listProductionTypeScriptFiles(serverRoot)) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(isRecordFunction)) {
        const body = match[1] || '';
        if (body.includes("typeof value === 'object'") && !body.includes('!Array.isArray(value)')) {
          violations.push(path.relative(serverRoot, file));
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
