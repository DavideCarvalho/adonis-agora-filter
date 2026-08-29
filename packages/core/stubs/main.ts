import { fileURLToPath } from 'node:url';

/** Absolute path to this package's stubs, handed to `codemods.makeUsingStub`. */
export const stubsRoot = fileURLToPath(new URL('./', import.meta.url));
