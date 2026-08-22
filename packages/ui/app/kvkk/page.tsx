"use client";

import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";

const SECTIONS = [
  {
    id: "veri-sorumlusu",
    title: "Veri Sorumlusu",
    body: 'Braavolabs ("Şirket"), 6698 sayılı Kişisel Verilerin Korunması Kanunu ("KVKK") kapsamında veri sorumlusu sıfatıyla hareket eder. İletişim: kvkk@braavolabs.com.',
  },
  {
    id: "islenen-kisisel-veriler",
    title: "İşlenen Kişisel Veriler",
    body: "Kimlik (ad, soyad), iletişim (e-posta, organizasyon adı), müşteri işlem (abonelik durumu, fatura geçmişi), müşteri davranış (pipeline çalıştırma kayıtları, kullanım metrikleri), log (IP, oturum kimliği, denetim izleri). Ödeme bilgileri Stripe üzerinden işlenir; kart numaranızı tarafımızda saklamayız.",
  },
  {
    id: "isleme-amaclari",
    title: "İşleme Amaçları",
    body: "Sözleşmesel yükümlülüklerin yerine getirilmesi (hizmet sunumu, fatura), müşteri desteği, ürün iyileştirme, güvenlik ve dolandırıcılık önleme, yasal yükümlülükler (TTK, vergi mevzuatı) ve onayınız varsa pazarlama iletişimi.",
  },
  {
    id: "hukuki-sebepler",
    title: "Hukuki Sebepler",
    body: "KVKK madde 5/2-c (sözleşmenin kurulması/ifası), 5/2-ç (hukuki yükümlülük), 5/2-f (meşru menfaat) ve pazarlama iletişimi için 5/1 kapsamında açık rıza.",
  },
  {
    id: "ucuncu-taraf-aktarimlari",
    title: "Üçüncü Taraf Aktarımları",
    body: "Hizmet sağlayıcılarımız: Stripe (ödeme, ABD), SendGrid (e-posta, ABD), HubSpot (CRM, ABD — opsiyonel), Google OAuth (kimlik doğrulama, ABD — opsiyonel), GitHub OAuth (kimlik doğrulama, ABD — opsiyonel), AWS Lightsail (barındırma, AB Frankfurt). Yurt dışı aktarımlar KVKK madde 9 kapsamında standart sözleşme hükümleri ile yapılır.",
  },
  {
    id: "saklama-suresi",
    title: "Saklama Süresi",
    body: "Hesabınız aktif olduğu sürece verileriniz işlenir. Hesap kapatıldıktan sonra TTK gereği 10 yıl boyunca finansal kayıtlar saklanır. Pazarlama amaçlı veriler rıza geri çekilince derhal silinir.",
  },
  {
    id: "haklariniz",
    title: "Haklarınız (KVKK Madde 11)",
    body: "Kişisel verilerinizin işlenip işlenmediğini öğrenme; işlenmişse bilgi talep etme; işlenme amacını ve amacına uygun kullanılıp kullanılmadığını öğrenme; yurt içinde/yurt dışında aktarıldığı tarafları bilme; eksik/yanlış işlenmişse düzeltilmesini isteme; silinmesini/yok edilmesini isteme; düzeltme/silme/yok etme işlemlerinin aktarılan taraflara bildirilmesini isteme; otomatik sistemlerle analiz edilerek aleyhinize sonuç çıkmasına itiraz etme; hukuka aykırı işleme nedeniyle zarara uğradıysanız tazminat talep etme haklarına sahipsiniz.",
  },
  {
    id: "basvuru",
    title: "Başvuru",
    body: "Haklarınızı kullanmak için kvkk@braavolabs.com adresine yazılı başvuruda bulunabilirsiniz. Başvurunuza KVKK madde 13 uyarınca en geç 30 gün içinde ücretsiz olarak yanıt veririz.",
  },
];

const DOC_LINKS = [
  { href: "/privacy", label: "Privacy" },
  { href: "/terms", label: "Terms" },
  { href: "/cookies", label: "Cookies" },
  { href: "/gdpr", label: "GDPR" },
  { href: "/kvkk", label: "KVKK", active: true },
  { href: "/account-deletion", label: "Account Deletion" },
];

