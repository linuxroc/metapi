import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('desktop package scripts', () => {
  it('rebuilds the app before package:desktop targets invoke electron-builder', () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };

    const scripts = packageJson.scripts || {};
    const packageDesktop = scripts['package:desktop'] || '';
    const packageDesktopIntel = scripts['package:desktop:mac:intel'] || '';
    const distDesktop = scripts['dist:desktop'] || '';
    const distDesktopIntel = scripts['dist:desktop:mac:intel'] || '';

    expect(
      packageDesktop === 'npm run dist:desktop' || packageDesktop.includes('npm run build'),
    ).toBe(true);
    expect(
      packageDesktopIntel === 'npm run dist:desktop:mac:intel' || packageDesktopIntel.includes('npm run build'),
    ).toBe(true);
    expect(distDesktop).toContain('npm run build');
    expect(distDesktopIntel).toContain('npm run build');
  });

  it('pins an Electron version supported by the rebuild toolchain', () => {
    const require = createRequire(import.meta.url);
    const packageJson = JSON.parse(
      readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'),
    ) as { devDependencies?: Record<string, string> };
    const electronRange = packageJson.devDependencies?.electron || '';

    expect(electronRange).toMatch(/^\d+\.\d+\.\d+$/);

    const electronPackage = require('electron/package.json') as { version: string };
    const rebuildEntryPath = require.resolve('@electron/rebuild');
    const rebuildRequire = createRequire(rebuildEntryPath);
    const { getAbi } = rebuildRequire('node-abi') as {
      getAbi: (target: string, runtime: string) => string;
    };

    expect(electronPackage.version).toBe(electronRange);
    expect(() => getAbi(electronPackage.version, 'electron')).not.toThrow();
  });
});
