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
 * That third one shipped as a defect once, so it is worth naming concretely:
 * the refresh token rotation revoked a reused token's whole family and then
 * THREW from inside the callback. The throw rolled the revocation back, so
 * detection fired, answered 401, and left the stolen session alive. When an
 * operation has to both persist AND fail, return the outcome as data and raise
 * the error after the commit.
 *
 * And the rule for a use case that receives a unit of work: **it does not
 * WRITE through a repository received directly**. The injected singleton
 * writes on an autocommit connection, so a call to it inside the callback
 * compiles, passes its unit test against a passthrough double, and silently
 * breaks atomicity in production. Everything the callback writes has to come
 * from its `repos` parameter.
 *
 * A direct READ is harmless, and sometimes forced: argon2 must run outside the
 * transaction, and a `compare` needs the stored hash first. So such a use case
 * may take a repository directly, declared as a `Pick` of exactly the methods
 * it calls — which turns a stray write into a compile error. A write belongs in
 * that `Pick` only when it is the third case above, a record that has to
 * survive the rollback, and the declaration says so where it sits.
 */
export type IUnitOfWork<TRepos> = <T>(work: (repos: TRepos) => Promise<T>) => Promise<T>
