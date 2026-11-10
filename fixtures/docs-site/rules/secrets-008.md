# Rule secrets-008

Reports when a release points at nothing.

## Details

| Property | Value |
| --- | --- |
| Category | `secrets` |
| Severity | `error` |
| Limit | 17 |

## Fix

Change the release so it no longer points at nothing, then run `beacon doctor` again.

```bash
beacon doctor --rule secrets-008
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
