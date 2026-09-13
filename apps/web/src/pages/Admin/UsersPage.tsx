/**
 * Admin → Settings → Users & Allowlist (`/admin/settings/users`).
 *
 * Issue #92, epic #90. This is the former `pages/UserManagementPage.tsx`, moved
 * under the Console's route tree so the hub card, the rail row and the route
 * all address the same path. `/admin/users` still resolves — `App.tsx` keeps it
 * as a real `<Navigate replace>` route so a bookmark lands here rather than
 * falling through the `*` catch-all to `/`.
 *
 * IT KEEPS ITS TWO TABS, unlike `SystemSettingsPage`, whose three became three
 * routes. That is not an inconsistency: Users and Allowlist are two views of
 * the same question — who may use this application — and they are PARALLEL
 * content, which is what a tab strip is for. The three system-settings tabs
 * were hierarchical content wearing a tab strip, which is the mistake epic #90
 * is fixing. Two tabs also sit nowhere near the ~5 where a strip degrades.
 *
 * The nested gate below is unchanged and load-bearing; see its own comment.
 */

import { useState } from 'react';
import { Container, Typography, Box, Tabs, Tab, Paper } from '@mui/material';
import { Navigate } from 'react-router-dom';
import { usePermissions } from '../../hooks/usePermissions';
import { RequirePermission } from '../../components/common/RequirePermission';
import { UserList } from '../../components/admin/UserList';
import { AllowlistTable } from '../../components/admin/AllowlistTable';

interface TabPanelProps {
  children?: React.ReactNode;
  index: number;
  value: number;
}

function TabPanel({ children, value, index }: TabPanelProps) {
  return (
    <div role="tabpanel" hidden={value !== index}>
      {value === index && <Box sx={{ py: 3 }}>{children}</Box>}
    </div>
  );
}

export default function UsersPage() {
  const { hasPermission } = usePermissions();
  const [tabIndex, setTabIndex] = useState(0);

  // Defence for a page mounted from anywhere else. The real gate is the
  // `RequirePermission` around this route in `App.tsx`, carrying the same
  // `users:read` the `Users & Allowlist` card declares and
  // `users.controller.ts` enforces.
  if (!hasPermission('users:read')) {
    return <Navigate to="/" replace />;
  }

  return (
    <Container maxWidth="lg">
      <Box sx={{ py: 4 }}>
        <Typography variant="h4" component="h1" gutterBottom>
          Users &amp; Allowlist
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 2 }}>
          Manage user accounts and roles, and control who may sign in at all.
        </Typography>

        <Paper sx={{ mt: 2 }}>
          <Tabs
            value={tabIndex}
            onChange={(_, newValue) => setTabIndex(newValue)}
            sx={{ borderBottom: 1, borderColor: 'divider' }}
          >
            <Tab label="Users" />
            <Tab label="Allowlist" />
          </Tabs>

          <Box sx={{ p: 3 }}>
            <TabPanel value={tabIndex} index={0}>
              <UserList />
            </TabPanel>

            <TabPanel value={tabIndex} index={1}>
              {/* The DESTINATION and the ROUTE both gate on `users:read` (see
                  `config/destinations.ts` and `config/adminSections.tsx`)
                  because that is what makes this page worth reaching. This TAB
                  gates separately on `allowlist:read`, because its data comes
                  from a different controller (`allowlist.controller.ts`) that
                  enforces exactly that. A destination gate is about
                  reachability; a tab gate is about content — collapsing the two
                  would either hide the whole page from someone entitled to the
                  Users tab, or render a table that can only 403. */}
              <RequirePermission
                permission="allowlist:read"
                fallback={
                  <Typography color="text.secondary">
                    You do not have permission to view the email allowlist.
                  </Typography>
                }
              >
                <AllowlistTable />
              </RequirePermission>
            </TabPanel>
          </Box>
        </Paper>
      </Box>
    </Container>
  );
}
