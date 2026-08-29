import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import loader, { getMetaData } from '../commands/main.js';
import MakeFilter from '../commands/make_filter.js';
import { stubsRoot } from '../stubs/main.js';

/**
 * `make:filter` is three moving parts that only fail at a user's terminal: the command has to be
 * in the barrel ace loads, the stub has to exist at the root the command hands to `makeUsingStub`,
 * and the stub has to render a class the rest of the library recognises. Each is checked here so a
 * missing `cp` in the build (the stub is not TypeScript, so `tsc` does not carry it into `dist`)
 * fails the suite instead of the scaffold.
 */
describe('make:filter', () => {
  it('is registered in the commands barrel', async () => {
    const metadata = await getMetaData();

    expect(metadata.map((command) => command.commandName)).toContain('make:filter');
    expect(await loader.getCommand({ commandName: 'make:filter' } as never)).toBe(MakeFilter);
  });

  it('resolves its stub from the package', () => {
    expect(existsSync(new URL('make/filter/main.stub', `file://${stubsRoot}`))).toBe(true);
  });

  it('scaffolds a class the runner can drive', () => {
    const stub = readFileSync(new URL('make/filter/main.stub', `file://${stubsRoot}`), 'utf-8');

    expect(stub).toContain("import { BaseModelFilter } from '@adonis-agora/filter'");
    expect(stub).toContain('extends BaseModelFilter');
    expect(stub).toContain('static filterable');
    expect(stub).toContain('setup()');
    // written into app/filters/, the directory `#filters/*` maps to
    expect(stub).toContain("app.makePath('app/filters'");
  });
});
