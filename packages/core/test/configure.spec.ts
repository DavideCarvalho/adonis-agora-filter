import { describe, expect, it } from 'vitest';
import { configure } from '../configure.js';

/**
 * A minimal stand-in for the pieces of ace's `Configure` command the hook drives.
 * Recording the calls is enough: the hook's whole job is to hand the right two
 * specifiers to `updateRcFile`, and getting either one wrong is invisible until
 * someone's app boots without the macros or without `make:filter-client`.
 */
function recordingCommand() {
  const providers: string[] = [];
  const commands: string[] = [];

  const codemods = {
    async updateRcFile(callback: (rcFile: unknown) => void) {
      callback({
        addProvider: (specifier: string) => providers.push(specifier),
        addCommand: (specifier: string) => commands.push(specifier),
      });
    },
  };

  return {
    providers,
    commands,
    command: {
      async createCodemods() {
        return codemods;
      },
    },
  };
}

describe('configure', () => {
  it('registers the provider that installs the Lucid macros', async () => {
    const recorder = recordingCommand();

    await configure(recorder.command as any);

    expect(recorder.providers).toEqual(['@adonis-agora/filter/filter_provider']);
  });

  it('registers the commands barrel so `make:filter-client` is discoverable', async () => {
    const recorder = recordingCommand();

    await configure(recorder.command as any);

    expect(recorder.commands).toEqual(['@adonis-agora/filter/commands']);
  });

  it('registers the specifiers this package actually exports', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      name: string;
      exports: Record<string, unknown>;
    };
    const recorder = recordingCommand();

    await configure(recorder.command as any);

    // A specifier the package does not export resolves to nothing at boot, so
    // pin each registered one to a real `exports` subpath.
    for (const specifier of [...recorder.providers, ...recorder.commands]) {
      expect(specifier.startsWith(`${pkg.name}/`)).toBe(true);
      expect(Object.keys(pkg.exports)).toContain(`./${specifier.slice(pkg.name.length + 1)}`);
    }
  });
});
