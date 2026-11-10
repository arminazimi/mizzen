# Rule hooks-005

Reports when a target is empty.

## Details

| Property | Value |
| --- | --- |
| Category | `hooks` |
| Severity | `error` |
| Limit | 61 |

## Fix

Change the target so it no longer is empty, then run `beacon doctor` again.

```bash
beacon doctor --rule hooks-005
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
