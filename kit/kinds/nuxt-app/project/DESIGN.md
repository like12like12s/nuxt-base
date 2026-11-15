# DESIGN.md — {{kit.title}}

Single source of truth for this project's visual identity. Read it before writing or changing UI. The numbers live in
the nuxt-base layer (`app/assets/css/base.css`, `@theme` tokens) — this file says how the app uses them and records
every deliberate deviation. To change a token for this app only, override it in the app's own css with another
`@theme { --color-…: … }` block and write the change down here first.

## 1. Visual theme

- **Mood**: calm, professional · **Density**: compact (internal tool)
- **Philosophy**: zinc dark surfaces, one accent colour, content first — no decoration that does not carry information.

## 2. Colour (layer tokens — use the utility, never a hex value)

```
role                  utility                     usage
background (base)     bg-bg                       page background
background (raised)   bg-surface                  cards, containers
background (elevated) bg-surface-2                modals, dropdowns, hover
border                border-line                 card and input borders
text (primary)        text-fg                     headings, body
text (secondary)      text-fg-2                   descriptions
text (muted)          text-muted / text-faint     hints, placeholders, labels
accent                bg-accent text-accent-fg    primary action, active state
danger                bg-danger                   errors, destructive actions
```

## 3. Typography

System sans stack from the layer. Page title `text-xl font-semibold` · section title `text-sm font-medium` ·
body `text-sm` · caption `text-xs text-muted`.

## 4. Components

Use the layer's components (Btn, Card, Field, Input, Select, Modal, Table, Tabs, Toast, …) and its patterns
(`AsyncState`, `EmptyState`, `ErrorState`). App-specific components go in `app/components/` and are built from the same
tokens. Icons: `lucide-vue-next` only — no emoji as icons. Radius: `rounded-ui`.

## 5. Layout and spacing

4 px scale (Tailwind default). Page padding `p-6`, section gap `space-y-6`, content width `max-w-3xl` for forms and
reading, full width for tables and dashboards.

## 6. Do / Don't

- Do: every data view goes loading -> error -> empty -> content (`AsyncState`); every empty state says what to do next.
- Do: dialogs via `Modal` / `ConfirmModal`.
- Don't: hex colours, a second CSS framework, `alert` / `confirm` / `prompt`, copies of layer components.

## 7. Responsive

Mobile first: single column below `sm` (640 px), tables scroll horizontally, touch targets at least 36 px.

## 8. Motion

150 ms ease-out for hover and focus; the layer already honours `prefers-reduced-motion`.
