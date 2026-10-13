# Client app regression suite

Opens real client pages in headless Chrome and drives the flows clients use, against a fake backend. Nothing leaves the machine, and no real client data is read or written.

| Check | What it proves |
|---|---|
| load | The page loads with no script errors, and the Nutrition view lists meals. |
| start | A new page (not yet on origin/main) must set `client.startDate`, so week 1 never depends on the phone's first-open date. Existing pages without one only warn, because changing it would move that client in their programme. |
| tick | "Ate it" marks the card and adds the meal to the day total. A double tap sends one save. Undo clears it. |
| swap | The card shows the replacement's name and kcal straight away. The day total counts it once. Three taps send one save. The "Meal swapped" wording appears only after a confirmed save. It survives a reload. |
| offline | An offline swap is kept, labelled "Not synced yet", and never called synced. Several retry triggers send exactly one save. |
| weeks | A calendar week in a locked phase keeps its own ticks: none bleed in from the week before, none leak to the week after, and undo there leaves other weeks alone. This check uses a fake clock 10 days into the programme. |

```
node tests/client_app/run.js                 # pages changed vs origin/main + reference pages
node tests/client_app/run.js --all           # every client page (~10 min)
node tests/client_app/run.js bishoy_shaker   # named pages
sh tests/client_app/install-hook.sh          # gate every push that changes a client page
```

The pre-push hook runs the suite on the changed pages plus the reference pages, and blocks the push on any failure. Emergency bypass: `git push --no-verify`.

It needs Google Chrome and Node 22 or later, with no npm packages (`cdp.js` is a small DevTools Protocol driver).

Validated 2026-10-13 against the pre-fix versions of Bishoy's page:
- the swap-render bug fails `swap`;
- the honest-sync wording fails `offline`;
- the shared-ticks bug fails `weeks`;
- Hassan's missing start date fails `start`.

The current pages pass.
