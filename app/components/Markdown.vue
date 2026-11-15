<template>
  <div class="text-sm text-zinc-300 leading-relaxed" v-html="html" />
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({ source: { type: String, default: '' } });

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const inline = (s) => esc(s)
  .replace(/`([^`]+)`/g, '<code class="px-1 py-0.5 rounded bg-zinc-800 text-zinc-200 text-xs font-mono">$1</code>')
  .replace(/\*\*([^*]+)\*\*/g, '<strong class="text-zinc-100 font-semibold">$1</strong>')
  .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener" class="text-blue-400 hover:text-blue-300 underline underline-offset-2">$1</a>');

const html = computed(() => {
  const out = [];
  let inCode = false, list = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const openList = (t) => { if (list !== t) { closeList(); out.push(`<${t} class="list-${t === 'ol' ? 'decimal' : 'disc'} pl-5 space-y-1 my-2">`); list = t; } };
  for (const raw of String(props.source).split('\n')) {
    if (raw.trim().startsWith('```')) {
      if (inCode) { out.push('</code></pre>'); inCode = false; }
      else { closeList(); out.push('<pre class="rounded-lg bg-zinc-950 border border-zinc-800 p-3 my-2 overflow-x-auto text-xs font-mono text-zinc-300"><code>'); inCode = true; }
      continue;
    }
    if (inCode) { out.push(esc(raw) + '\n'); continue; }
    const t = raw.trim();
    if (!t) { closeList(); continue; }
    const h = t.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      closeList();
      const cls = ['text-lg font-semibold text-zinc-50 mt-4 mb-1', 'text-base font-semibold text-zinc-100 mt-4 mb-1', 'text-sm font-semibold text-zinc-200 mt-3 mb-1', 'text-sm font-semibold text-zinc-300 mt-3 mb-1'][h[1].length - 1];
      out.push(`<div class="${cls}">${inline(h[2])}</div>`);
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(t)) { closeList(); out.push('<hr class="border-zinc-800 my-3">'); continue; }
    const ul = t.match(/^[-*]\s+(.*)$/);
    if (ul) { openList('ul'); out.push(`<li>${inline(ul[1])}</li>`); continue; }
    const ol = t.match(/^\d+\.\s+(.*)$/);
    if (ol) { openList('ol'); out.push(`<li>${inline(ol[1])}</li>`); continue; }
    closeList();
    out.push(`<p class="my-2">${inline(t)}</p>`);
  }
  if (inCode) out.push('</code></pre>');
  closeList();
  return out.join('');
});
</script>
