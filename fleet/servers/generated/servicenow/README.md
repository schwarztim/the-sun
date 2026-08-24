# servicenow-mcp

thesun-generated Go MCP server (transport: **streamable-HTTP only** — never stdio/SSE).

## Tools

- `servicenow_list_incident` — GET /api/now/table/incident
- `servicenow_get_incident` — GET /api/now/table/incident/{sysId}
- `servicenow_list_change_request` — GET /api/now/table/change_request
- `servicenow_get_change_request` — GET /api/now/table/change_request/{sysId}
- `servicenow_list_change_task` — GET /api/now/table/change_task
- `servicenow_list_problem` — GET /api/now/table/problem
- `servicenow_get_problem` — GET /api/now/table/problem/{sysId}
- `servicenow_list_request` — GET /api/now/table/sc_request
- `servicenow_list_requested_item` — GET /api/now/table/sc_req_item
- `servicenow_list_knowledge` — GET /api/now/table/kb_knowledge
- `servicenow_get_knowledge` — GET /api/now/table/kb_knowledge/{sysId}
- `servicenow_list_sys_user` — GET /api/now/table/sys_user
- `servicenow_get_sys_user` — GET /api/now/table/sys_user/{sysId}
- `servicenow_list_group` — GET /api/now/table/sys_user_group
- `servicenow_query_table` — GET /api/now/table/{table}
- `servicenow_get_record` — GET /api/now/table/{table}/{sysId}
- `servicenow_create_incident` — POST /api/now/table/incident
- `servicenow_update_incident` — PATCH /api/now/table/incident/{sysId}
- `servicenow_create_change_request` — POST /api/now/table/change_request
- `servicenow_create_problem` — POST /api/now/table/problem
- `servicenow_create_record` — POST /api/now/table/{table}
- `servicenow_update_record` — PATCH /api/now/table/{table}/{sysId}
- `servicenow_delete_record` — DELETE /api/now/table/{table}/{sysId}
- `servicenow_list_catalog_item` — GET /api/now/table/sc_cat_item
- `servicenow_get_catalog_item` — GET /api/now/table/sc_cat_item/{sysId}
- `servicenow_list_catalog_category` — GET /api/now/table/sc_category
- `servicenow_list_catalog_item_variable` — GET /api/now/table/item_option_new
- `servicenow_list_cmdb_ci` — GET /api/now/table/cmdb_ci
- `servicenow_list_cmdb_relationship` — GET /api/now/table/cmdb_rel_ci
- `servicenow_list_cmdb_instance` — GET /api/now/cmdb/instance/{className}
- `servicenow_list_cmdb_class` — GET /api/now/table/cmdb_class_info
- `servicenow_list_group_member` — GET /api/now/table/sys_user_grmember
- `servicenow_list_user_role` — GET /api/now/table/sys_user_has_role
- `servicenow_list_role` — GET /api/now/table/sys_user_role
- `servicenow_list_acl` — GET /api/now/table/sys_security_acl
- `servicenow_list_approval` — GET /api/now/table/sysapproval_approver
- `servicenow_list_task` — GET /api/now/table/task
- `servicenow_list_sla` — GET /api/now/table/contract_sla
- `servicenow_list_task_sla` — GET /api/now/table/task_sla
- `servicenow_list_workflow` — GET /api/now/table/wf_workflow
- `servicenow_list_workflow_context` — GET /api/now/table/wf_context
- `servicenow_list_email` — GET /api/now/table/sys_email
- `servicenow_list_notification` — GET /api/now/table/sysevent_email_action
- `servicenow_list_event` — GET /api/now/table/sysevent
- `servicenow_create_event` — POST /api/now/table/sysevent
- `servicenow_list_journal` — GET /api/now/table/sys_journal_field
- `servicenow_list_audit` — GET /api/now/table/sys_audit
- `servicenow_list_scheduled_job` — GET /api/now/table/sysauto_script
- `servicenow_list_update_set` — GET /api/now/table/sys_update_set
- `servicenow_list_asset` — GET /api/now/table/alm_asset
- `servicenow_get_asset` — GET /api/now/table/alm_asset/{sysId}
- `servicenow_list_license` — GET /api/now/table/alm_license
- `servicenow_list_license_entitlement` — GET /api/now/table/alm_entitlement
- `servicenow_list_software` — GET /api/now/table/cmdb_sam_sw_install
- `servicenow_list_contract` — GET /api/now/table/ast_contract
- `servicenow_list_location` — GET /api/now/table/cmn_location
- `servicenow_list_department` — GET /api/now/table/cmn_department
- `servicenow_list_cost_center` — GET /api/now/table/cmn_cost_center
- `servicenow_list_discovery_status` — GET /api/now/table/discovery_status
- `servicenow_list_discovery_schedule` — GET /api/now/table/discovery_schedule
- `servicenow_table_schema` — GET /api/now/table/sys_dictionary
- `servicenow_list_choice` — GET /api/now/table/sys_choice
- `servicenow_list_attachment` — GET /api/now/attachment
- `servicenow_get_attachment` — GET /api/now/attachment/{sysId}
- `servicenow_download_attachment` — GET /api/now/attachment/{sysId}/file
- `servicenow_delete_attachment` — DELETE /api/now/attachment/{sysId}
- `servicenow_aggregate` — GET /api/now/stats/{table}
- `servicenow_import_set_load` — POST /api/now/import/{table}
- `servicenow_batch_request` — POST /api/now/v1/batch

## Run locally

```bash
go build -o servicenow-mcp .
HERMES_URL=http://127.0.0.1:9876 HERMES_CLIENT_TOKEN=$(cat ~/.hermes/client.token) \
  MCP_HOST=127.0.0.1 MCP_PORT=42018 ./servicenow-mcp
# MCP endpoint: POST http://127.0.0.1:42018/mcp   (health: GET /healthz)
```

MCP_PORT is required and has no default.

## Configuration & credential onboarding (easy default + advanced fallback)

**Default (easy):** a plain HTTP Basic username/password, or an OAuth2
client-credentials application — works against any stock, non-SSO ServiceNow
instance. Set ONE of:

```bash
export SERVICENOW_INSTANCE_URL=https://your-instance.service-now.com   # REQUIRED: your instance
export SERVICENOW_BASIC_AUTH="user:pass"        # or SERVICENOW_USERNAME + SERVICENOW_PASSWORD
# — or —
export SERVICENOW_CLIENT_ID=...
export SERVICENOW_CLIENT_SECRET=...
# export SERVICENOW_TOKEN_URL=...   # optional override of {instance}/oauth_token.do
```

Values may be enrolled in the Hermes vault and referenced as
`hermescred://servicenow/<account>` in the fleetd manifest — fleetd resolves the
reference to plaintext before spawning this process, so no secret value ever
appears in the manifest file itself.

**Advanced fallback (corporate SSO):** when NEITHER generic env var above is
set, this server falls back unchanged to the Hermes-managed SSO session cookie:

```bash
hermes acquire servicenow
export HERMES_URL=http://127.0.0.1:9876
export HERMES_CLIENT_TOKEN=$(cat ~/.hermes/client.token)
```

At request time it fetches the current session from
`GET {HERMES_URL}/token/servicenow/session`. The bundle's `accessToken` carries
the raw `Cookie` header string; `extra.g_ck` carries the CSRF token, sent as
`X-UserToken` on state-changing requests. No credential of either mode is ever
logged or surfaced in tool output.
