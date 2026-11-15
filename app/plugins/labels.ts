// Hands the app's labels (app.config: nuxtBase.lang / nuxtBase.labels) to the layer's components — see useLabels.ts.
export default defineNuxtPlugin((nuxtApp) => {
  nuxtApp.vueApp.provide(NB_LABELS_KEY, useLabels())
})
