// The words the layer's own components say (loading, empty, error, retry, confirm / cancel, the error page), in ONE
// language per app. `nuxtBase.lang` in app.config picks the set ('th' is the default, as before); `nuxtBase.labels`
// overrides single entries. Components read them through provide/inject (plugins/labels.ts), so the copies of these
// components that live outside Nuxt keep working: without a provider they fall back to their built-in Thai text.
export const NB_LABELS = {
  th: {
    loading: 'กำลังโหลด…',
    empty: 'ยังไม่มีข้อมูล',
    loadFailed: 'โหลดข้อมูลไม่สำเร็จ',
    retry: 'ลองใหม่',
    confirm: 'ยืนยัน',
    cancel: 'ยกเลิก',
    notFound: 'ไม่พบหน้านี้',
    error: 'เกิดข้อผิดพลาด',
    home: 'กลับหน้าแรก',
    reload: 'โหลดใหม่',
  },
  en: {
    loading: 'Loading…',
    empty: 'Nothing here yet',
    loadFailed: 'Could not load the data',
    retry: 'Try again',
    confirm: 'Confirm',
    cancel: 'Cancel',
    notFound: 'Page not found',
    error: 'Something went wrong',
    home: 'Back to home',
    reload: 'Reload',
  },
} as const

export type NbLang = keyof typeof NB_LABELS
export type NbLabels = Record<keyof (typeof NB_LABELS)['th'], string>
/** The provide/inject key the layer's components read. */
export const NB_LABELS_KEY = 'nb-labels'

export function resolveLabels(lang: string | undefined, overrides: Partial<NbLabels> = {}): NbLabels {
  const base = NB_LABELS[lang && lang in NB_LABELS ? (lang as NbLang) : 'th']
  const given = Object.fromEntries(Object.entries(overrides).filter(([key, value]) => key in base && typeof value === 'string' && value))
  return { ...base, ...given }
}

/** The labels of this app: `useLabels().retry`. */
export function useLabels(): NbLabels {
  const config = useAppConfig().nuxtBase
  return resolveLabels(config.lang, config.labels)
}
