# Metadata Update Behavior

This document describes how metadata works on batch objects, following **Stripe's metadata semantics**.

## Overview

Metadata allows you to attach custom key-value pairs to batches for your own tracking purposes (e.g., `order_id`, `campaign_name`, `environment`).

## Constraints

| Constraint | Limit |
|------------|-------|
| Maximum keys | 50 |
| Key length | 40 characters |
| Value length | 500 characters |
| Allowed characters in keys | Any except `[` and `]` |

- All values are stored as **strings**
- Numbers and booleans are automatically converted to strings
- Nested objects and arrays are **not allowed**

## Setting Metadata on Create

When creating a batch via `POST /batches`, you can include initial metadata:

```json
{
  "items": [...],
  "metadata": {
    "order_id": "12345",
    "environment": "production"
  }
}
```

## Updating Metadata

When updating a batch via `PATCH /batches/:batchId`, metadata follows **merge semantics**:

### Adding New Keys

New keys are added to existing metadata without affecting other keys.

```json
// Existing: { "order_id": "12345" }
// Request:
{ "metadata": { "campaign": "summer_sale" } }
// Result: { "order_id": "12345", "campaign": "summer_sale" }
```

### Updating Existing Keys

Providing a key that already exists overwrites its value.

```json
// Existing: { "order_id": "12345", "env": "staging" }
// Request:
{ "metadata": { "env": "production" } }
// Result: { "order_id": "12345", "env": "production" }
```

### Deleting a Specific Key

Set a key's value to `""` (empty string) or `null` to delete it.

```json
// Existing: { "order_id": "12345", "temp_flag": "true" }
// Request:
{ "metadata": { "temp_flag": "" } }
// Result: { "order_id": "12345" }
```

Both of these are equivalent:
```json
{ "metadata": { "key_to_delete": "" } }
{ "metadata": { "key_to_delete": null } }
```

### Clearing All Metadata

Set the entire `metadata` field to `""` or `null` to delete all metadata.

```json
// Existing: { "order_id": "12345", "campaign": "summer_sale" }
// Request:
{ "metadata": "" }
// Result: {}
```

Or equivalently:
```json
{ "metadata": null }
```

### No Changes

Sending an empty object `{}` makes no changes to existing metadata.

```json
// Existing: { "order_id": "12345" }
// Request:
{ "metadata": {} }
// Result: { "order_id": "12345" }  (unchanged)
```

## Summary Table

| Input | Behavior |
|-------|----------|
| `{ "metadata": { "new_key": "value" } }` | Add/update key |
| `{ "metadata": { "key": "" } }` | Delete specific key |
| `{ "metadata": { "key": null } }` | Delete specific key |
| `{ "metadata": "" }` | Clear all metadata |
| `{ "metadata": null }` | Clear all metadata |
| `{ "metadata": {} }` | No changes |
| (field omitted) | No changes (but returns error on PATCH since nothing to update) |

## Response Format

Metadata is always returned as an object (never `null` or `undefined`):

```json
{
  "id": "batch_abc123",
  "object": "batch",
  "status": "completed",
  "metadata": {
    "order_id": "12345",
    "campaign": "summer_sale"
  }
}
```

If no metadata is set, an empty object is returned:

```json
{
  "id": "batch_abc123",
  "metadata": {}
}
```

## Error Cases

| Error | Cause |
|-------|-------|
| `Metadata can have a maximum of 50 keys` | Too many keys after merge |
| `Metadata key "..." exceeds 40 character limit` | Key too long |
| `Metadata value for key "..." exceeds 500 character limit` | Value too long |
| `Metadata key "..." cannot contain square brackets` | Key contains `[` or `]` |
| `Metadata value must be a string` | Value is array or object |


