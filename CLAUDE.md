# Language

- All code (identifiers, strings, log messages, error messages) and all comments must be written in **English**.
- Markdown documentation files (`*.md`) may be written in **Portuguese**.

# No Magic Strings/Numbers

- Never use magic strings or magic numbers inline in the code (e.g. `"application/json"`, `404`, `"Bearer"`, retry counts, timeouts).
- Always extract them into named constants (or enums, when the values represent a closed set of options).
- Place constants close to where they are used unless they are shared across multiple modules, in which case put them in a dedicated `constants.ts` (or similarly named) file within the relevant module/layer.
- Constant names must be descriptive and written in **English**, following `UPPER_SNAKE_CASE` for primitive constants (e.g. `DEFAULT_TIMEOUT_MS`).
- **Exception — schema declaration files** (`src/modules/*/infra/drizzle/schema/*.ts`, one file per table, named after the table): table, column and index names are written inline. They are the declaration itself, not a value referenced from somewhere else, and the generated migration is the source of truth for what actually reached the database. Extracting them would add indirection over a name that appears exactly once. This exception covers only the name strings; every other literal in those files (defaults, limits) follows the rule above.
