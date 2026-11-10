# Rule hooks-033

Reports when a hook is missing.

## Details

| Property | Value |
| --- | --- |
| Category | `hooks` |
| Severity | `error` |
| Limit | 95 |

## Fix

Change the hook so it no longer is missing, then run `beacon doctor` again.

```bash
beacon doctor --rule hooks-033
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
