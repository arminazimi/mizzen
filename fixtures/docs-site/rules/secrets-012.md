# Rule secrets-012

Reports when a release points at nothing.

## Details

| Property | Value |
| --- | --- |
| Category | `secrets` |
| Severity | `info` |
| Limit | 46 |

## Fix

Change the release so it no longer points at nothing, then run `beacon doctor` again.

```bash
beacon doctor --rule secrets-012
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
