# Rule build-043

Reports when a release is older than expected.

## Details

| Property | Value |
| --- | --- |
| Category | `build` |
| Severity | `error` |
| Limit | 56 |

## Fix

Change the release so it no longer is older than expected, then run `beacon doctor` again.

```bash
beacon doctor --rule build-043
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
