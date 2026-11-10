# Rule build-046

Reports when a target is larger than the limit.

## Details

| Property | Value |
| --- | --- |
| Category | `build` |
| Severity | `info` |
| Limit | 43 |

## Fix

Change the target so it no longer is larger than the limit, then run `beacon doctor` again.

```bash
beacon doctor --rule build-046
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
