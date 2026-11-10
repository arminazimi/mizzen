# Rule hooks-027

Reports when a token is older than expected.

## Details

| Property | Value |
| --- | --- |
| Category | `hooks` |
| Severity | `info` |
| Limit | 65 |

## Fix

Change the token so it no longer is older than expected, then run `beacon doctor` again.

```bash
beacon doctor --rule hooks-027
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
