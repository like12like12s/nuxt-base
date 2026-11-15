// Load the current user once at startup when the auth hook is enabled (no-op otherwise).
export default defineNuxtPlugin(() => {
  const auth = useAuth()
  if (auth.enabled) void auth.load()
})
