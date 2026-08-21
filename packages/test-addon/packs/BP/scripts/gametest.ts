/**
 * GameTest entry point — bundled only by the `test` and `build-test` profiles.
 *
 * Those profiles point the bundler at tsconfig.test.json, which names THIS file as the entry
 * instead of main.ts, and pair it with manifest.test.json, the only manifest that declares
 * @minecraft/server-gametest.
 *
 * Everything the release ships comes in through `./main`; the tests live in `./tests`. main.ts must
 * never import from here — that one rule is what keeps the beta module out of a release build.
 */
import './main';
import './tests';
