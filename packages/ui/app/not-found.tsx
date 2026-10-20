
import { useTranslations as useLegacyTranslations } from "next-intl";
import Link from "next/link";

export default function NotFound() {
  const uiText = useLegacyTranslations("uiCopy");
  return (
    <div
      className="min-h-screen flex items-center justify-center px-6"
      style={{ background: "var(--color-background)" }}
    >
      <div className="text-center max-w-md">
        <h1
          className="font-headline font-black mb-6"
          style={{
            fontSize: "clamp(5rem, 15vw, 8rem)",
            lineHeight: 1,
            background: "linear-gradient(135deg, #00d1ff 0%, #6d11ad 100%)",
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
          }}
        >
          404
        </h1>

        <h2 className="font-headline font-bold text-xl mb-2" style={{ color: "var(--color-on-surface)" }}>{uiText("mb10483661821")}</h2>
        <p className="text-sm mb-8" style={{ color: "var(--color-on-surface-variant)" }}>{uiText("m30a00b02a74d")}</p>

        <div className="flex items-center justify-center gap-3">
          <Link
            href="/"
            className="inline-flex items-center gap-2 px-6 py-2.5 rounded-xl text-sm font-semibold text-white"
            style={{ background: "linear-gradient(135deg, #00d1ff, #6d11ad)" }}
          >{uiText("md182a885158e")}</Link>
          <Link
            href="/dashboard"
            className="inline-flex items-center gap-2 px-6 py-2.5 rounded-xl text-sm font-medium"
            style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "var(--color-on-surface-variant)" }}
          >{uiText("m2aec28552db3")}</Link>
        </div>
      </div>
    </div>
  );
}
