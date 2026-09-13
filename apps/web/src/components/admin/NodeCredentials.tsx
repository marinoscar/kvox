/**
 * Admin → Worker Nodes → Node Credentials (issue #271, epic #254).
 *
 * =============================================================================
 * WHY THIS IS A SECTION AND NOT ITS OWN REGISTRY CARD
 * =============================================================================
 *
 * CLAUDE.md's Settings UI Pattern draws one line and this component sits on the
 * right side of it: a DESTINATION gate is about REACHABILITY, a gate inside a
 * page is about CONTENT. Credentials are content of the Worker Nodes page.
 * They are gated by the same permissions (`nodes:read` to see them,
 * `nodes:write` to change them, the strings `nodes-admin.controller.ts` and
 * `node-credential.controller.ts` actually enforce), they describe the same
 * machines, and — the part that decides it — they are what an operator reaches
 * for in the same minute as the fleet table.
 *
 * The rejected alternative was a second registry card, `/admin/settings/nodes/
 * credentials`. It would have been tidy, it satisfies the letter of the
 * registry rule, and it puts TWO CLICKS between "this worker is compromised"
 * and revoking its token: read the fleet, notice the bad node, go back to the
 * hub, find the credentials card, open it, find the credential. Revocation is
 * an incident-response action; the whole point of it is that it is immediate,
 * and a card is a page away by construction. `UsersPage`'s Allowlist half is
 * the precedent — a second controller's data, gated on its own permission,
 * living inside one destination because it answers one question with the other
 * half.
 *
 * The other rejected alternative was reusing `/settings/tokens`
 * (`PersonalAccessTokens`). Three reasons it is not the same surface:
 * a different permission (`nodes:read` versus a bare authenticated user), a
 * different audience (every user has personal access tokens; node credentials
 * are fleet inventory an administrator audits), and a different THING — a
 * `nod_` credential is confined by the auth guard to `/api/nodes/*` and cannot
 * mint another credential, while a `pat_` token is the user's whole identity.
 * Listing them together would invite revoking the wrong one.
 *
 * =============================================================================
 * WHY THIS COMPONENT OWNS NO FETCHING
 * =============================================================================
 *
 * Unlike `PersonalAccessTokens`, which calls its own hook, everything here
 * arrives as props. The page holds ONE `useNodeActions`, so the fleet's delete
 * and the credentials' create/revoke share one in-flight flag and one error
 * banner — which is the honest reading of "these all mutate the same fleet and
 * the page re-reads it after any of them". A second error surface inside this
 * card would let a failed revoke be reported in one place while a failed node
 * delete is reported in another, on a page where the two are steps of the same
 * incident.
 */

