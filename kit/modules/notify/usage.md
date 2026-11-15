## Notifications (`{{kit.apiDir}}`, module `notify`)

- `appNotifier(config, logger).notify({ topic, title, message, priority?, dedupeKey?, resolved? })` (`src/notify.ts`)
  posts to the notification hub: `POST <NOTIFIER_URL>/notify`, `Authorization: Bearer <NOTIFIER_TOKEN>`. The hub
  owns channels, de-duplication and rate limits — the app only says what happened.
- Off until `NOTIFIER_URL` is set. It never throws and gives up after 5 s: a notification that cannot be sent must not
  fail the work that wanted to send it. The result (`{ ok }` / `{ ok: false, error }`) and a `notification not sent`
  warning in the log say what happened.
- Tests mock `fetch` (`tests/notify.spec.ts`) — never call the real hub from a test.
