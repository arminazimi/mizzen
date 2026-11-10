# Rule secrets-049

Reports when a artifact is older than expected.

## Details

| Property | Value |
| --- | --- |
| Category | `secrets` |
| Severity | `error` |
| Limit | 54 |

## Fix

Change the artifact so it no longer is older than expected, then run `beacon doctor` again.

```bash
beacon doctor --rule secrets-049
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
