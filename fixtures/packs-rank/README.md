# Rank fixtures

Two small sites that pin the task-aware ranking in `test/packs-rank.test.ts`. They are read-only,
like every fixture: a task that needs different content adds another folder and says why.

| Folder | What it ranks |
| --- | --- |
| `docs/` | A primary page, a required supporting page it links to, a nearby sibling, a distant reference page, a canonical reference page, and a generated duplicate of it. |
| `versions/` | A canonical newest-version page, a deprecated older version of the same page, a required supporting page, a nearby sibling, and a declared Persian translation. |

`docs` answers navigation proximity, dependency necessity, and trust. `versions` answers version and
locale matching, and shows that a low-trust duplicate carries a reason naming its canonical source.
