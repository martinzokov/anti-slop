/**
 * Hexagonal boundary enforcement via ESLint (flat config).
 * Verified against eslint-plugin-boundaries@7.2.0 + eslint@9.
 *
 *   npm i -D eslint typescript-eslint eslint-plugin-boundaries \
 *            eslint-import-resolver-typescript
 *
 * Use this instead of dependency-cruiser when you want violations inline in the
 * editor and in the same lint run as everything else.
 *
 * Two settings are load-bearing and silently produce ZERO violations if omitted:
 *   1. `languageOptions.parser` — without a TS parser every file is a parse error.
 *   2. `settings["import/resolver"].typescript` — without it, extensionless TS
 *      imports do not resolve, every dependency is classified "unknown", and the
 *      layer policies never fire. A green run is not proof of a clean codebase;
 *      seed a deliberate violation once and confirm it is reported.
 *
 * Assumed layout:
 *   src/domain/          entities, value objects, rules   — imports nothing
 *   src/application/     use cases + port interfaces      — imports domain
 *   src/adapters/<name>/ http, postgres, stripe, ...      — imports application, domain
 *   src/main/            composition root                 — imports everything
 *
 * The composition root is a FOLDER, not a `src/main.ts` file. Element patterns
 * match folders; a file pattern warns and classifies unreliably.
 */
import boundaries from "eslint-plugin-boundaries";
import tseslint from "typescript-eslint";

export default [
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: { parser: tseslint.parser },
    plugins: { boundaries },
    settings: {
      "import/resolver": { typescript: { alwaysTryTypes: true } },
      "boundaries/elements": [
        { type: "domain", pattern: "src/domain/**" },
        { type: "application", pattern: "src/application/**" },
        // `capture` names the adapter folder so a policy can say "only my own".
        { type: "adapter", pattern: "src/adapters/*/**", capture: ["adapterName"] },
        { type: "main", pattern: "src/main/**" },
      ],
    },
    rules: {
      // Deny by default. Allowed edges are enumerated below; anything not listed
      // is an error. An allow-by-default config silently permits every layer you
      // forget to name — never use one.
      "boundaries/dependencies": [
        "error",
        {
          default: "disallow",
          policies: [
            {
              from: { element: { type: "domain" } },
              allow: { to: { element: { type: "domain" } } },
            },
            {
              from: { element: { type: "application" } },
              allow: { to: { element: { types: { anyOf: ["application", "domain"] } } } },
            },
            {
              from: { element: { type: "adapter" } },
              allow: { to: { element: { types: { anyOf: ["application", "domain"] } } } },
            },
            {
              // An adapter may import itself, but not a sibling adapter.
              // `{{from.captured.adapterName}}` is v6+ template syntax; the older
              // `${...}` form still works but warns.
              from: { element: { type: "adapter" } },
              allow: {
                to: {
                  element: {
                    type: "adapter",
                    captured: { adapterName: "{{from.captured.adapterName}}" },
                  },
                },
              },
            },
            {
              from: { element: { type: "main" } },
              allow: { to: { element: { type: "*" } } },
            },
          ],
        },
      ],

      // Third-party packages. `boundaries/dependencies` above governs first-party
      // elements only, so without this a domain entity may freely import an ORM —
      // exactly the leak that matters most.
      //
      // NOTE: v7 deprecates this rule in favour of a `to: { module: { origin:
      // "external" } }` policy inside `boundaries/dependencies`. It still works
      // and is still the form that demonstrably fires; if you migrate, seed a
      // violation and confirm the new policy reports it before trusting a green run.
      "boundaries/external": [
        "error",
        {
          default: "allow",
          rules: [
            { from: ["domain"], disallow: ["*"] },
            {
              from: ["application"],
              disallow: [
                "express",
                "fastify",
                "@nestjs/*",
                "typeorm",
                "prisma",
                "mongoose",
                "knex",
                "axios",
              ],
            },
          ],
        },
      ],

      // Exhaustiveness: a file matching no element, or a dependency on something
      // unclassifiable, is an error — so a fourth unpoliced layer cannot appear
      // by accident, and a broken resolver surfaces as errors instead of silence.
      "boundaries/no-unknown-files": "error",
      "boundaries/no-unknown-dependencies": "error",
    },
  },
];
