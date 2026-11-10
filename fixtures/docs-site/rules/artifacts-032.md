# Rule artifacts-032

Reports when a build step is duplicated.

## Details

| Property | Value |
| --- | --- |
| Category | `artifacts` |
| Severity | `info` |
| Limit | 10 |

## Fix

Change the build step so it no longer is duplicated, then run `beacon doctor` again.

```bash
beacon doctor --rule artifacts-032
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
