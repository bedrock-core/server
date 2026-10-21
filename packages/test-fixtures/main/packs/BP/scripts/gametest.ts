/**
 * GameTest entry point — bundled only by the `test` and `build-test` profiles.
 *
 * The test manifest selects this entry and declares @minecraft/server-gametest.
 *
 * Everything the release ships comes in through `./main`; the tests live in `./tests`. main.ts must
 * never import from here — that one rule is what keeps the beta module out of a release build.
 */
import './main';
import './tests';
