# Multi-family isolation contract

## Invariants

1. Existing families are never merged or migrated automatically.
2. A user may have multiple memberships:
   - own family A
   - member in invited family B
3. Every protected business request has an explicit family context.
4. Session active family is only a selector; membership is the authorization source.
5. Switching family never copies cache, drafts, uploads, reminders or exports.

## Migration rules

- Existing family_members rows are preserved.
- Existing medicine, batch, photo, reminder and plan rows keep their family_id.
- Upgrade failure must rollback without partial membership changes.

## Negative cases

- Access family without membership: deny.
- Invite reuse: reject atomically.
- Expired invite: reject.
- Switching family with stale async response: discard.
- Upload receipt from old family: reject.

## Owner gates

Real WeChat accounts, private photos, signed packages and production domains remain external acceptance gates.
