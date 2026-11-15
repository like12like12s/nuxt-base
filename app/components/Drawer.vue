<script setup lang="ts">
import { X } from 'lucide-vue-next'

// Bottom sheet on mobile (side panel from lg), or right side panel. Modal.vue behaviour (Esc, backdrop, aria, scroll lock)
// + focus trap (Tab/Shift+Tab stay inside, focus returns to the opener on close). Ported from price-compare (t760).
// theme 'dark' (default) = internal tools, 'auto' = light + `dark:` for public sites. Slots: default + footer, both get { close }.
const props = withDefaults(defineProps<{
  modelValue: boolean
  label: string
  side?: 'bottom' | 'right'
  theme?: 'dark' | 'auto'
  closeLabel?: string
}>(), { side: 'bottom', theme: 'dark', closeLabel: 'Close' })
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()
const panel = ref<HTMLElement | null>(null)
let lastFocus: HTMLElement | null = null

const c = computed(() => props.theme === 'auto'
  ? { panel: 'border-zinc-200 bg-white text-zinc-900 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100', line: 'border-zinc-200 dark:border-zinc-800', btn: 'hover:bg-zinc-100 dark:hover:bg-zinc-800' }
  : { panel: 'border-zinc-800 bg-zinc-900 text-zinc-100', line: 'border-zinc-800', btn: 'hover:bg-zinc-800' })

function close() { emit('update:modelValue', false) }
function onKey(e: KeyboardEvent) {
  if (!props.modelValue) return
  if (e.key === 'Escape') close()
  if (e.key === 'Tab' && panel.value) {
    const f = panel.value.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input,select,textarea,[tabindex]:not([tabindex="-1"])')
    if (!f.length) return
    const first = f[0]!, last = f[f.length - 1]!
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
  }
}
watch(() => props.modelValue, async (open) => {
  if (open) {
    lastFocus = document.activeElement as HTMLElement | null
    document.body.style.overflow = 'hidden'
    await nextTick()
    panel.value?.querySelector<HTMLElement>('button,a,input')?.focus()
  } else {
    document.body.style.overflow = ''
    lastFocus?.focus()
  }
})
onMounted(() => document.addEventListener('keydown', onKey))
onUnmounted(() => { document.removeEventListener('keydown', onKey); document.body.style.overflow = '' })
</script>

<template>
  <Teleport to="body">
    <div v-if="modelValue" class="fixed inset-0 z-50">
      <div class="absolute inset-0 bg-zinc-950/50 backdrop-blur-sm" @click="close" />
      <div
        ref="panel" role="dialog" aria-modal="true" :aria-label="label"
        class="absolute flex max-h-[85vh] flex-col border shadow-lg"
        :class="[c.panel, side === 'bottom'
          ? 'inset-x-0 bottom-0 rounded-t-xl lg:inset-y-0 lg:right-0 lg:left-auto lg:max-h-none lg:w-96 lg:rounded-none'
          : 'inset-y-0 right-0 w-full max-w-sm']"
      >
        <div class="flex items-center justify-between border-b px-4 py-3" :class="c.line">
          <h2 class="text-base font-semibold">{{ label }}</h2>
          <button type="button" class="grid size-9 place-items-center rounded-lg" :class="c.btn" :aria-label="closeLabel" @click="close">
            <X class="size-5" aria-hidden="true" />
          </button>
        </div>
        <div class="flex-1 overflow-y-auto p-4"><slot :close="close" /></div>
        <div v-if="$slots.footer" class="border-t p-4" :class="c.line"><slot name="footer" :close="close" /></div>
      </div>
    </div>
  </Teleport>
</template>
