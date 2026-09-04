# Language

- All code (identifiers, strings, log messages, error messages) and all comments must be written in **English**.
- Markdown documentation files (`*.md`) may be written in **Portuguese**.

# No Magic Strings/Numbers

- Never use magic strings or magic numbers inline in the code (e.g. `"application/json"`, `404`, `"Bearer"`, retry counts, timeouts).
- Always extract them into named constants (or enums, when the values represent a closed set of options).
- Place constants close to where they are used unless they are shared across multiple modules, in which case put them in a dedicated `constants.ts` (or similarly named) file within the relevant module/layer.
- Constant names must be descriptive and written in **English**, following `UPPER_SNAKE_CASE` for primitive constants (e.g. `DEFAULT_TIMEOUT_MS`).
- **Exception — schema declaration files** (`src/modules/*/infra/drizzle/schema/*.ts`, one file per table, named after the table): table, column and index names are written inline. They are the declaration itself, not a value referenced from somewhere else, and the generated migration is the source of truth for what actually reached the database. Extracting them would add indirection over a name that appears exactly once. This exception covers only the name strings; every other literal in those files (defaults, limits) follows the rule above.
  The exception stops applying once the name is **read from another file** —
  such as an index name the repository needs in order to tell which constraint
  was violated. At that point it no longer appears exactly once, so it becomes
  an exported constant, declared and used inside the schema file itself.

# Model Escalation

Applies only when the session model is **not** Opus (check the model named in your
system prompt). On Opus, ignore this section entirely.

Stop and escalate as soon as **any** of these is true — they are counts, not
judgment calls, so do not wait to "feel" stuck:

- The same test or error has survived **3** consecutive fix attempts without the
  error message changing.
- You have rewritten or reverted **the same file 2 times** in the same task.
- You have run the same command **4+ times** with the same failure.
- The user has corrected you **twice on the same point**.

When a trigger fires:

1. **Stop.** Do not attempt a fourth fix, and do not switch to a different angle
   on the same problem — the budget for this model on this task is spent.
2. Say which trigger fired and what the last known-good state is.
3. Offer the two escalation paths and wait: the user runs `/model opus` to
   continue in this session, or you dispatch the `opus-escalation` agent with a
   written handoff (failing command, exact error, what was already tried and
   ruled out, files touched).

Never silently continue past a trigger, and never claim the problem is "almost
solved" as a reason to keep going — that is the rationalization this rule exists
to catch.
