# Rule build-027

Reports when a token is not readable.

## Details

| Property | Value |
| --- | --- |
| Category | `build` |
| Severity | `info` |
| Limit | 34 |

## Fix

Change the token so it no longer is not readable, then run `beacon doctor` again.

```bash
beacon doctor --rule build-027
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
