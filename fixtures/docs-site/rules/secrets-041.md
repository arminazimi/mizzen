# Rule secrets-041

Reports when a artifact is larger than the limit.

## Details

| Property | Value |
| --- | --- |
| Category | `secrets` |
| Severity | `info` |
| Limit | 77 |

## Fix

Change the artifact so it no longer is larger than the limit, then run `beacon doctor` again.

```bash
beacon doctor --rule secrets-041
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
