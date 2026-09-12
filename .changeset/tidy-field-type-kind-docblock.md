---
"@adonis-agora/filter-client": patch
---

Correct the `FieldTypeKind` docblock: it referenced an `EntityFieldInfo` type and a `FilterFieldTypeHint` hint on a `@FilterFor` decorator, none of which exist in this repo. The union in fact mirrors core's `FilterFieldKind` member-for-member.
