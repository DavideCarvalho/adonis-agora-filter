import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { args, BaseCommand, flags } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';
import type { FilterClientManifest } from '../src/generate_client.js';
import { generateFilterClients } from '../src/generate_client.js';

/**
 * `node ace make:filter-client [entrypoint]` — the idiomatic AdonisJS equivalent
 * of the NestJS `nestjs-filter` codegen bin.
 *
 * Where NestJS ships a standalone `reflect-metadata` bin that reads decorator
 * metadata off entity classes, the Adonis filter declaration is already a plain
 * runtime {@link FilterClientManifest} (`defineFilter(...)` specs), so this is a
 * thin IO wrapper: it loads the app's declared `filters` manifest, hands it to
 * the pure {@link generateFilterClients} core, and writes each emitted typed
 * client to disk. All generation logic lives in `../src/generate_client.ts` and
 * is unit-tested there — this command only does the file IO.
 *
 * The entrypoint module (default `config/filter.js`) must export a `filters`
 * manifest (named export, or default):
 *
 * ```ts
 * // config/filter.ts
 * import { defineFilter } from '@adonis-agora/filter'
 * export const filters = {
 *   people: { spec: defineFilter({ filterable: ['name', 'age'] }), fieldTypes: { age: { kind: 'number' } } },
 * }
 * ```
 */
export default class MakeFilterClient extends BaseCommand {
  static override commandName = 'make:filter-client';
  static override description =
    "Generate typed filter clients from the app's declared filter specs";
  static override options: CommandOptions = { startApp: true };

  @args.string({
    description: 'Module exporting a `filters` manifest',
    required: false,
    default: 'config/filter.js',
  })
  declare entrypoint: string;

  @flags.string({
    description: 'Output directory for the generated clients',
    default: 'app/generated/filters',
  })
  declare output: string;

  override async run(): Promise<void> {
    const manifest = await this.#loadManifest();
    if (!manifest) return;

    const outDir = isAbsolute(this.output) ? this.output : this.app.makePath(this.output);
    await mkdir(outDir, { recursive: true });

    const generated = generateFilterClients(manifest);
    for (const client of generated) {
      const path = join(outDir, client.filename);
      await writeFile(path, client.code, 'utf-8');
      this.logger.action(`create ${path}`).succeeded();
    }

    this.logger.success(`Generated ${generated.length} filter client(s) into ${this.output}.`);
  }

  /** Import the entrypoint module and read its `filters` manifest (named or default export). */
  async #loadManifest(): Promise<FilterClientManifest | undefined> {
    const url = this.app.makeURL(this.entrypoint).href;
    let mod: Record<string, unknown>;
    try {
      mod = (await import(url)) as Record<string, unknown>;
    } catch (error) {
      this.logger.error(`Could not import filter manifest "${this.entrypoint}": ${String(error)}`);
      this.exitCode = 1;
      return undefined;
    }

    const manifest = (mod.filters ?? mod.default) as FilterClientManifest | undefined;
    if (!manifest || Object.keys(manifest).length === 0) {
      this.logger.warning(
        `No \`filters\` manifest exported from "${this.entrypoint}" — nothing to generate.`,
      );
      return undefined;
    }
    return manifest;
  }
}
