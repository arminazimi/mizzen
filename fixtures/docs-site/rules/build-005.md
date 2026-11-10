# Rule build-005

Reports when a release is not readable.

## Details

| Property | Value |
| --- | --- |
| Category | `build` |
| Severity | `info` |
| Limit | 93 |

## Fix

Change the release so it no longer is not readable, then run `beacon doctor` again.

```bash
beacon doctor --rule build-005
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
