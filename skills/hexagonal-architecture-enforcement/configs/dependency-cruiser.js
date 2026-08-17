/**
 * Hexagonal boundary enforcement for TypeScript.
 * Run: npx depcruise src --config .dependency-cruiser.js
 *
 * Assumed layout:
 *   src/domain/          entities, value objects, rules      — imports nothing
 *   src/application/     use cases + port interfaces         — imports domain
 *   src/adapters/<name>/ http, postgres, stripe, ...         — imports application, domain
 *   src/main/            composition root                    — imports everything
 */
module.exports = {
  forbidden: [
    {
      name: "domain-is-pure",
      comment:
        "src/domain may only import from src/domain. No application, no adapters, " +
        "no npm packages, no node builtins. If you need the time or a UUID, take it " +
        "as an argument or define a port in src/application.",
      severity: "error",
      from: { path: "^src/domain" },
      to: { pathNot: "^src/domain" },
    },
    {
      name: "application-not-adapters",
      comment:
        "src/application must not import src/adapters. Define a port (an interface) " +
        "in src/application and let the adapter implement it.",
      severity: "error",
      from: { path: "^src/application" },
      to: { path: "^src/adapters" },
    },
    {
      name: "application-no-frameworks",
      comment:
        "Use cases must not depend on transport or persistence frameworks. " +
        "Convert at the adapter edge.",
      severity: "error",
      from: { path: "^src/application" },
      to: {
        dependencyTypes: ["npm"],
        path: "express|fastify|@nestjs|typeorm|prisma|mongoose|knex|axios",
      },
    },
    {
      name: "adapters-are-independent",
      comment:
        "An adapter may not import a sibling adapter. Route the call through an " +
        "application use case, or through a port both adapters know.",
      severity: "error",
      from: { path: "^src/adapters/([^/]+)/" },
      // $1 back-references the capture group above: 'any adapter that is not my own'.
      to: { path: "^src/adapters/([^/]+)/", pathNot: "^src/adapters/$1/" },
    },
    {
      name: "no-inward-from-main",
      comment:
        "Nothing may import the composition root. src/main wires the app; it is not a module.",
      severity: "error",
      from: { pathNot: "^src/main/" },
      to: { path: "^src/main/" },
    },
    {
      name: "no-circular",
      comment: "Cycles make layer rules meaningless. Break the cycle with a port.",
      severity: "error",
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    // Follow `import type` too — a type-only import of an adapter is still a boundary breach.
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    doNotFollow: { path: "node_modules" },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
