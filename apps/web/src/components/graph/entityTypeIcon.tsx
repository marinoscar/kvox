import BusinessOutlinedIcon from '@mui/icons-material/BusinessOutlined';
import EventOutlinedIcon from '@mui/icons-material/EventOutlined';
import FolderOutlinedIcon from '@mui/icons-material/FolderOutlined';
import HubOutlinedIcon from '@mui/icons-material/HubOutlined';
import PersonOutlinedIcon from '@mui/icons-material/PersonOutlined';
import type { SvgIconProps } from '@mui/material/SvgIcon';

/**
 * One icon per shipped entity type, and a neutral graph glyph for anything
 * else — a type added to the ontology renders with no change here (§13).
 */
export function EntityTypeIcon({ type, ...props }: { type: string } & SvgIconProps) {
  switch (type) {
    case 'Person':
      return <PersonOutlinedIcon {...props} />;
    case 'Organization':
      return <BusinessOutlinedIcon {...props} />;
    case 'Project':
      return <FolderOutlinedIcon {...props} />;
    case 'Meeting':
      return <EventOutlinedIcon {...props} />;
    default:
      return <HubOutlinedIcon {...props} />;
  }
}
