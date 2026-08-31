import { args, BaseCommand } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';
import { stubsRoot } from '../stubs/main.js';

/**
 * `node ace make:filter <name>` — scaffold a filter class under `app/filters/`.
 *
 * The generated class extends `BaseModelFilter`: allow-lists as statics for the plain columns, a
 * `setup()` for the scope the client cannot relax, and a method per key that needs SQL of its own.
 * It is `@inject()`ed, so a constructor dependency resolves through the container exactly as a
 * controller's does.
 */
export default class MakeFilter extends BaseCommand {
  static override commandName = 'make:filter';
  static override description = 'Create a new filter class';
  static override options: CommandOptions = { allowUnknownFlags: true };

  @args.string({ description: 'Name of the filter (e.g. user)' })
  declare name: string;

  override async run(): Promise<void> {
    const codemods = await this.createCodemods();
    await codemods.makeUsingStub(stubsRoot, 'make/filter/main.stub', {
      flags: this.parsed.flags,
      entity: this.app.generators.createEntity(this.name),
    });
  }
}
