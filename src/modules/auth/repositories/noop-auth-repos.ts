// Test scaffolding: the inert `AuthRepos` shape for specs whose use case does
// not touch a given repo. Every method is an async no-op that returns the
// emptiest value its signature allows. Spread it and override only the members
// the spec actually exercises.

import type { AuthRepos } from './unit-of-work.js'

export function noopAuthRepos(): AuthRepos {
  return {
    users: {
      save: async () => {},
      findByEmail: async () => null,
      findById: async () => null,
      updatePasswordHash: async () => {},
    },
    refreshTokens: {
      save: async () => {},
      findByHashForUpdate: async () => null,
      markRotated: async () => {},
      revoke: async () => {},
      revokeFamily: async () => {},
      revokeAllForUser: async () => {},
      deleteExpiredBefore: async () => 0,
    },
    pendingRegistrations: {
      save: async () => {},
      findUnconsumedByEmail: async () => [],
      reissueCode: async () => {},
      registerFailedAttempt: async () => false,
      consume: async () => false,
      deleteExpiredByEmail: async () => {},
      deleteAllByEmail: async () => {},
      deleteExpiredBefore: async () => 0,
    },
    passwordResetTokens: {
      issueOrRefresh: async () => false,
      findByHash: async () => null,
      consume: async () => false,
      deleteExpiredBefore: async () => 0,
    },
    federatedIdentities: {
      save: async () => {},
      findByProviderUserId: async () => null,
    },
    outboxMessages: {
      save: async () => {},
      findPendingBatch: async () => [],
      markDispatched: async () => {},
      recordFailure: async () => {},
      deleteDispatchedOrFailedBefore: async () => 0,
    },
  }
}
