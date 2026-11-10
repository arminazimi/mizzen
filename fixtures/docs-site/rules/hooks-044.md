# Rule hooks-044

Reports when a release is older than expected.

## Details

| Property | Value |
| --- | --- |
| Category | `hooks` |
| Severity | `warning` |
| Limit | 64 |

## Fix

Change the release so it no longer is older than expected, then run `beacon doctor` again.

```bash
beacon doctor --rule hooks-044
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
