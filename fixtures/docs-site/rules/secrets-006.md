# Rule secrets-006

Reports when a manifest is older than expected.

## Details

| Property | Value |
| --- | --- |
| Category | `secrets` |
| Severity | `error` |
| Limit | 84 |

## Fix

Change the manifest so it no longer is older than expected, then run `beacon doctor` again.

```bash
beacon doctor --rule secrets-006
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
