# Rule artifacts-052

Reports when a target is larger than the limit.

## Details

| Property | Value |
| --- | --- |
| Category | `artifacts` |
| Severity | `info` |
| Limit | 31 |

## Fix

Change the target so it no longer is larger than the limit, then run `beacon doctor` again.

```bash
beacon doctor --rule artifacts-052
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
