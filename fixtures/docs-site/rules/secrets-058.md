# Rule secrets-058

Reports when a release is larger than the limit.

## Details

| Property | Value |
| --- | --- |
| Category | `secrets` |
| Severity | `warning` |
| Limit | 12 |

## Fix

Change the release so it no longer is larger than the limit, then run `beacon doctor` again.

```bash
beacon doctor --rule secrets-058
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
