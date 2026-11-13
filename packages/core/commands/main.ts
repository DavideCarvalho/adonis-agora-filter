import { ListLoader } from '@adonisjs/core/ace';
import AgoraDoctor from './agora_doctor.js';
import FilterDoctor from './filter_doctor.js';
import MakeFilter from './make_filter.js';
import MakeFilterClient from './make_filter_client.js';
import { FilterQueryExplain, FilterSpecsList, FilterSpecsShow } from './specs.js';

/**
 * The commands barrel for `@adonis-agora/filter`. An app registers it in its
 * `adonisrc` via `rcFile.addCommand('@adonis-agora/filter/commands')`. A
 * {@link ListLoader} exposes the `make:filter-client` command's metadata and
 * constructors to the ace kernel: `make:filter` (scaffold a filter class),
 * `make:filter-client` (emit the typed front-end builders), the `filter:specs:list`,
 * `filter:specs:show` and `filter:query:explain` reads, and the `agora:doctor` / `filter:doctor`
 * health check.
 *
 * `@adonisjs/core` is an *optional* peer of this otherwise framework-free core —
 * only this `./commands` subpath imports it, so the main entrypoint stays
 * dependency-free.
 */
const loader = new ListLoader([
  MakeFilter,
  MakeFilterClient,
  FilterSpecsList,
  FilterSpecsShow,
  FilterQueryExplain,
  FilterDoctor,
  AgoraDoctor,
]);

export const getMetaData = loader.getMetaData.bind(loader);
export const getCommand = loader.getCommand.bind(loader);

export default loader;
