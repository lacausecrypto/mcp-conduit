const PROFILE_TARGET_PREFIX = '__conduit_profile__:';

export function buildProfileTargetId(profileId: string): string {
  return `${PROFILE_TARGET_PREFIX}${profileId}`;
}

export function isProfileTargetId(value: string): boolean {
  return value.startsWith(PROFILE_TARGET_PREFIX);
}

export function extractProfileIdFromTarget(value: string): string | null {
  if (!isProfileTargetId(value)) {
    return null;
  }

  return value.slice(PROFILE_TARGET_PREFIX.length);
}
