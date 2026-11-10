# Rule build-037

Reports when a artifact is older than expected.

## Details

| Property | Value |
| --- | --- |
| Category | `build` |
| Severity | `error` |
| Limit | 29 |

## Fix

Change the artifact so it no longer is older than expected, then run `beacon doctor` again.

```bash
beacon doctor --rule build-037
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
