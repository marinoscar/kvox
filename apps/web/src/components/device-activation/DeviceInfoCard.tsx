/**
 * The review step of `/activate`: what the device says it is, WHAT IT WILL GET,
 * and the Approve / Deny decision.
 *
 * Two things about this component are security-relevant, both from #141:
 *
 *   1. Everything under `deviceInfo.clientInfo` is attacker-chosen —
 *      `POST /auth/device/code` is public and its body is stored verbatim — so
 *      nothing here reads those fields directly. Every value goes through
 *      `sanitizeDeviceText()` first, and the credential kind through
 *      `readCredentialKind()`. See `credential.ts` for the threat model.
 *   2. The card is now explicit about the KIND of credential being granted.
 *      Before #141 there was only one kind; now the requesting device picks,
 *      and the person approving is the one who carries the consequence.
 *
 * LAYOUT NOTE: `/activate` is routed OUTSIDE `Layout` (see `App.tsx` — it is a
 * deliberate full-screen page with no AppBar, rail or bottom nav), so the five
 * coupled `sm` breakpoint gates documented in `common/Layout.tsx` do not apply
 * here and must not be imitated. This page's only responsive behaviour is the
 * card padding in `ActivateDevicePage`; the content below is a single column
 * that reflows on its own, which is why nothing here calls `useMediaQuery`.
 */

import { useState, useEffect } from 'react';
import {
  Box,
  Card,
  CardContent,
  Typography,
  Stack,
  Chip,
  Divider,
  Alert,
  Button,
  CircularProgress,
} from '@mui/material';
import {
  Devices as DevicesIcon,
  Computer as ComputerIcon,
  AccessTime as AccessTimeIcon,
  LocationOn as LocationIcon,
  VpnKey as VpnKeyIcon,
} from '@mui/icons-material';
import type { DeviceActivationInfo } from '../../types';
import { CredentialGrantNotice } from './CredentialGrantNotice';
import {
  DEVICE_NAME_MAX_DISPLAY,
  IP_ADDRESS_MAX_DISPLAY,
  USER_AGENT_MAX_DISPLAY,
  readCredentialKind,
  sanitizeDeviceText,
} from './credential';

interface DeviceInfoCardProps {
  deviceInfo: DeviceActivationInfo;
  onApprove: () => Promise<void>;
  onDeny: () => Promise<void>;
  error: string | null;
}

