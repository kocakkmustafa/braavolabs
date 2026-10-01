/**
 * What a portability export may and may not contain (BR-P1-005 #4).
 *
 * The GDPR page tells the data subject they may "port your data", and until
 * now the only way to exercise it was to email a mailbox. This is the
 * machine-readable half.
 *
 * THE DEFAULT MATTERS MORE HERE THAN IN THE AUDIT EXPORT. There, forgetting a
 * column meant showing too little. Here it means showing too MUCH: `User`
 * carries `passwordHash`, `emailVerifyTokenHash` and `resetTokenHash`, and a
 * portability file is something the subject downloads, keeps and forwards.
 * So the projection is an allowlist, every column must be accounted for, and
 * a test rejects any exported field whose NAME is credential-shaped — belt as
 * well as braces, because the dangerous mistake is silent.
 */

/** Columns the subject receives. */
export const USER_EXPORT_FIELDS = [
  "id",
  "email",
  "name",
  "avatarUrl",
  "role",
  "emailVerifiedAt",
  "aiConsentAt",
  "createdAt",
  "updatedAt",
] as const;

/**
 * Columns deliberately withheld, each with the reason.
 *
 * An omission with no reason is indistinguishable from an oversight, so the
 * gate rejects an empty one.
 */
export const USER_EXPORT_OMITTED: Record<string, string> = {
  passwordHash: "credential material — porting it would hand the subject (and anyone they forward the file to) an offline cracking target",
  emailVerifyTokenHash: "credential material for a live verification flow",
  emailVerifyTokenExpiresAt: "only meaningful alongside the verification token, which is withheld",
  resetTokenHash: "credential material for a live password-reset flow",
  resetTokenExpiresAt: "only meaningful alongside the reset token, which is withheld",
  tenantId: "an internal identifier for the workspace, not personal data about the subject",
  googleId: "the identifier a third-party IdP assigns us; it is not portable to anywhere else and discloses that vendor's internal key",
  githubId: "same as googleId — a vendor-internal identifier, not portable data",
  appleId: "same as googleId — a vendor-internal identifier, not portable data",
  oidcSubject: "the subject claim from the customer's own IdP; theirs to export, not ours to republish",
};

/** Device columns. `pushToken` is a live credential for sending to the device. */
export const DEVICE_EXPORT_FIELDS = ["id", "platform", "deviceName", "osVersion", "lastSeenAt", "createdAt"] as const;

/**
 * Notification-preference columns.
 *
 * It was the one exported object assembled by hand, with no constant and no
 * gate — the exact surface `User` and `Device` were given one for. Nothing in
 * it is sensitive today; the point is that a column added later must not
 * decide its own fate.
 */
export const NOTIFICATION_PREF_EXPORT_FIELDS = ["approvals", "risks", "runs", "drafts"] as const;

/** How many of the subject's own activity rows travel with the export. */
export const ACTIVITY_EXPORT_LIMIT = 5_000;
