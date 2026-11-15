// The roles of {{kit.name}}, most privileged first. They are the app's own vocabulary: identity-provider groups are
// mapped onto them by AUTH_ROLE_MAP, service tokens are created with them, routes demand them with requireRole().
// Adding a role: add it here, use it in a route, add its row to the matrix in tests/auth.spec.ts.
// @kit:if sample
export const ROLES = ['admin', 'editor'] as const
// @kit:else
export const ROLES = ['admin'] as const
// @kit:end
export type Role = (typeof ROLES)[number]
