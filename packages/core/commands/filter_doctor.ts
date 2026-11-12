import AgoraDoctor from './agora_doctor.js';

/** `node ace filter:doctor`: `agora:doctor` for `@adonis-agora/filter` only. */
export default class FilterDoctor extends AgoraDoctor {
  static override commandName = 'filter:doctor';
  static override description = 'Check the @adonis-agora/filter configuration';
  protected override presetLib: string | undefined = 'filter';
}
