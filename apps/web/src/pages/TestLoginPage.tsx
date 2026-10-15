import {
  Box,
  Card,
  CardContent,
  Typography,
  TextField,
  Button,
  Alert,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  useTheme,
} from '@mui/material';

/**
 * Development-only test login (`/testing/login`), over the PLATFORM's test-login
 * endpoint (issue #465, epic #462).
 *
 * This app's own `test-auth` module is gone; `POST /api/auth/test/login` is served
 * by the identity slice (`IdentityModule.forRoot({ enableTestAuth })`, mounted
 * outside production only). The contract this page relies on:
 *
 *   - a plain HTML form POST (`email`, `role`, optional `displayName`), NOT a
 *     `fetch`: the endpoint answers 302 to `/auth/callback?token=...` and sets
 *     the HttpOnly refresh cookie, which only a top-level navigation completes.
 *     The action is the same-origin path for the same reason: the cookie is
 *     scoped to `/api/auth` on the app's own origin.
 *   - `role` is any role the application registered; the three below are
 *     This app's. `viewer` and `contributor` are ORGANIZATION roles on the user's
 *     membership now, and `admin` also receives `org_admin`, so each role holds
 *     the permissions it holds in a real deployment.
 *   - a policy refusal lands on `/auth/callback?error=<code>`, the page every
 *     real sign-in error lands on.
 *
 * The `data-testid`s are the contract of `tests/e2e/helpers/auth.helper.ts`.
 */
export default function TestLoginPage() {
  const theme = useTheme();

  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.palette.background.default,
        p: 2,
      }}
    >
      <Card
        sx={{
          maxWidth: 400,
          width: '100%',
          boxShadow: theme.shadows[10],
        }}
      >
        <CardContent sx={{ p: 4 }}>
          {/* Warning Banner */}
          <Alert severity="warning" sx={{ mb: 3 }}>
            Test Login - Development Only
          </Alert>

          {/* Header */}
          <Box sx={{ textAlign: 'center', mb: 3 }}>
            <Typography variant="h5" component="h1" sx={{ fontWeight: 'bold' }}>
              Test Authentication
            </Typography>
            <Typography color="text.secondary" sx={{ mt: 1 }}>
              Bypass OAuth for testing
            </Typography>
          </Box>

          {/* Form */}
          <form method="POST" action="/api/auth/test/login">
            <TextField
              name="email"
              label="Email"
              type="email"
              required
              fullWidth
              margin="normal"
              slotProps={{ htmlInput: { 'data-testid': 'test-email-input' } }}
            />

            <FormControl fullWidth margin="normal">
              <InputLabel>Role</InputLabel>
              <Select
                name="role"
                defaultValue="viewer"
                label="Role"
                data-testid="test-role-select"
              >
                <MenuItem value="admin">Admin</MenuItem>
                <MenuItem value="contributor">Contributor</MenuItem>
                <MenuItem value="viewer">Viewer</MenuItem>
              </Select>
            </FormControl>

            <TextField
              name="displayName"
              label="Display Name (optional)"
              fullWidth
              margin="normal"
            />

            <Button
              type="submit"
              variant="contained"
              fullWidth
              sx={{ mt: 3 }}
              data-testid="test-login-button"
            >
              Login as Test User
            </Button>
          </form>
        </CardContent>
      </Card>
    </Box>
  );
}
