# Rule hooks-051

Reports when a artifact is missing.

## Details

| Property | Value |
| --- | --- |
| Category | `hooks` |
| Severity | `error` |
| Limit | 10 |

## Fix

Change the artifact so it no longer is missing, then run `beacon doctor` again.

```bash
beacon doctor --rule hooks-051
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
