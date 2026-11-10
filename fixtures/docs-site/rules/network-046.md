# Rule network-046

Reports when a artifact is duplicated.

## Details

| Property | Value |
| --- | --- |
| Category | `network` |
| Severity | `info` |
| Limit | 4 |

## Fix

Change the artifact so it no longer is duplicated, then run `beacon doctor` again.

```bash
beacon doctor --rule network-046
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
