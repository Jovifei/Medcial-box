# Multi-family isolation stage

## Invariants

- A user may belong to multiple families.
- A user has exactly one explicit active family context per client session context.
- Joining another family never migrates or merges inventory.
- Existing family ownership remains unchanged.
- Medicines, batches, photos, drafts, plans and reminders remain owned by their original family_id.

## Required negative cases

- Switching family while a previous request is in flight must not apply stale data.
- Accepting an already consumed invite must not create membership.
- Expired invite must not create membership.
- A member from family A must not read family B resources.
- Leaving family A must not remove family B membership.

## Owner-only gates

Real WeChat accounts, private photos, production storage and signed packages remain external acceptance gates.
