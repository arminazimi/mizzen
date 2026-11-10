# Rule hooks-015

Reports when a token points at nothing.

## Details

| Property | Value |
| --- | --- |
| Category | `hooks` |
| Severity | `info` |
| Limit | 30 |

## Fix

Change the token so it no longer points at nothing, then run `beacon doctor` again.

```bash
beacon doctor --rule hooks-015
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
