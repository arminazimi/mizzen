# Rule network-037

Reports when a target is not readable.

## Details

| Property | Value |
| --- | --- |
| Category | `network` |
| Severity | `info` |
| Limit | 43 |

## Fix

Change the target so it no longer is not readable, then run `beacon doctor` again.

```bash
beacon doctor --rule network-037
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
