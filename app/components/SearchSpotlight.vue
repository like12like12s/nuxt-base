<template>
  <Teleport to="body">
    <Transition name="spotlight">
      <div v-if="open" class="fixed inset-0 z-[200] flex items-start justify-center pt-[12vh] px-4" @click.self="$emit('update:open', false)">
        <!-- bg ทึบ ไม่ใช้ backdrop-blur — blur บังคับ GPU rasterize ทั้งหน้าที่อยู่ด้านล่างตอน mount (พิมพ์ตัวแรกเบิ้ล) -->
        <div class="w-full max-w-xl bg-zinc-900 border border-zinc-700/60 rounded-2xl shadow-2xl overflow-hidden">
          <!-- Input -->
          <div class="relative flex items-center">
            <svg class="absolute left-4 w-4 h-4 text-zinc-500" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
            <input ref="sInput" :value="query" @input="$emit('update:query', ($event.target as HTMLInputElement).value)" @keydown="onKey"
              :placeholder="placeholder" autocomplete="off"
              class="w-full bg-transparent border-0 pl-11 pr-20 py-4 text-base text-zinc-100 focus:outline-none placeholder-zinc-400" />
            <button v-if="query && flipThai" @click="$emit('update:query', flipLayout(query))" title="Switch EN↔TH (Tab)"
              class="absolute right-3 flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-200 bg-zinc-800 rounded-lg px-2 py-1 transition-colors">
              ก↔A <kbd class="text-xs text-zinc-400">Tab</kbd>
            </button>
          </div>
          <!-- Results (parent ส่งมาทาง prop — component เอาแค่ UI + keyboard nav) -->
          <div v-if="results.length" class="border-t border-zinc-800/80 max-h-[50vh] overflow-y-auto py-1.5">
            <button v-for="(item, i) in results" :key="i" @click="$emit('select', item)" @mousemove="idx = i"
              :class="['w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors', i === idx ? 'bg-zinc-800/80' : '']">
              <slot name="row" :item="item" :index="i" :selected="i === idx" />
              <svg v-if="i === idx" class="w-3.5 h-3.5 text-zinc-600 shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M9 18l6-6-6-6" /></svg>
            </button>
          </div>
          <div v-else-if="query" class="border-t border-zinc-800/80 py-6 text-center">
            <slot name="empty" :query="query" :flipped="flipThai ? emptyFlipped : null">
              <div class="text-sm text-zinc-400 mb-2">No results for "{{ query }}"</div>
            </slot>
            <button v-if="flipThai && emptyFlipped" @click="$emit('update:query', emptyFlipped)" class="text-sm text-blue-400 hover:text-blue-300 transition-colors">
              Did you mean "{{ emptyFlipped }}"? →
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
// Spotlight search palette — port จาก metool (พอร์ตจาก Place)
// Usage:
//   <SearchSpotlight v-model:open="open" v-model:query="q" :results="results" @select="go">
//     <template #row="{ item, selected }">...</template>
//   </SearchSpotlight>
// Parent เป็นเจ้าของ query/results/select (ค้นหา + flip-merge) — component เอาแค่ UI + ↑↓/Enter/Esc/Tab + blur กัน race หลังปิด
// แนะนำ: ⌘K + type-to-search ทำที่ parent (มี guard เฉพาะ app เช่น หน้าที่ capture คีย์) — ดูต้นฉบับ AppSearchSpotlight ใน metool
// ⚠️ type-to-search prefill pitfall (เจอจริง 2026-08-24 ใน place):
//   - prefill `sq.value = e.key` + browser default insert เข้า input ที่เพิ่งโฟกัส (focus ทันผ่าน microtask ก่อน default action) = ตัวอักษรออกสองตัว
//   - แก้: e.preventDefault() เฉพาะตอน prefill (ASCII) เท่านั้น
//   - ห้าม preventDefault นอก ASCII branch — ตัวไทย/IME ไม่มี prefill (ปล่อยให้ browser insert เอง) จะโดนกลืนหายไปเลย
const props = withDefaults(defineProps<{
  open: boolean
  query: string
  results: unknown[]
  placeholder?: string
  flipThai?: boolean
}>(), { placeholder: 'Search...', flipThai: true })

