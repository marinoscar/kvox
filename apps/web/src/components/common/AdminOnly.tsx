import { ReactNode } from 'react';
import { usePermissions } from '@marinoscar/platform-web/identity/headless';

interface AdminOnlyProps {
  children: ReactNode;
  fallback?: ReactNode;
}

export function AdminOnly({ children, fallback = null }: AdminOnlyProps) {
  const { isAdmin } = usePermissions();

  if (!isAdmin) {
    return <>{fallback}</>;
  }

  return <>{children}</>;
}
