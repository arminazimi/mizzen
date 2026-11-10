# Rule artifacts-033

Reports when a artifact is duplicated.

## Details

| Property | Value |
| --- | --- |
| Category | `artifacts` |
| Severity | `error` |
| Limit | 69 |

## Fix

Change the artifact so it no longer is duplicated, then run `beacon doctor` again.

```bash
beacon doctor --rule artifacts-033
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
