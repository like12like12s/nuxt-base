<template>
  <div class="overflow-x-auto">
    <table class="w-full text-sm text-left min-w-max">
      <thead>
        <tr class="border-b border-zinc-800 text-xs text-zinc-400 uppercase tracking-wide">
          <slot name="head" />
        </tr>
      </thead>
      <tbody class="divide-y divide-zinc-800/50">
        <slot />
      </tbody>
    </table>
  </div>
</template>
