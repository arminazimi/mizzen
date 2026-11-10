# Rule cache-009

Reports when a token is duplicated.

## Details

| Property | Value |
| --- | --- |
| Category | `cache` |
| Severity | `error` |
| Limit | 47 |

## Fix

Change the token so it no longer is duplicated, then run `beacon doctor` again.

```bash
beacon doctor --rule cache-009
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
