# Rule build-045

Reports when a release is not readable.

## Details

| Property | Value |
| --- | --- |
| Category | `build` |
| Severity | `warning` |
| Limit | 75 |

## Fix

Change the release so it no longer is not readable, then run `beacon doctor` again.

```bash
beacon doctor --rule build-045
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
