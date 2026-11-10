# Rule secrets-029

Reports when a manifest is duplicated.

## Details

| Property | Value |
| --- | --- |
| Category | `secrets` |
| Severity | `info` |
| Limit | 92 |

## Fix

Change the manifest so it no longer is duplicated, then run `beacon doctor` again.

```bash
beacon doctor --rule secrets-029
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
