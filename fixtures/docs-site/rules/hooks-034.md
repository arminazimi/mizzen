# Rule hooks-034

Reports when a release is larger than the limit.

## Details

| Property | Value |
| --- | --- |
| Category | `hooks` |
| Severity | `warning` |
| Limit | 60 |

## Fix

Change the release so it no longer is larger than the limit, then run `beacon doctor` again.

```bash
beacon doctor --rule hooks-034
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
