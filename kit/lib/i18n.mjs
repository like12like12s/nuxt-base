// The words generated pages say. One language per project (`--lang th|en`, default th — the language of the layer's
// own defaults), recorded in .scaffold.json; generators read it from the manifest. Add a key in BOTH languages.
export const LANGS = ['th', 'en']
export const DEFAULT_LANG = 'th'

const TEXT = {
  th: {
    emptyTitle: 'ยังไม่มีข้อมูล',
    emptyPage: 'แทนที่ส่วนนี้ด้วยเนื้อหาของหน้า',
    noneYet: (what) => `ยังไม่มี ${what}`,
    createFirst: 'กดปุ่ม "เพิ่ม" เพื่อสร้างรายการแรก',
    add: 'เพิ่ม',
    create: 'สร้าง',
    edit: 'แก้ไข',
    save: 'บันทึก',
    delete: 'ลบ',
    cancel: 'ยกเลิก',
    back: 'กลับไปหน้ารายการ',
    name: 'ชื่อ',
    createdAt: 'สร้างเมื่อ',
    updatedAt: 'แก้ไขล่าสุด',
    newTitle: (what) => `เพิ่ม ${what}`,
    editTitle: (what) => `แก้ไข ${what}`,
    deleteTitle: (what) => `ลบ ${what} นี้?`,
    deleteMessage: 'รายการจะถูกซ่อนจากทุกหน้า (ลบแบบ soft delete)',
    created: 'สร้างแล้ว',
    saved: 'บันทึกแล้ว',
    deleted: 'ลบแล้ว',
    detail: 'รายละเอียด',
  },
  en: {
    emptyTitle: 'Nothing here yet',
    emptyPage: 'Replace this with the page content.',
    noneYet: (what) => `No ${what} yet`,
    createFirst: 'Use "Add" to create the first one.',
    add: 'Add',
    create: 'Create',
    edit: 'Edit',
    save: 'Save',
    delete: 'Delete',
    cancel: 'Cancel',
    back: 'Back to the list',
    name: 'Name',
    createdAt: 'Created',
    updatedAt: 'Last changed',
    newTitle: (what) => `New ${what}`,
    editTitle: (what) => `Edit ${what}`,
    deleteTitle: (what) => `Delete this ${what}?`,
    deleteMessage: 'It disappears from every page (soft delete).',
    created: 'Created',
    saved: 'Saved',
    deleted: 'Deleted',
    detail: 'Details',
  },
}

/** The project's language: `answers.lang` of the manifest, th when it was never recorded. */
export const langOf = (manifest) => (LANGS.includes(manifest?.answers?.lang) ? manifest.answers.lang : DEFAULT_LANG)
export const text = (lang) => TEXT[LANGS.includes(lang) ? lang : DEFAULT_LANG]
