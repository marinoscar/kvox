import { useId, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { Alert, Box, Button, LinearProgress, Typography } from '@mui/material';
import { CloudUpload as UploadIcon } from '@mui/icons-material';
import { ApiError, uploadProfileImage } from '../../services/api';
import type { ProfileImageMutationResponse } from '../../types';

/** Mirrors the API's limit; the server re-checks the actual bytes (#367). */
export const PROFILE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
/** Mirrors the API's allowed formats; the server validates by magic bytes. */
export const PROFILE_IMAGE_TYPES: readonly string[] = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
];

interface ImageUploadProps {
  /**
   * Called with the upload response once the server has stored the picture.
   * The response carries the new settings document (and `version`), which the
   * caller must adopt. `file` is the picked file, so the caller can preview it
   * locally before any authenticated re-fetch completes.
   */
  onUploaded: (result: ProfileImageMutationResponse, file: File) => void | Promise<void>;
  /** Lets the parent block conflicting actions while bytes are in flight. */
  onUploadingChange?: (uploading: boolean) => void;
  disabled?: boolean;
  /** Button text, e.g. "Replace picture" when one already exists. */
  label?: string;
}

function describeUploadError(err: unknown): string {
  if (err instanceof ApiError) {
    // `ApiService` falls back to this literal when the body carried no message
    // (e.g. a proxy's HTML 413 page), so only a real server message wins.
    if (err.message && err.message !== 'Request failed') {
      return err.message;
    }
    if (err.status === 413) {
      return 'The image must be 5 MB or smaller.';
    }
    if (err.status === 400) {
      return 'That file is not a supported image (JPEG, PNG, GIF or WebP).';
    }
  }
  return 'Failed to upload the picture. Please try again.';
}

export function ImageUpload({
  onUploaded,
  onUploadingChange,
  disabled = false,
  label = 'Upload picture',
}: ImageUploadProps) {
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const hintId = useId();

  const setUploading = (uploading: boolean) => {
    setIsUploading(uploading);
    onUploadingChange?.(uploading);
  };

  const handleFileSelect = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Reset so choosing the same file again still fires `change`.
    event.target.value = '';
    if (!file) return;

    // Client-side pre-checks only save a round trip; the API is authoritative.
    if (!PROFILE_IMAGE_TYPES.includes(file.type)) {
      setError('Please choose a JPEG, PNG, GIF or WebP image.');
      return;
    }
    if (file.size > PROFILE_IMAGE_MAX_BYTES) {
      setError('The image must be 5 MB or smaller.');
      return;
    }

    setError(null);
    setUploading(true);

    let result: ProfileImageMutationResponse;
    try {
      result = await uploadProfileImage(file);
    } catch (err) {
      setError(describeUploadError(err));
      setUploading(false);
      return;
    }

    setUploading(false);
    await onUploaded(result, file);
  };

  const isDisabled = disabled || isUploading;

  return (
    <Box>
      <input
        ref={fileInputRef}
        type="file"
        accept={PROFILE_IMAGE_TYPES.join(',')}
        onChange={handleFileSelect}
        style={{ display: 'none' }}
        disabled={isDisabled}
        data-testid="profile-image-file-input"
      />
      <Button
        variant="outlined"
        size="small"
        startIcon={<UploadIcon />}
        onClick={() => fileInputRef.current?.click()}
        disabled={isDisabled}
        aria-describedby={hintId}
      >
        {isUploading ? 'Uploading...' : label}
      </Button>
      <Typography
        id={hintId}
        variant="caption"
        color="text.secondary"
        sx={{ display: 'block', mt: 0.5 }}
      >
        JPEG, PNG, GIF or WebP, up to 5 MB.
      </Typography>
      {isUploading && (
        <LinearProgress
          aria-label="Uploading picture"
          sx={{ mt: 1, maxWidth: 240 }}
        />
      )}
      {error && (
        <Alert severity="error" sx={{ mt: 1 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
    </Box>
  );
}