export function DeviceInfoCard({
  deviceInfo,
  onApprove,
  onDeny,
  error,
}: DeviceInfoCardProps) {
  const [isApproving, setIsApproving] = useState(false);
  const [isDenying, setIsDenying] = useState(false);
  const [timeRemaining, setTimeRemaining] = useState<string>('');

  // The credential this approval actually mints. `clientInfo` may be absent
  // entirely (the API declares it optional) and `tokenType` may be absent (rows
  // predating #141) or an unexpected value (the column is not re-validated on
  // read) — `readCredentialKind` resolves all of those to 'session', matching
  // what the API would in fact issue for such a row.
  const credentialKind = readCredentialKind(deviceInfo.clientInfo);
  const isPat = credentialKind === 'pat';

  // Read once, sanitised, into locals. Sanitising at the point of use rather
  // than once here would make it easy for a future field to be added to the
  // JSX raw — which is exactly the mistake this component is being fixed for.
  const deviceName = sanitizeDeviceText(
    deviceInfo.clientInfo?.deviceName,
    DEVICE_NAME_MAX_DISPLAY,
  );
  const userAgent = sanitizeDeviceText(
    deviceInfo.clientInfo?.userAgent,
    USER_AGENT_MAX_DISPLAY,
  );
  const ipAddress = sanitizeDeviceText(
    deviceInfo.clientInfo?.ipAddress,
    IP_ADDRESS_MAX_DISPLAY,
  );

  // Calculate time remaining until the CODE expires (not the credential's
  // lifetime — see the label below, which has to say so out loud now that a
  // 90-day token can be the thing on offer).
  useEffect(() => {
    const updateTimeRemaining = () => {
      const now = new Date().getTime();
      const expires = new Date(deviceInfo.expiresAt).getTime();
      const diff = expires - now;

      if (diff <= 0) {
        setTimeRemaining('Expired');
        return;
      }

      const minutes = Math.floor(diff / 60000);
      const seconds = Math.floor((diff % 60000) / 1000);

      if (minutes > 0) {
        setTimeRemaining(`${minutes}m ${seconds}s`);
      } else {
        setTimeRemaining(`${seconds}s`);
      }
    };

    updateTimeRemaining();
    const interval = setInterval(updateTimeRemaining, 1000);

    return () => clearInterval(interval);
  }, [deviceInfo.expiresAt]);

  const handleApprove = async () => {
    setIsApproving(true);
    try {
      await onApprove();
    } finally {
      setIsApproving(false);
    }
  };

  const handleDeny = async () => {
    setIsDenying(true);
    try {
      await onDeny();
    } finally {
      setIsDenying(false);
    }
  };

  const isExpired = timeRemaining === 'Expired';

  return (
    <Box>
      <CredentialGrantNotice kind={credentialKind} />

      <Card
        variant="outlined"
        sx={{
          mb: 3,
          // The PAT case gets a warning-coloured border so the banner and the
          // details it describes read as ONE block. Without it the alert floats
          // above an identical-looking card and a skimming eye can take the
          // card as the "real" content and the banner as page furniture.
          ...(isPat && {
            borderColor: 'warning.main',
            borderWidth: 2,
          }),
        }}
      >
        <CardContent>
          <Stack spacing={2.5}>
            {/* WHAT IS GRANTED — first, above the device's own self-description.
                Ordering is the point: the attacker controls every field below
                this row and none of this one, so the fact the user cannot
                influence comes before the story the device tells about itself. */}
            <Box sx={{ display: 'flex', alignItems: 'flex-start' }}>
              <VpnKeyIcon
                sx={{
                  mr: 1.5,
                  mt: 0.5,
                  color: isPat ? 'warning.main' : 'text.secondary',
                }}
              />
              <Box>
                <Typography variant="caption" color="text.secondary">
                  Grants
                </Typography>
                <Box sx={{ mt: 0.5 }}>
                  <Chip
                    label={
                      isPat
                        ? 'Long-lived access token'
                        : 'Standard sign-in session'
                    }
                    size="small"
                    color={isPat ? 'warning' : 'default'}
                    variant={isPat ? 'filled' : 'outlined'}
                  />
                </Box>
              </Box>
            </Box>

            {/* Device Name */}
            {deviceName && (
              <Box sx={{ display: 'flex', alignItems: 'flex-start' }}>
                <DevicesIcon sx={{ mr: 1.5, mt: 0.5, color: 'text.secondary' }} />
                <Box sx={{ minWidth: 0 }}>
                  <Typography variant="caption" color="text.secondary">
                    Device Name
                  </Typography>
                  {/* `wordBreak` matters even with the length bound: 64
                      unbroken characters still overflow a narrow phone and
                      would push the Deny button off-screen. */}
                  <Typography
                    variant="body1"
                    sx={{ fontWeight: 'medium', wordBreak: 'break-word' }}
                  >
                    {deviceName}
                  </Typography>
                </Box>
              </Box>
            )}

            {/* User Agent / Browser */}
            {userAgent && (
              <Box sx={{ display: 'flex', alignItems: 'flex-start' }}>
                <ComputerIcon sx={{ mr: 1.5, mt: 0.5, color: 'text.secondary' }} />
                <Box sx={{ minWidth: 0 }}>
                  <Typography variant="caption" color="text.secondary">
                    Browser / Device
                  </Typography>
                  <Typography variant="body2" sx={{ wordBreak: 'break-word' }}>
                    {userAgent}
                  </Typography>
                </Box>
              </Box>
            )}

            {/* IP Address */}
            {ipAddress && (
              <Box sx={{ display: 'flex', alignItems: 'flex-start' }}>
                <LocationIcon sx={{ mr: 1.5, mt: 0.5, color: 'text.secondary' }} />
                <Box sx={{ minWidth: 0 }}>
                  <Typography variant="caption" color="text.secondary">
                    IP Address
                  </Typography>
                  <Typography variant="body2" sx={{ wordBreak: 'break-word' }}>
                    {ipAddress}
                  </Typography>
                </Box>
              </Box>
            )}

            <Divider />

            {/* Expiration Time */}
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <Box sx={{ display: 'flex', alignItems: 'center' }}>
                <AccessTimeIcon sx={{ mr: 1.5, color: 'text.secondary' }} />
                {/* "Code expires in", not the old bare "Time remaining": next
                    to a banner promising ~90 days, an unqualified countdown
                    reading "12m 04s" invites the reading that the CREDENTIAL
                    expires in twelve minutes. This clock is only the window in
                    which the code can still be approved. */}
                <Typography variant="body2" color="text.secondary">
                  Code expires in
                </Typography>
              </Box>
              <Chip
                label={timeRemaining}
                size="small"
                color={isExpired ? 'error' : 'primary'}
                variant="outlined"
              />
            </Box>
          </Stack>
        </CardContent>
      </Card>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {/* Action Buttons */}
      <Stack direction="row" spacing={2}>
        <Button
          fullWidth
          variant="outlined"
          color="error"
          size="large"
          onClick={handleDeny}
          disabled={isApproving || isDenying || isExpired}
          startIcon={isDenying ? <CircularProgress size={20} /> : undefined}
        >
          {isDenying ? 'Denying...' : 'Deny'}
        </Button>
        <Button
          fullWidth
          variant="contained"
          color="success"
          size="large"
          onClick={handleApprove}
          disabled={isDenying || isApproving || isExpired}
          startIcon={isApproving ? <CircularProgress size={20} /> : undefined}
        >
          {/* The PAT label names what the click does. "Approve" alone is the
              same word for both cases, and the button is the last thing read
              before the decision — the one place a difference costs nothing to
              state. */}
          {isApproving
            ? 'Approving...'
            : isPat
              ? 'Approve token'
              : 'Approve'}
        </Button>
      </Stack>

      {isExpired && (
        <Alert severity="error" sx={{ mt: 2 }}>
          This code has expired. Please request a new one from your device.
        </Alert>
      )}
    </Box>
  );
}
