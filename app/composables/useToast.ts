// Toast state for <Toast :message="toast.message" />. Shared across the app via useState.
export function useToast() {
  const message = useState<string>('nb-toast-message', () => '')
  let timer: ReturnType<typeof setTimeout> | undefined
  function show(msg: string, ms = 2500) {
    message.value = msg
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { message.value = '' }, ms)
  }
  // reactive → `toast.message` unwraps in templates (<Toast :message="toast.message" />)
  return reactive({ message, show })
}
