# Rule secrets-051

Reports when a release is larger than the limit.

## Details

| Property | Value |
| --- | --- |
| Category | `secrets` |
| Severity | `error` |
| Limit | 71 |

## Fix

Change the release so it no longer is larger than the limit, then run `beacon doctor` again.

```bash
beacon doctor --rule secrets-051
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
