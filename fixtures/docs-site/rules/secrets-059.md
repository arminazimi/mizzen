# Rule secrets-059

Reports when a release is larger than the limit.

## Details

| Property | Value |
| --- | --- |
| Category | `secrets` |
| Severity | `info` |
| Limit | 24 |

## Fix

Change the release so it no longer is larger than the limit, then run `beacon doctor` again.

```bash
beacon doctor --rule secrets-059
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
