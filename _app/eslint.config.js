import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

export default tseslint.config(
  {
    /*
      Nothing outside this project is ours to lint. `public/`-style content at the repo root —
      the terms/privacy pages the browser console generates, the committed build output —
      must be byte-preserved, and merely parsing it wastes time.
    */
    ignores: ['dist', 'node_modules', 'coverage', 'src/routeTree.gen.ts'],
  },
  js.configs.recommended,
  {
    /*
      Type-checked rules are scoped to TS, not spread at top level.

      Spreading `recommendedTypeChecked` globally applies rules like `await-thenable` to
      this config file and to scripts/*.mjs, which have no type information and are not in
      tsconfig's `include` — ESLint then dies with "you have used a rule which requires type
      information". Scoping via `extends` inside a `files` block is the fix.
    */
    files: ['**/*.{ts,tsx}'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,

      // Untyped library edges are where `any` gets in. The Device Lab talks to ya-webadb and
      // the xconsole parses JSON off the GitHub API — both must be narrowed, not asserted.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',

      '@typescript-eslint/consistent-type-imports': [
        'error',
        { fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',

      /*
        Dependency direction: routes/ → features/ → components/ → lib/, api/, types/.
        A shared component that reaches back into a feature is how a component library stops
        being shared.
      */
      'no-restricted-imports': 'off',

      /*
        No raw hex colours: every colour must be a semantic token from src/styles/theme.css.
        This repo had FOUR divergent copies of the same palette before the migration, kept in
        sync by hand.

        The one legitimate exception is the terms/privacy generator, which emits a standalone
        public HTML document whose CSS is its own bytes — see the override below.
      */
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=/#[0-9a-fA-F]{3,8}\\b/]',
          message:
            'No raw hex colours. Use a semantic token; the palette lives in src/styles/theme.css.',
        },
      ],
    },
  },
  {
    // Shared components must not depend on features.
    files: ['src/components/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/features/*', '../features/*', '../../features/*'],
              message:
                'components/ is the shared layer: it may not import from features/. Move the shared part down, or the component up into the feature.',
            },
          ],
        },
      ],
    },
  },
  {
    /*
      The terms/privacy templates emit a live, app-store-referenced HTML document. The hex
      values in them are EMITTED BYTES of that page, not app styling — tokenising them would
      change /terms/{slug}/ for no benefit. Byte-identity is enforced by a golden-master test
      instead.
    */
    files: ['src/features/xconsole/term-privacy/templates/**/*.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    files: ['src/components/ui/**/*.{ts,tsx}'],
    rules: {
      // Vendored shadcn primitives: they arrive in the registry's own style and the next
      // `shadcn add` reverts local edits.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      'no-restricted-syntax': 'off',
    },
  },
  {
    files: ['**/*.test.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    // vite.config.ts IS type-checked (it is in tsconfig's include), it just runs in Node.
    files: ['vite.config.ts'],
    languageOptions: { globals: globals.node },
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    /*
      Plain JS with no type information: this config file, and the build scripts that sync
      output to the repo root. They are deliberately .mjs — they run before/outside the TS
      toolchain, and scripts/publish.mjs must work from a clean checkout with nothing built.
    */
    files: ['**/*.{js,mjs}'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.node,
    },
    rules: { 'no-restricted-syntax': 'off' },
  },
)
