# Rule secrets-053

Reports when a release is duplicated.

## Details

| Property | Value |
| --- | --- |
| Category | `secrets` |
| Severity | `info` |
| Limit | 97 |

## Fix

Change the release so it no longer is duplicated, then run `beacon doctor` again.

```bash
beacon doctor --rule secrets-053
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
