# Rule network-016

Reports when a target is larger than the limit.

## Details

| Property | Value |
| --- | --- |
| Category | `network` |
| Severity | `error` |
| Limit | 69 |

## Fix

Change the target so it no longer is larger than the limit, then run `beacon doctor` again.

```bash
beacon doctor --rule network-016
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