import { useMemo, useState } from 'react';
import { Alert, Box, Button, Card, CardContent, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import BlockIcon from '@mui/icons-material/Block';
import { DataTable } from '../datatable';
import type { DataTableRowAction } from '../datatable';
import {
  NODE_CREDENTIALS_TABLE_ID,
  buildNodeCredentialColumns,
} from '../../pages/Admin/workersTable';
import { nodeCredentialStatus } from '../../services/nodes';
import type {
  CreateNodeCredentialInput,
  NodeCredential,
  NodeCredentialCreated,
} from '../../services/nodes';
import { CreateNodeCredentialDialog } from './CreateNodeCredentialDialog';
import { NodeCredentialRevealDialog } from './NodeCredentialRevealDialog';

export interface NodeCredentialsProps {
  credentials: NodeCredential[];
  isLoading: boolean;
  /** `nodes:write`. Gates the create button and the revoke action. */
  canWrite: boolean;
  /** True while any of the page's writes is in flight. */
  isWorking: boolean;
  onCreate: (input: CreateNodeCredentialInput) => Promise<NodeCredentialCreated | null>;
  onRevoke: (id: string) => Promise<boolean>;
  /**
   * The instant expiry is judged against — the page's single render clock, so
   * the status chip and the row action's `disabled` predicate cannot disagree
   * about a credential that expires mid-render.
   */
  now: Date;
}

export function NodeCredentials({
  credentials,
  isLoading,
  canWrite,
  isWorking,
  onCreate,
  onRevoke,
  now,
}: NodeCredentialsProps) {
  const [createOpen, setCreateOpen] = useState(false);
  /**
   * The created credential, INCLUDING ITS RAW TOKEN, held for exactly as long
   * as the reveal dialog is open and cleared when it closes.
   *
   * This is the shortest lifetime that works, and it is the reason
   * `useNodeActions` hands the response back instead of storing it: a secret
   * that cannot be re-fetched should not outlive the one component that
   * displays it.
   */
  const [revealed, setRevealed] = useState<NodeCredentialCreated | null>(null);

  const columns = useMemo(() => buildNodeCredentialColumns(now), [now]);

  const rowActions = useMemo(() => {
    // The ARRAY is gated, never a rendered-then-hidden control: a reader
    // without `nodes:write` gets an array that does not CONTAIN this action, so
    // it is absent from the desktop grid, the tablet row expander and the phone
    // card at once.
    if (!canWrite) return [] as DataTableRowAction<NodeCredential>[];

    return [
      {
        id: 'revoke',
        label: 'Revoke credential',
        icon: <BlockIcon fontSize="small" />,
        destructive: true,
        // DISABLED, NOT ABSENT, for a credential that is already revoked or
        // expired — the rule `UserList` states: the set of actions must not
        // change shape row to row, or the operator has to hunt for a control
        // that moved. The API answers 404 for an already-revoked credential
        // rather than succeeding silently, so this mirrors a real refusal
        // rather than inventing a policy.
        disabled: (credential) => nodeCredentialStatus(credential, now) !== 'active' || isWorking,
        confirm: {
          title: 'Revoke this credential?',
          description: (credential) =>
            `"${credential.name}" stops working on the node's very next request — there is no ` +
            'cache and no delay. Any worker using it will fail to authenticate until it is ' +
            'given a new credential. This cannot be undone.',
          confirmLabel: 'Revoke',
        },
        onClick: (credential) => {
          void onRevoke(credential.id);
        },
      },
    ] satisfies DataTableRowAction<NodeCredential>[];
  }, [canWrite, isWorking, now, onRevoke]);

  return (
    <>
      <Card sx={{ mt: 3 }}>
        <CardContent>
          <Box
            sx={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'flex-start',
              gap: 2,
              mb: 1,
            }}
          >
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="h6" component="h2" gutterBottom>
                Node Credentials
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                The <code>nod_</code> tokens that let a machine attach to this deployment. They
                are shown once at creation and stored only as a hash, so revoking is the way to
                cut one off. Revoked credentials stay listed as part of the audit trail.
              </Typography>
            </Box>
            {canWrite && (
              <Button
                variant="outlined"
                size="small"
                startIcon={<AddIcon />}
                onClick={() => setCreateOpen(true)}
                sx={{ flexShrink: 0 }}
              >
                New credential
              </Button>
            )}
          </Box>

          {/* Deleting a node does NOT revoke its credential — the API says so
              explicitly, and it is the single most likely wrong assumption an
              operator makes on this page. Stated where both controls are
              visible rather than only inside the delete confirmation, which is
              read once and then dismissed. */}
          <Alert severity="info" sx={{ mb: 2 }}>
            Deleting a node does not revoke its credential: the same token can register a new
            node. Revoke it here too when a machine is gone for good.
          </Alert>

          <DataTable<NodeCredential>
            tableId={NODE_CREDENTIALS_TABLE_ID}
            data-testid="admin-node-credentials-table"
            ariaLabel="Node credentials"
            density="compact"
            columns={columns}
            rows={credentials}
            rowId={(credential) => credential.id}
            loading={isLoading}
            emptyState={
              <Typography variant="body2" color="text.secondary">
                No node credentials yet. Create one to attach a worker to this deployment.
              </Typography>
            }
            rowActions={rowActions}
            csvExport={{ filename: 'node-credentials' }}
          />
        </CardContent>
      </Card>

      <CreateNodeCredentialDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreate={onCreate}
        onCreated={setRevealed}
      />

      <NodeCredentialRevealDialog
        open={revealed !== null}
        credential={revealed}
        onClose={() => setRevealed(null)}
      />
    </>
  );
}
