import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { args, BaseCommand, flags } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';
import type { FilterClientManifest } from '../src/generate_client.js';
import { generateFilterClients } from '../src/generate_client.js';
import { loadFilterManifest, type ManifestLoad } from '../src/manifest.js';

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
 *
 * The output directory is `--output`, else `codegen.output` from the same module (or the `filter`
 * config), else `app/generated/filters`.
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
    description:
      'Output directory for the generated clients (default: codegen.output in config/filter.ts, else app/generated/filters)',
  })
  declare output?: string;

  override async run(): Promise<void> {
    const load = await this.#loadManifest();
    if (!load) return;
    const { manifest } = load;

    const output = this.output?.trim() || load.output.path;
    const outDir = isAbsolute(output) ? output : this.app.makePath(output);
    await mkdir(outDir, { recursive: true });

    const generated = generateFilterClients(manifest);
    for (const client of generated) {
      const path = join(outDir, client.filename);
      await writeFile(path, client.code, 'utf-8');
      this.logger.action(`create ${path}`).succeeded();
    }

    this.logger.success(`Generated ${generated.length} filter client(s) into ${output}.`);
  }

  /** Load the `filters` manifest with the loader the doctor and the dev tools share. */
  async #loadManifest(): Promise<Extract<ManifestLoad, { status: 'loaded' }> | undefined> {
    const load = await loadFilterManifest(this.app, this.entrypoint);
    if (load.status === 'loaded') return load;
    if (load.status === 'failed' || load.status === 'missing') {
      const reason = load.status === 'failed' ? load.error : 'the module was not found';
      this.logger.error(`Could not import filter manifest "${this.entrypoint}": ${reason}`);
      this.exitCode = 1;
      return undefined;
    }
    this.logger.warning(
      `No \`filters\` manifest exported from "${this.entrypoint}" — nothing to generate.`,
    );
    return undefined;
  }
}
