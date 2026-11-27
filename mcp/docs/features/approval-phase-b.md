---
description: "Storage-backed human approval and one-shot MCP tool resumption."
---

# Approval Phase B

## Overview

`StorageBackedApprovalHandler` lets a tool call return while a reviewer decides whether it may proceed. The caller keeps the original input and a private resume token. A trusted review system records the decision in the approval store.

Phase B requires Core's scoped approval gate and a store that can atomically verify and consume an approval. Phase A uses the inline `ElicitationApprovalHandler` and can run with the package's minimum Core version.

## When to Use Each Phase

| Phase | Decision | Typical use |
| --- | --- | --- |
| Phase A | Inline MCP elicitation | The reviewer is present while the call waits. |
| Phase B | A separate review action | The call returns pending while a reviewer decides. |

## Complete Flow

1. Call a tool that requires approval. The tool returns `isError: true` and `APPROVAL_PENDING`. The result metadata contains the approval record ID and the caller's private resume token.

    ```json
    {
      "_meta": {
        "apcore": {
          "approval": {
            "approvalId": "4f2c29a5-d981-4e46-9ca1-0b17535abd12",
            "resumeToken": "<private-resume-token>"
          }
        }
      }
    }
    ```

2. The reviewer calls the host application's `resolve` operation with `approvalId`. Notify callbacks also receive this record ID.
3. The initiating caller polls `__apcore_approval_check` with `{"approval_id": "4f2c29a5-d981-4e46-9ca1-0b17535abd12"}`. The result reports `pending`, `approved`, or `rejected`.
4. On approval, call the same tool with the original business arguments. Set `params._meta.approvalId` to the private `resumeToken` from the pending response.

    ```json
    {
      "method": "tools/call",
      "params": {
        "name": "notebook.archive",
        "arguments": {"note_id": "n1"},
        "_meta": {"approvalId": "<private-resume-token>"}
      }
    }
    ```

Core checks its access and approval gates on the retry. The handler matches the trusted principal, `caller_id`, target module, and business arguments. It consumes the grant when it authorizes one invocation. A further attempt needs its own approval.

Use the record ID for polling, review notifications, and audit correlation. Restrict the resume token to the pending result and the caller's resumption request.

## ApprovalStore Interface

The host's `ApprovalStore` exposes enrollment, status lookup, and `resolve` by record ID. `resolve` transitions a pending record once and returns whether it recorded a decision.

A scoped store also supports the following operations. Python and Rust use snake case and TypeScript uses camel case.

| Operation | Contract |
| --- | --- |
| `save_scoped_pending` | Persist a pending record with the original invocation scope, deadline, and credential verifier. |
| `get_scoped_result` | Project the status of a live record for the same trusted principal. |
| `consume_scoped` | Verify the live record, scope, and credential verifier together. Consume an approved grant as part of the same atomic operation. |

Store only the verifier for the resume token. Provide an allowlisted status projection for polling. Keep the arguments available to the trusted review workflow only as long as that workflow needs them.

A custom Rust store must return `true` from `supports_scoped_approval()` after implementing all three scoped operations. The builder rejects stores that supply only the unscoped operations.

## InMemoryApprovalStore

The bundled store is process-local. Use it for local development and tests. It expires pending and resolved records and enforces their deadlines when checking or consuming scoped approvals.

## APCoreMCP Integration

Set `approval_store` in Python, `approvalStore` in TypeScript, or `approval_store(...)` on the Rust builder. The server wraps the store in a `StorageBackedApprovalHandler` and exposes the polling meta-tool when that handler owns the Core approval gate. See the [configuration examples](../configuration.md#phase-b-storage-backed-approvals).

Pass a registry to have the adapter set up the approval gate. The effective execution strategy must include Core's built-in approval gate. Python also accepts a Core executor with a wired gate and no existing approval handler. Rust accepts an unshared Core executor with the same gate configuration.

Use Phase B for foreground tools over stdio or Streamable HTTP. Keep the caller authenticated when serving multiple principals. A background invocation that requires this approval returns a refusal and can be retried as a foreground invocation where the tool supports foreground execution.

## `__apcore_approval_check` Meta-Tool Spec

Pass the public `approval_id` as a tool argument. The tool uses the trusted identity from the active MCP connection. A successful poll returns a JSON object in its text content.

```json
{"approval_id":"4f2c29a5-d981-4e46-9ca1-0b17535abd12","status":"pending"}
```

The poll contains the public ID and one of `pending`, `approved`, or `rejected`. A missing or malformed record ID is a tool error. A record unavailable to the current caller reports a rejected status.

## notify_callback Contract

The notify callback receives the public approval record ID, module ID, and business arguments after persistence. Use it to deliver a review request to a trusted queue or application. The reviewer uses the record ID to resolve the decision.

## Production Store Guidance

Use a shared durable store when approvals must survive restarts or reach multiple server instances. Give each record an expiry. Apply `resolve` and `consume_scoped` as conditional atomic updates. For consumption, compare the approved status, deadline, invocation scope, and verifier in the same transaction that marks the grant consumed.

## Cross-SDK Conformance Notes

The stock bridge shares the tool result and request metadata shape across the SDKs. Exercise the public tool endpoint with an ordinary module. Check pending discovery and polling, the approved retry, expiry and scope enforcement, and a concurrent retry in which exactly one invocation runs. Check that the resume token stays out of the status response, audit events, and logs.
