<script setup lang="ts">
import { ref, watch, nextTick, onMounted, onUnmounted } from 'vue'

const open = ref(false)
const input = ref('')
const messages = ref<{ role: string; content: string }[]>(
  JSON.parse(sessionStorage.getItem('qc_msgs') || '[]')
)
const loading = ref(false)
const chatEl = ref<HTMLElement>()
const inputEl = ref<HTMLInputElement>()

// Context — set from outside via composable or props
const context = ref('')
const contextLabel = ref('')

watch(messages, (v) => sessionStorage.setItem('qc_msgs', JSON.stringify(v)), { deep: true })

function toggle() {
  open.value = !open.value
  if (open.value) nextTick(() => inputEl.value?.focus())
}

// Works in Nuxt ($fetch) and plain Vue/Vite (global fetch fallback) — no hard Nuxt dependency
async function postChat(body: Record<string, unknown>): Promise<any> {
  const nuxtFetch = (globalThis as any).$fetch
  if (nuxtFetch) return nuxtFetch('/api/ai-chat', { method: 'POST', body })
  const res = await fetch('/api/ai-chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

async function send() {
  if (!input.value.trim()) return
  const msg = input.value
  input.value = ''
  messages.value.push({ role: 'user', content: msg })
  scrollBottom()
  loading.value = true

  try {
    const res = await postChat({ message: msg, context: context.value || 'No context', type: 'general', id: 'general' })
    messages.value.push({ role: 'assistant', content: res?.reply || 'Error' })
  } catch (e: any) {
    messages.value.push({ role: 'assistant', content: `Error: ${e?.message || 'request failed'}` })
  }
  loading.value = false
  scrollBottom()
}

function scrollBottom() {
  nextTick(() => { if (chatEl.value) chatEl.value.scrollTop = chatEl.value.scrollHeight })
}

function clear() {
  messages.value = []
  sessionStorage.removeItem('qc_msgs')
}

// Shortcuts: Cmd+K toggle, Esc close
onMounted(() => window.addEventListener('keydown', onKey))
onUnmounted(() => window.removeEventListener('keydown', onKey))
function onKey(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); toggle() }
  if (e.key === 'Escape' && open.value) { open.value = false }
}
</script>

<template>
  <!-- FAB -->
  <button
    v-if="!open"
    @click="toggle"
    class="fixed bottom-6 right-6 z-50 w-12 h-12 rounded-full bg-violet-600 hover:bg-violet-700 text-zinc-100 shadow-lg flex items-center justify-center transition-all hover:scale-105"
    title="Quick Chat (Cmd+K)"
  >
    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/></svg>
  </button>

  <!-- Popup -->
  <div v-if="open" class="fixed bottom-6 right-6 z-50 w-[400px] h-[500px] rounded-xl overflow-hidden shadow-2xl border border-zinc-700 bg-zinc-950 flex flex-col">
    <!-- Header -->
    <div class="flex items-center justify-between px-3 py-2 border-b border-zinc-800 bg-zinc-900/80">
      <div class="flex items-center gap-2 min-w-0">
        <span class="text-xs font-medium text-zinc-200">AI Chat</span>
        <span v-if="contextLabel" class="text-[11px] text-violet-400 bg-violet-500/10 px-1.5 py-0.5 rounded truncate max-w-[180px]">{{ contextLabel }}</span>
      </div>
      <div class="flex items-center gap-1">
        <button @click="clear" class="text-xs text-zinc-400 hover:text-zinc-200 px-1.5 py-0.5 rounded hover:bg-zinc-800">Clear</button>
        <button @click="open = false" class="text-zinc-400 hover:text-zinc-200 w-6 h-6 flex items-center justify-center rounded hover:bg-zinc-800">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
        </button>
      </div>
    </div>

    <!-- Messages -->
    <div ref="chatEl" class="flex-1 overflow-y-auto p-3 space-y-3">
      <div v-if="!messages.length" class="flex items-center justify-center h-full text-zinc-400 text-xs">
        {{ contextLabel ? `Ask about: ${contextLabel}` : 'Ask anything... (Cmd+K)' }}
      </div>
      <div v-for="(msg, i) in messages" :key="i" :class="['text-sm p-2.5 rounded-lg', msg.role === 'user' ? 'bg-zinc-800 text-zinc-200 ml-8' : 'bg-zinc-800/40 border border-zinc-700 text-zinc-300 mr-8']">
        <pre class="whitespace-pre-wrap text-xs leading-relaxed">{{ msg.content }}</pre>
      </div>
      <div v-if="loading" class="text-xs text-zinc-400 animate-pulse">Thinking...</div>
    </div>

    <!-- Input -->
    <div class="p-2 border-t border-zinc-800">
      <div class="flex gap-2">
        <input ref="inputEl" v-model="input" @keyup.enter="send" placeholder="Ask anything... (Cmd+K)" class="flex-1 bg-zinc-900 border border-zinc-700 rounded-lg px-3 h-9 text-sm text-zinc-200 placeholder:text-zinc-400 focus:outline-none focus:border-zinc-600" />
        <button @click="send" :disabled="loading || !input.trim()" class="bg-violet-600 hover:bg-violet-700 disabled:opacity-50 text-zinc-100 text-xs px-3 py-1.5 rounded-lg transition">Send</button>
      </div>
    </div>
  </div>
</template>
