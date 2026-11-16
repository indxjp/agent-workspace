// A portal app reaches Agent Workspace only through the published @indx-workspace/* packages it
// installs from npm, never the platform's applications (apps/*) or its private packages (the
// @agent-workspace scope, which a third party owns on npm), installed or not.
/** @type {import('dependency-cruiser').IConfiguration} */
export default {
  forbidden: [
    {
      name: 'app-imports-only-published-packages',
      severity: 'error',
      from: {},
      to: { path: '(^|/)@agent-workspace\\/|(^|/)apps/' },
    },
  ],
  options: {
    doNotFollow: { path: '(^|/)node_modules/' },
    exclude: { path: '(^|/)(\\.next|\\.agent-workspace|\\.aw)/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
  },
};
