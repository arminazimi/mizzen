# Rule hooks-047

Reports when a hook is not readable.

## Details

| Property | Value |
| --- | --- |
| Category | `hooks` |
| Severity | `info` |
| Limit | 30 |

## Fix

Change the hook so it no longer is not readable, then run `beacon doctor` again.

```bash
beacon doctor --rule hooks-047
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