export default function KvkkPage() {
  // Page body stays Turkish (legal requirement under 6698 sayılı Kanun);
  // only the chrome (back link) and a conditional explainer banner
  // localise. Visitors who arrived in TR see the body without scaffolding,
  // visitors in any other locale see a one-line note in their language.
  const t = useTranslations();
  const locale = useLocale();
  const showBanner = locale !== "tr";

  return (
    <div className="min-h-screen bg-background mesh-bg">
      {/* ── Nav ─────────────────────────────────────────────── */}
      <nav className="sticky top-0 z-40 glass-panel">
        <div className="max-w-[1100px] mx-auto flex items-center justify-between px-6 md:px-10 h-14">
          <Link href="/" className="flex items-center gap-2.5">
            <div className="bv-avatar" style={{ width: 32, height: 32, fontSize: 12 }}>
              B
            </div>
            <span className="font-headline font-bold text-sm text-on-surface">Braavolabs</span>
          </Link>
          <div className="hidden md:flex items-center gap-6 text-sm text-on-surface-variant">
            <Link href="/#features" className="hover:text-on-surface transition-colors">Features</Link>
            <Link href="/pricing" className="hover:text-on-surface transition-colors">Pricing</Link>
            <Link href="/about" className="hover:text-on-surface transition-colors">About</Link>
          </div>
          <div className="flex items-center gap-2">
            <Link href="https://app.braavolabs.com/login" className="bv-btn bv-btn-ghost bv-btn-sm">Sign in</Link>
            <Link href="https://app.braavolabs.com/register" className="bv-btn bv-btn-primary bv-btn-sm">Choose a plan</Link>
          </div>
        </div>
      </nav>

      {/* ── Page head ───────────────────────────────────────── */}
      <header className="relative pt-14 pb-2 text-center overflow-hidden">
        {/* Watermark logo */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute left-1/2 top-0 -translate-x-1/2 w-64 aspect-square opacity-[0.03]"
          style={{
            background: "radial-gradient(circle, var(--bv-cobalt-glow) 60%, transparent 74%)",
          }}
        />
        <div className="relative max-w-[1100px] mx-auto px-6">
          {/* Eyebrow */}
          <div className="flex items-center justify-center gap-2 mb-4">
            <span className="bv-micro">Legal</span>
          </div>
          <h1 className="bv-display text-on-surface" style={{ fontSize: "clamp(2rem, 5vw, 3.75rem)", textTransform: "uppercase", letterSpacing: "-0.02em" }}>
            KVKK
          </h1>
          <p className="bv-mono text-on-surface-variant mt-3">Son güncelleme: Mayıs 2026</p>

          {/* Doc switcher pills */}
          <div className="flex flex-wrap items-center justify-center gap-2 mt-6">
            {DOC_LINKS.map((d) => (
              <Link
                key={d.href}
                href={d.href}
                className={`bv-fpill${d.active ? " active" : ""}`}
              >
                {d.label}
              </Link>
            ))}
          </div>
        </div>
      </header>

      {/* ── Article grid: TOC + prose ───────────────────────── */}
      <div className="max-w-[1040px] mx-auto px-6 md:px-8 mt-10 pb-28 grid grid-cols-1 md:grid-cols-[220px_1fr] gap-12">
        {/* TOC — hidden on mobile */}
        <aside className="hidden md:block">
          <nav className="sticky top-20 space-y-0.5">
            <p className="bv-micro mb-3">On this page</p>
            {SECTIONS.map((s) => (
              <a
                key={s.id}
                href={`#${s.id}`}
                className="block text-sm text-on-surface-variant hover:text-on-surface transition-colors py-1.5 pl-3 border-l border-outline-variant hover:border-primary"
                style={{ lineHeight: 1.3 }}
              >
                {s.title}
              </a>
            ))}
          </nav>
        </aside>

        {/* Prose */}
        <article className="max-w-[72ch] bv-stagger">
          {/* Localisation banner */}
          {showBanner && (
            <div className="bv-glass mb-8 px-4 py-3 text-xs text-on-surface-variant rounded-xl">
              <span className="material-symbols-outlined text-primary mr-2" style={{ fontSize: 16, verticalAlign: "middle" }}>
                language
              </span>
              {t("static.singleLocale.kvkkBanner")}
            </div>
          )}

          <div className="bv-divider mb-8" />

          {SECTIONS.map((section) => (
            <section key={section.id} className="mb-9">
              <h2
                id={section.id}
                className="flex items-center gap-2 bv-headline text-on-surface mb-3"
                style={{
                  fontSize: "1.25rem",
                  textTransform: "uppercase",
                  letterSpacing: "-0.01em",
                  scrollMarginTop: "5.5rem",
                }}
              >
                {section.title}
                <a
                  href={`#${section.id}`}
                  className="opacity-0 hover:opacity-100 focus:opacity-100 transition-opacity text-primary text-sm font-normal"
                  aria-label={`Link to ${section.title}`}
                >
                  ¶
                </a>
              </h2>
              <p className="text-on-surface-variant leading-relaxed" style={{ fontSize: "0.97rem", lineHeight: 1.8 }}>
                {section.body}
              </p>
              <div className="bv-divider mt-8" />
            </section>
          ))}

          {/* Contact CTA */}
          <div className="bv-glass p-6 rounded-2xl mt-4">
            <div className="flex items-start gap-4">
              <span className="material-symbols-outlined text-primary mt-0.5" style={{ fontSize: 22 }}>
                mail
              </span>
              <div>
                <p className="bv-title mb-1">Başvuru için iletişim</p>
                <p className="bv-caption">
                  KVKK kapsamındaki talepleriniz için{" "}
                  <a
                    href="mailto:kvkk@braavolabs.com"
                    className="text-primary hover:underline transition-colors"
                  >
                    kvkk@braavolabs.com
                  </a>{" "}
                  adresine yazabilirsiniz.
                </p>
              </div>
            </div>
          </div>
        </article>
      </div>

      {/* ── Footer ──────────────────────────────────────────── */}
      <footer className="bv-divider" />
      <div className="max-w-[1100px] mx-auto px-6 md:px-10 py-10 grid grid-cols-2 md:grid-cols-4 gap-8">
        <div className="col-span-2 md:col-span-1">
          <Link href="/" className="flex items-center gap-2.5 mb-3">
            <div className="bv-avatar" style={{ width: 28, height: 28, fontSize: 11 }}>B</div>
            <span className="font-headline font-bold text-sm text-on-surface">Braavolabs</span>
          </Link>
          <p className="bv-caption">Command the AI agents &amp; automations you already run.</p>
        </div>
        <div>
          <p className="bv-micro mb-3">Product</p>
          <div className="space-y-2 text-sm text-on-surface-variant">
            <Link href="/#features" className="block hover:text-on-surface transition-colors">Features</Link>
            <Link href="/pricing" className="block hover:text-on-surface transition-colors">Pricing</Link>
            <Link href="/changelog" className="block hover:text-on-surface transition-colors">Changelog</Link>
          </div>
        </div>
        <div>
          <p className="bv-micro mb-3">Company</p>
          <div className="space-y-2 text-sm text-on-surface-variant">
            <Link href="/about" className="block hover:text-on-surface transition-colors">About</Link>
            <Link href="/blog" className="block hover:text-on-surface transition-colors">Blog</Link>
            <Link href="/contact" className="block hover:text-on-surface transition-colors">Contact</Link>
          </div>
        </div>
        <div>
          <p className="bv-micro mb-3">Legal</p>
          <div className="space-y-2 text-sm text-on-surface-variant">
            <Link href="/privacy" className="block hover:text-on-surface transition-colors">Privacy</Link>
            <Link href="/terms" className="block hover:text-on-surface transition-colors">Terms</Link>
            <Link href="/kvkk" className="block text-primary">KVKK</Link>
            <Link href="/gdpr" className="block hover:text-on-surface transition-colors">GDPR</Link>
          </div>
        </div>
      </div>
    </div>
  );
}
