/**
 * Runs `work` inside a single transaction, handing it repositories bound to
 * that transaction. Commits when `work` resolves, rolls back when it throws —
 * and the throw propagates unchanged.
 *
 * `TRepos` is whatever the caller's factory produces: one module's repositories,
 * or several modules' merged onto the same transaction.
 *
 * Three things must stay OUTSIDE the callback, because the transaction is held
 * open for its whole duration: external I/O (email, HTTP — persist inside, send
 * after the commit), CPU-heavy work (argon2 — compute before and pass the
 * result in), and any write that has to survive a failure (a brute-force
 * counter is autocommit by design, and a rollback would erase the very record
 * that remembers the failure). Opening a second unit of work in there throws.
 *
 * And the rule that neither the compiler nor the linter can enforce: **a use
 * case that receives a unit of work must NOT also receive a repository
 * directly**. The injected singleton writes on an autocommit connection, so a
 * call to it inside the callback compiles, passes its unit test against a
 * passthrough double, and silently breaks atomicity in production. Everything
 * the callback writes has to come from its `repos` parameter.
 */
export type IUnitOfWork<TRepos> = <T>(work: (repos: TRepos) => Promise<T>) => Promise<T>
