# Rule hooks-039

Reports when a hook is not readable.

## Details

| Property | Value |
| --- | --- |
| Category | `hooks` |
| Severity | `error` |
| Limit | 32 |

## Fix

Change the hook so it no longer is not readable, then run `beacon doctor` again.

```bash
beacon doctor --rule hooks-039
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