const emit = defineEmits<{
  'update:open': [value: boolean]
  'update:query': [value: string]
  'select': [item: unknown]
}>()

const sInput = ref<HTMLInputElement | null>(null)
const idx = ref(0)

// Thai↔English keyboard flip — Kedmanee base layer ตัวจริง (จาก /usr/share/X11/xkb/symbols/th)
const EN_TH: Record<string, string> = {
  '`': '_', '1': 'ๅ', '2': '/', '3': '-', '4': 'ภ', '5': 'ถ', '6': 'ุ', '7': 'ึ', '8': 'ค', '9': 'ต', '0': 'จ', '-': 'ข', '=': 'ช',
  q: 'ๆ', w: 'ไ', e: 'ำ', r: 'พ', t: 'ะ', y: 'ั', u: 'ี', i: 'ร', o: 'น', p: 'ย', '[': 'บ', ']': 'ล',
  a: 'ฟ', s: 'ห', d: 'ก', f: 'ด', g: 'เ', h: '้', j: '่', k: 'า', l: 'ส', ';': 'ว', "'": 'ง',
  z: 'ผ', x: 'ป', c: 'แ', v: 'อ', b: 'ิ', n: 'ื', m: 'ท', ',': 'ม', '.': 'ใ', '/': 'ฝ',
}
const TH_EN = Object.fromEntries(Object.entries(EN_TH).map(([k, v]) => [v, k]))

function flipLayout(str: string) {
  if (!str) return str
  const isEN = /^[\x00-\x7F\s]+$/.test(str)
  const map = isEN ? EN_TH : TH_EN
  return str.split('').map(c => map[c.toLowerCase()] ?? c).join('')
}

// เสนอคำ flipped เมื่อไม่มีผลลัพธ์ (parent ควร flip-merge ใน results อยู่แล้ว — อันนี้เผื่อไม่ได้ทำ)
const emptyFlipped = computed(() => {
  if (!props.query || props.results.length) return null
  const flipped = flipLayout(props.query)
  return flipped !== props.query ? flipped : null
})

function close() {
  emit('update:open', false)
  emit('update:query', '')
  // blur ทันที — ไม่งั้น input ที่กำลัง fade-out ยังถือโฟกัส พิมพ์ต่อเนื่องภายใน transition (~150ms) จะหายเฉยๆ
  sInput.value?.blur()
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') { e.preventDefault(); close() }
  else if (e.key === 'Tab' && props.flipThai) { e.preventDefault(); emit('update:query', flipLayout(props.query)) }
  else if (e.key === 'ArrowDown') { e.preventDefault(); idx.value = Math.min(idx.value + 1, props.results.length - 1) }
  else if (e.key === 'ArrowUp') { e.preventDefault(); idx.value = Math.max(idx.value - 1, 0) }
  else if (e.key === 'Enter') { e.preventDefault(); const item = props.results[idx.value]; if (item !== undefined) { close(); emit('select', item) } }
}

watch(() => props.query, () => { idx.value = 0 })
// เปิด → focus input (parent ทำ type-to-search prefill เอง ก็ควร nextTick ต่อจาก open=true)
watch(() => props.open, v => { if (v) { idx.value = 0; nextTick(() => sInput.value?.focus()) } })
</script>

<style>
.spotlight-enter-active { transition: all 0.2s ease; }
.spotlight-leave-active { transition: all 0.15s ease; }
.spotlight-enter-from { opacity: 0; transform: scale(0.96) translateY(-10px); }
.spotlight-leave-to { opacity: 0; transform: scale(0.98); }
</style>
