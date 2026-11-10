# Rule secrets-014

Reports when a manifest is older than expected.

## Details

| Property | Value |
| --- | --- |
| Category | `secrets` |
| Severity | `warning` |
| Limit | 38 |

## Fix

Change the manifest so it no longer is older than expected, then run `beacon doctor` again.

```bash
beacon doctor --rule secrets-014
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
