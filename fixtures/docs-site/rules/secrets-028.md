# Rule secrets-028

Reports when a release points at nothing.

## Details

| Property | Value |
| --- | --- |
| Category | `secrets` |
| Severity | `warning` |
| Limit | 60 |

## Fix

Change the release so it no longer points at nothing, then run `beacon doctor` again.

```bash
beacon doctor --rule secrets-028
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
