// Placeholder. The `ui-compile` filter replaces this in the build workspace
// with one `registerCompiledScreen` call per compiled screen — the guide pages
// the guides filter writes as screen modules; what is committed here is only
// what the editor and `tsc` read before Regolith has ever run, the same
// arrangement the i18n and guides bundles use.
//
// Importing it is what turns compiled screens on, and what makes
// `uiReference()` find the compiled screens to publish.
export {};
