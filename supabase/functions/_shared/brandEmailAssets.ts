/** Public Storage URLs for UniCopier brand images in emails. */

export const EMAIL_ASSETS_BUCKET = "email-assets";

export type EmailLogoVariant = "light" | "dark" | "mark";

const LOGO_FILES: Record<EmailLogoVariant, string> = {
  light: "unicopier_dark.png",
  dark: "unicopier_light.png",
  mark: "unicopier_dark.png",
};

export function emailAssetsPublicBase(supabaseUrl: string): string {
  return `${String(supabaseUrl).replace(/\/$/, "")}/storage/v1/object/public/${EMAIL_ASSETS_BUCKET}`;
}

export function emailBrandLogoUrl(
  supabaseUrl: string,
  variant: EmailLogoVariant = "light",
): string {
  return `${emailAssetsPublicBase(supabaseUrl)}/${LOGO_FILES[variant]}`;
}

/** Prefer an explicit override, then the app-hosted UniCopier wordmark. */
export function resolveEmailLogoUrl(args: {
  supabaseUrl: string;
  appUrl?: string | null;
  variant?: EmailLogoVariant;
  explicitUrl?: string | null;
}): string {
  const explicit = String(args.explicitUrl ?? "").trim();
  if (explicit) return explicit;

  const file = LOGO_FILES[args.variant ?? "light"];
  const appUrl = String(args.appUrl ?? "https://app.tscopier.ai").trim().replace(/\/$/, "")
    || "https://app.tscopier.ai";
  return `${appUrl}/${file}`;
}
