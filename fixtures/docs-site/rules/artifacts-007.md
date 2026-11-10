# Rule artifacts-007

Reports when a build step is empty.

## Details

| Property | Value |
| --- | --- |
| Category | `artifacts` |
| Severity | `warning` |
| Limit | 53 |

## Fix

Change the build step so it no longer is empty, then run `beacon doctor` again.

```bash
beacon doctor --rule artifacts-007
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
