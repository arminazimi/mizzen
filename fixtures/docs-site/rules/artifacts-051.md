# Rule artifacts-051

Reports when a hook is older than expected.

## Details

| Property | Value |
| --- | --- |
| Category | `artifacts` |
| Severity | `info` |
| Limit | 95 |

## Fix

Change the hook so it no longer is older than expected, then run `beacon doctor` again.

```bash
beacon doctor --rule artifacts-051
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
