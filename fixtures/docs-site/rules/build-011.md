# Rule build-011

Reports when a token is larger than the limit.

## Details

| Property | Value |
| --- | --- |
| Category | `build` |
| Severity | `warning` |
| Limit | 27 |

## Fix

Change the token so it no longer is larger than the limit, then run `beacon doctor` again.

```bash
beacon doctor --rule build-011
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
