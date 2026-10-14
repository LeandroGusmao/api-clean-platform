# Language

- All code (identifiers, strings, log messages, error messages) and all comments must be written in **English**.
- All documentation (`*.md`, skills, agents, specs and plans) must also be written in **English**.

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

# Comments

Comments explain the code they sit on — what it does, or why it is done this
way. Everything else belongs in `docs/`.

- **No process history.** Never write task, branch, review or slice narrative
  into a comment: "the review found", "slice 9 amended this", "since slice 11".
  The comment describes the code as it is, not how it got there.
- **The comment stands on its own.** It says why the code exists, in the
  comment itself. A pointer to another document (`see design §8`, `decision
  11`) does not explain — it defers, and the target moves or disappears while
  the pointer stays. `// Outside the transaction: argon2 would hold a pooled
  connection for the whole hash.` carries its reason. The one exception is a
  section of `ARCHITECTURE.md` that states a rule of the project, and even then
  the comment says the rule, not just the section number.
- **Stay local.** A comment does not describe another module's behaviour, or a
  flow this file does not take part in.
- **Put it on the line it governs.** A short comment above the statement beats
  a paragraph in the class docstring.
- The test: delete the comment and ask whether a competent reader of THIS file
  would now get it wrong. If not, it was decoration.

# Specs and plans

`docs/specs/` and `docs/plans/` are scratch space for the slice in flight. A
design or plan is written there while the slice is built, and the commit that
delivers the slice deletes it — git history keeps it. Before deleting, move
whatever still holds into the code comments or into `ARCHITECTURE.md`; nothing
in the tree may point into these folders.

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
